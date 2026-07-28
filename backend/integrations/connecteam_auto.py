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
    is_bad_request,
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


def _ct_job_id_for(db, job):
    """The Connecteam Job id to LINK this job's shift(s) to — matched by the
    property name, then the client name (the account runs one Connecteam Job per
    client/property). Returns None when nothing matches, in which case the shift
    falls back to a free-text address. Best-effort; never raises."""
    try:
        from integrations.connecteam import resolve_job_id
        from database.models import Property, Client
        candidates = []
        if getattr(job, "property_id", None):
            prop = db.query(Property).filter(Property.id == job.property_id).first()
            if prop and getattr(prop, "name", None):
                candidates.append(prop.name)
        if getattr(job, "client_id", None):
            client = db.query(Client).filter(Client.id == job.client_id).first()
            if client and getattr(client, "name", None):
                candidates.append(client.name)
        return resolve_job_id(candidates)
    except Exception as e:  # pragma: no cover - lookup must never break dispatch
        logger.warning("Connecteam job-id lookup failed for job %s: %s",
                       getattr(job, "id", "?"), e)
        return None


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
    # Serialize concurrent dispatchers before the idempotency guard. Inline
    # dispatch (on job create/edit and recurring generation) and the background
    # sync-reconcile tick can both reach a not-yet-dispatched job at the same
    # moment; without a lock each reads connecteam_shift_ids == empty and both
    # create a shift → a duplicate cleaner shift. A row lock makes the
    # read-check-write atomic: the second caller blocks until the first commits,
    # then sees the shift ids and no-ops. Postgres honors FOR UPDATE; SQLite (the
    # test backend) ignores it but runs single-threaded, so the guard alone is
    # already sufficient there.
    #
    # We refresh-under-lock to reload connecteam_shift_ids from the DB. The
    # session runs autoflush=False, so refresh() would DISCARD un-flushed edits
    # on the job — skip the lock when the job is dirty (rare; the concurrent
    # racers are always clean reads) and fall back to the plain guard. A
    # not-yet-persisted job or a backend without row locks likewise falls
    # through harmlessly.
    try:
        if job.id is not None and job not in db.dirty:
            db.refresh(job, with_for_update=True)
    except Exception:  # pragma: no cover - lock unavailable; guard still applies
        pass
    if job.connecteam_shift_ids:
        status["reason"] = "already_dispatched"
        status["count"] = len(job.connecteam_shift_ids or [])
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

    # Link the shift to the Connecteam Job for this customer/property (shows the
    # job, not a free-text address). Resolved once per dispatch.
    ct_job_id = _ct_job_id_for(db, job)

    def _push_linked(create_fn, label, err_id, **kwargs):
        """Create a shift LINKED to the Connecteam Job; if that fails (e.g. the
        matched job id is stale/invalid), retry once UNLINKED so the shift still
        lands rather than being dropped. Records the id, or an error carrying
        ``err_id`` (the caller's identity fields, e.g. {"employee_id": ...})."""
        try:
            res = create_fn(job_id=ct_job_id, **kwargs) if ct_job_id else create_fn(**kwargs)
            _record(res, label)
            return
        except (ConnecteamAuthError, Exception) as e:  # noqa: B014
            # Retry UNLINKED only when Connecteam definitively REJECTED the
            # request (400/404/422 — e.g. a bad jobId) and so created nothing.
            # On an ambiguous failure (timeout, connection error, 5xx) the linked
            # shift may actually have been created; a second create would
            # duplicate it, so we don't retry — the job stays un-recorded and the
            # next reconcile tick / read-back handles it safely.
            if ct_job_id and is_bad_request(e):
                try:
                    res = create_fn(**kwargs)  # unlinked free-text fallback
                    _record(res, label)
                    logger.warning(
                        "Connecteam rejected job-link for job %s (%s); pushed unlinked: %s",
                        job.id, label, e)
                    return
                except (ConnecteamAuthError, Exception) as e2:  # noqa: B014
                    e = e2
            errors.append({**err_id, "error": str(e)})
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="create", status="failed", detail=str(e), commit=False)

    is_turnover = (getattr(job, "job_type", None) == "str_turnover")
    if is_turnover or not job.cleaner_ids:
        # OPEN draft (linked to the Job, still unassigned): Airbnb turnover, or a
        # not-yet-assigned regular job. A person is assigned in Connecteam.
        _push_linked(
            create_open_shift_sync, "open", {"target": "open"},
            start_datetime=start_dt, end_datetime=end_dt,
            title=job.title, address=job.address, notes=job.notes,
            is_published=False,
        )
    else:
        # ASSIGNED draft: one shift per cleaner on a regular job.
        for emp in job.cleaner_ids:
            _push_linked(
                create_shift_sync, f"emp:{emp}", {"employee_id": str(emp)},
                employee_id=str(emp),
                start_datetime=start_dt, end_datetime=end_dt,
                title=job.title, address=job.address, notes=job.notes,
                is_published=False,
            )

    if shift_ids:
        job.dispatched = True
        job.connecteam_shift_ids = shift_ids
        # Snapshot what we just pushed so the reconcile sweep can later tell
        # "the job's schedule changed since this shift went out" (drift) —
        # there's no Connecteam read API to ask the shift itself.
        job.connecteam_synced_schedule = _job_schedule_snapshot(job)

    # Whether the shift ids we just recorded are durably persisted. A shift
    # created in Connecteam whose id fails to commit is the classic duplicate
    # trap: the remote shift exists but the DB doesn't know it, so the next sync
    # dispatches the job again. Surface commit failure (committed=False) so
    # callers can stop and retry instead of treating the push as done.
    committed = True
    if commit:
        try:
            db.commit()
            db.refresh(job)
        except Exception as e:
            logger.warning("Connecteam dispatch commit failed for job %s: %s", job.id, e)
            try:
                db.rollback()
            except Exception:  # pragma: no cover - rollback best-effort
                pass
            committed = False
            errors.append({"target": "commit", "error": str(e)})

    status.update(
        dispatched=bool(shift_ids),
        count=len(shift_ids),
        errors=errors,
        committed=committed,
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


def read_back_reconcile(db, jobs, shifts, *, auto_dispatch_on=True, dry_run=False) -> dict:
    """Reconcile our record against Connecteam's ACTUAL shifts (audit follow-up).

    Drift detection only ever compares a job to our OWN snapshot, so it can't
    see a shift edited or deleted directly in the Connecteam app — the schedule
    then shows "In Connecteam" for a shift that's gone. This pass reads the real
    shifts (``shifts``, pre-fetched via get_scheduled_shifts_sync so this stays
    hermetically testable) and reconciles:

    - **Missing**: an active job's recorded shift id(s) are absent from
      Connecteam → the draft was deleted out-of-band. Our record is lying, so
      clear it; and in auto-dispatch mode re-create a fresh draft (in manual
      mode leave it for the office, who may have deleted it deliberately).
    - **Partial**: a multi-shift job lost SOME but not all of its shifts —
      ambiguous, so flag for review rather than mangling the survivors.
    - **Unrecognized**: a Connecteam shift whose id we don't track. Could be a
      manually-created shift or an orphan we lost track of — always REPORTED,
      never auto-deleted (we can't safely tell them apart; our shifts carry no
      job-id tag). Note: shifts aren't org-partitioned in Connecteam's single
      account, so when ``jobs`` is org-scoped this list also includes other
      tenants' shifts — callers should label it accordingly.

    ``dry_run`` computes the diff and mutates nothing, for a preview.
    """
    actual_ids = {str(s.get("id")) for s in shifts if s.get("id")}
    # Snapshot the ids we track BEFORE any mutation, for the unrecognized report.
    tracked_ids = {str(sid) for j in jobs for sid in (j.connecteam_shift_ids or [])}

    missing, partial, errors = [], [], []
    repaired = 0
    for job in jobs:
        ids = [str(sid) for sid in (job.connecteam_shift_ids or [])]
        if not ids:
            continue
        gone = [sid for sid in ids if sid not in actual_ids]
        if not gone:
            continue
        if job.status in ("cancelled", "completed"):
            # A terminal job's shift is already gone from Connecteam — just drop
            # our stale record (drift reconcile pulls any that still exist).
            if not dry_run:
                job.connecteam_shift_ids = [sid for sid in ids if sid in actual_ids]
                job.dispatched = bool(job.connecteam_shift_ids)
            continue
        if len(gone) == len(ids):
            missing.append({"job_id": job.id, "title": job.title,
                            "date": str(job.scheduled_date) if job.scheduled_date else None,
                            "missing_shift_ids": gone})
            if dry_run:
                continue
            job.connecteam_shift_ids = []
            job.connecteam_synced_schedule = None
            job.dispatched = False
            if auto_dispatch_on:
                st = auto_dispatch_job(db, job, commit=False)
                errors.extend(st.get("errors") or [])
            repaired += 1
        else:
            partial.append({"job_id": job.id, "title": job.title,
                            "present_shift_ids": [s for s in ids if s in actual_ids],
                            "missing_shift_ids": gone})

    unrecognized = [
        {"id": str(s.get("id")), "title": s.get("title"),
         "start": s.get("startTimestamp"), "is_open": s.get("isOpenShift"),
         "is_published": s.get("isPublished")}
        for s in shifts if str(s.get("id")) not in tracked_ids
    ]

    if not dry_run:
        try:
            db.commit()
        except Exception as e:  # pragma: no cover
            logger.warning("Connecteam read-back commit failed: %s", e)
            db.rollback()

    return {
        "dry_run": dry_run,
        "actual_shifts": len(shifts),
        "missing": missing,           # jobs whose every recorded shift vanished
        "repaired": repaired,         # of those, how many were cleared/re-dispatched
        "partial": partial,           # some-but-not-all lost — flagged for review
        "unrecognized": unrecognized[:100],  # capped sample; report-only
        "unrecognized_count": len(unrecognized),
        "errors": errors,
    }
