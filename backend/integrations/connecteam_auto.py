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
    delete_shift_sync,
    is_configured,
)
from utils.integration_log import log_integration_event as _log

logger = logging.getLogger(__name__)


def _shift_times(job):
    """Connecteam wants ISO 8601 datetimes; the job stores date + HH:MM."""
    return (f"{job.scheduled_date}T{job.start_time}:00",
            f"{job.scheduled_date}T{job.end_time}:00")


def auto_dispatch_job(db, job, *, commit: bool = True) -> dict:
    """Create one Connecteam shift per assigned cleaner for ``job``.

    Returns a status dict for the API response. No-ops (with a reason) when
    Connecteam isn't configured, the job has no cleaners, the job isn't active,
    or it's already dispatched — so it's safe to call unconditionally.
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
    if not job.cleaner_ids:
        status["reason"] = "no_cleaners"
        return status
    if job.connecteam_shift_ids:
        status["reason"] = "already_dispatched"
        return status

    start_dt, end_dt = _shift_times(job)
    shift_ids, errors = [], []
    for emp in job.cleaner_ids:
        try:
            res = create_shift_sync(
                employee_id=str(emp),
                start_datetime=start_dt,
                end_datetime=end_dt,
                title=job.title,
                address=job.address,
                notes=job.notes,
            )
            sid = res.get("id") or res.get("shiftId") or ""
            if sid:
                shift_ids.append(str(sid))
                _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                     action="create", status="ok", external_id=str(sid), commit=False)
            else:
                errors.append({"employee_id": str(emp), "error": "no shift id returned"})
                _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                     action="create", status="failed",
                     detail="create_shift returned no id", commit=False)
        except (ConnecteamAuthError, Exception) as e:  # noqa: B014 - log both the same way
            errors.append({"employee_id": str(emp), "error": str(e)})
            _log(db, entity_type="job", entity_id=job.id, provider="connecteam",
                 action="create", status="failed", detail=str(e), commit=False)

    if shift_ids:
        job.dispatched = True
        job.connecteam_shift_ids = shift_ids

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
