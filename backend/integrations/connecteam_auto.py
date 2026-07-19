"""Auto-dispatch a job's cleaners to Connecteam as shifts.

Pillar 2: scheduling a job (or assigning cleaners to one) should push the work to
Connecteam automatically — the same way creating a job writes straight to Google
Calendar — instead of needing a manual "Dispatch" click. Rescheduling re-syncs
the shifts; cancelling/deleting pulls them. The Schedule page's "In Connecteam"
badges/stats and the unified timeline already read off connecteam_shift_ids and
provider="connecteam" integration events, so populating those here lights them up.

Every function is best-effort and must NEVER raise into the job lifecycle: a
Connecteam outage can't be allowed to block creating or editing a job.
"""
import logging

from integrations.connecteam import (
    ConnecteamAuthError,
    create_shift_sync,
    create_open_shift_sync,
    delete_shift_sync,
    is_configured,
)
from utils.integration_log import log_integration_event as _log

logger = logging.getLogger(__name__)


def _hhmmss(t) -> str:
    """Normalize a job time to HH:MM:SS. It can arrive as a plain "HH:MM"
    string (fresh off the API request) OR as a datetime.time (once the row has
    been read/refreshed from the SQLAlchemy Time column) — e.g. the recurring
    generator refreshes each job before dispatch, so it's a time object there.
    Blindly appending ":00" turned "09:00:00" (a time's str) into the invalid
    "09:00:00:00", which made _to_epoch_seconds raise and silently dropped the
    Connecteam shift for turnovers/unassigned/recurring jobs (Codex P2)."""
    if t is None:
        return "00:00:00"
    s = str(t)
    parts = s.split(":")
    if len(parts) == 2:      # "HH:MM"
        return f"{s}:00"
    if len(parts) >= 3:      # "HH:MM:SS" (time object str, or already full)
        return ":".join(parts[:3]).split(".")[0]  # drop any microseconds
    return "00:00:00"


def _shift_times(job):
    """Connecteam wants ISO 8601 datetimes; the job stores date + a time that
    may be a "HH:MM" string or a datetime.time — normalize either to HH:MM:SS."""
    return (f"{job.scheduled_date}T{_hhmmss(job.start_time)}",
            f"{job.scheduled_date}T{_hhmmss(job.end_time)}")


def _job_schedule_snapshot(job) -> dict:
    """The bits of a job's schedule that determine what time its Connecteam
    shift(s) represent — comparable snapshot for drift detection."""
    return {
        "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None,
        "start_time": str(job.start_time) if job.start_time else None,
        "end_time": str(job.end_time) if job.end_time else None,
    }


def auto_dispatch_job(db, job, *, commit: bool = True) -> dict:
    """Push ``job`` to Connecteam as DRAFT shift(s) the office reviews/publishes.

    Routing (product decision, July 2026):
      * STR/Airbnb turnover (job_type == "str_turnover"), OR a regular job with
        no cleaner assigned yet  → a single OPEN draft shift (unassigned, so it
        shows on the schedule for someone to claim/fill).
      * regular job with cleaner(s)  → one ASSIGNED draft shift per cleaner.
    Everything goes out unpublished (isPublished=false) so nothing hits a
    cleaner's live schedule until the office publishes it in Connecteam.

    Returns a status dict for the API response. No-ops (with a reason) when
    Connecteam isn't configured, the job isn't active, or it's already
    dispatched — so it's safe to call unconditionally.
    """
    status = {
        "dispatched": bool(job.connecteam_shift_ids),
        "reason": None,
        "count": len(job.connecteam_shift_ids or []),
        "errors": [],
    }
    if job.status in ("cancelled", "completed"):
        status["reason"] = "inactive_status"
        return status
    if not is_configured():
        status["reason"] = "not_configured"
        return status
    if job.connecteam_shift_ids:
        status["reason"] = "already_dispatched"
        return status
    # A job with no start/end time is non-dispatchable — don't fabricate a
    # midnight shift (which would put a cleaner on a 00:00 slot). These legacy
    # rows get repaired by diagnose_missing_times/backfill_missing_times, then
    # dispatch on the next pass. (Codex P1.)
    if not job.start_time or not job.end_time:
        status["reason"] = "missing_times"
        return status

    start_dt, end_dt = _shift_times(job)
    shift_ids, errors = [], []

    def _record(res, label):
        sid = res.get("id") or res.get("shiftId") or ""
        if sid:
            shift_ids.append(str(sid))
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="create", status="ok", external_id=str(sid), commit=False)
        else:
            errors.append({"target": label, "error": "no shift id returned"})
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="create", status="failed",
                 detail="create_shift returned no id", commit=False)

    is_turnover = (getattr(job, "job_type", None) == "str_turnover")
    if is_turnover or not job.cleaner_ids:
        # OPEN draft: Airbnb turnover, or a not-yet-assigned regular job.
        try:
            res = create_open_shift_sync(
                start_datetime=start_dt, end_datetime=end_dt,
                title=job.title, address=job.address, notes=job.notes,
                is_published=False,
            )
            _record(res, "open")
        except (ConnecteamAuthError, Exception) as e:  # noqa: B014
            errors.append({"target": "open", "error": str(e)})
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="create", status="failed", detail=str(e), commit=False)
    else:
        # ASSIGNED draft: one shift per cleaner on a regular job.
        for emp in job.cleaner_ids:
            try:
                res = create_shift_sync(
                    employee_id=str(emp),
                    start_datetime=start_dt,
                    end_datetime=end_dt,
                    title=job.title,
                    address=job.address,
                    notes=job.notes,
                    is_published=False,
                )
                _record(res, f"emp:{emp}")
            except (ConnecteamAuthError, Exception) as e:  # noqa: B014 - log both the same way
                errors.append({"employee_id": str(emp), "error": str(e)})
                _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                     action="create", status="failed", detail=str(e), commit=False)

    if shift_ids:
        job.dispatched = True
        job.connecteam_shift_ids = shift_ids
        # Snapshot what we just pushed so the reconcile sweep can later tell
        # "the job's schedule changed since this shift went out" (drift) —
        # there's no Connecteam read API to ask the shift itself.
        job.connecteam_synced_schedule = _job_schedule_snapshot(job)

    if commit:
        try:
            db.commit()
            db.refresh(job)
        except Exception as e:  # pragma: no cover - bookkeeping never breaks the caller
            logger.warning("Connecteam dispatch commit failed for job %s: %s", job.id, e)

    status.update(
        dispatched=bool(shift_ids),
        count=len(shift_ids),
        errors=errors,
        reason=("error" if (errors and not shift_ids) else None),
    )
    return status


def remove_job_from_connecteam(db, job, *, commit: bool = True) -> dict:
    """Delete all Connecteam shifts for ``job`` (cancel/delete/reschedule).

    Only the shifts that successfully delete are dropped from the job; any that
    fail are kept so the next attempt can retry instead of orphaning them.
    """
    status = {"removed": False, "reason": None, "errors": []}
    if not job.connecteam_shift_ids:
        status["removed"] = True
        return status
    if not is_configured():
        status["reason"] = "not_configured"
        return status

    remaining = []
    for sid in job.connecteam_shift_ids:
        try:
            delete_shift_sync(sid)
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="delete", status="ok", external_id=str(sid), commit=False)
        except Exception as e:
            remaining.append(sid)
            status["errors"].append({"shift_id": sid, "error": str(e)})
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="delete", status="failed", external_id=str(sid),
                 detail=str(e), commit=False)

    job.connecteam_shift_ids = remaining
    job.dispatched = bool(remaining)
    status["removed"] = (len(remaining) == 0)

    if commit:
        try:
            db.commit()
            db.refresh(job)
        except Exception as e:  # pragma: no cover
            logger.warning("Connecteam removal commit failed for job %s: %s", job.id, e)
    return status


def resync_job(db, job) -> dict:
    """Reschedule/reassign: pull the old shifts, then push fresh ones.

    If some deletes fail (shifts kept to retry), auto_dispatch_job sees a
    non-empty shift list and reports already_dispatched rather than creating
    duplicates — the next edit retries the cleanup.
    """
    remove_job_from_connecteam(db, job, commit=False)
    return auto_dispatch_job(db, job, commit=True)


def reconcile_connecteam_drift(db, jobs) -> dict:
    """Catch the two Connecteam-sync failure modes the create-only dispatch
    path never repairs (audit findings #2 + #4, July 2026):

    - **Orphaned-but-synced**: a job is cancelled/completed but still carries
      connecteam_shift_ids — some cancellation path missed cleanup (or a
      cleanup attempt failed earlier). Remove the stale shift(s).
    - **Time drift**: a job's schedule changed since its shift was pushed.
      This happens when a reschedule's delete-then-recreate (resync_job)
      partially failed: remove_job_from_connecteam left the OLD shift in
      place (some deletes are retried, not forced), and auto_dispatch_job
      then refuses to push a new one because connecteam_shift_ids is
      non-empty ("already_dispatched") — so the cleaner's shift silently
      stays at the old time. Detected by comparing the job's current
      schedule to the snapshot taken at the last successful push
      (connecteam_synced_schedule) — there's no Connecteam read API to ask
      the shift itself what time it's at.

    ``jobs`` is caller-supplied (not queried here) so the reconcile tick and
    the manual /sync-reconcile endpoint can each pick their own window
    without this function needing to know about business_today() or status
    filters — it only looks at jobs that already carry shift ids.
    """
    resynced, removed, errors = 0, 0, []
    for job in jobs:
        if not job.connecteam_shift_ids:
            continue
        if job.status in ("cancelled", "completed"):
            st = remove_job_from_connecteam(db, job, commit=False)
            if st.get("removed"):
                job.connecteam_synced_schedule = None
                removed += 1
            errors.extend(st.get("errors") or [])
            continue
        current = _job_schedule_snapshot(job)
        if job.connecteam_synced_schedule and job.connecteam_synced_schedule != current:
            st = resync_job(db, job)
            if st.get("dispatched"):
                resynced += 1
            errors.extend(st.get("errors") or [])
    try:
        db.commit()
    except Exception as e:  # pragma: no cover
        logger.warning("Connecteam drift-reconcile commit failed: %s", e)
        db.rollback()
    return {"resynced": resynced, "removed": removed, "errors": errors}
