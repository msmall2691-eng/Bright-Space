"""Centralized activity logging helper.

Wraps `Activity` row creation so every write site uses the same pattern
and the unified client timeline (`GET /api/activities?client_id=X`) sees
emails, calls, jobs, visits, calendar events, and SMS in one feed.

Convention:
  - `summary` is a one-line human-readable string ("Email from Sarah: 'Move-out clean'")
  - `extra_data` is a small JSON dict of structured fields the UI can render

Add new helpers here when wiring up a new event source so the call sites
stay short.
"""
from typing import Optional, Any
from sqlalchemy.orm import Session

from database.models import Activity, ActivityType


def log_activity(
    db: Session,
    activity_type: str,
    *,
    client_id: Optional[int] = None,
    opportunity_id: Optional[int] = None,
    job_id: Optional[int] = None,
    message_id: Optional[int] = None,
    actor: Optional[str] = None,
    summary: Optional[str] = None,
    extra_data: Optional[dict] = None,
    commit: bool = False,
) -> Optional[Activity]:
    """Add an Activity row. Returns the row (or None if no anchor was given).

    Anchor: at least one of client_id / opportunity_id / job_id should be set —
    otherwise the row is orphaned and the timeline has no place to render it.
    We don't raise (logging shouldn't break the parent operation), but we do
    skip the write when nothing's anchored.
    """
    if not (client_id or opportunity_id or job_id):
        return None
    a = Activity(
        client_id=client_id,
        opportunity_id=opportunity_id,
        job_id=job_id,
        message_id=message_id,
        actor=actor,
        activity_type=activity_type,
        summary=summary,
        extra_data=extra_data or {},
    )
    db.add(a)
    if commit:
        try:
            db.commit()
        except Exception:
            db.rollback()
    return a


# ── Convenience wrappers per event source ───────────────────────────────────
# These exist so call sites read like English: log_job_created(db, job)


def log_job_created(db: Session, job, actor: str = "system") -> Optional[Activity]:
    return log_activity(
        db,
        ActivityType.JOB_CREATED.value,
        client_id=job.client_id,
        job_id=job.id,
        actor=actor,
        summary=f"Job scheduled: {job.title}",
        extra_data={
            "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None,
            "job_type": job.job_type,
            "property_id": job.property_id,
        },
    )


def log_job_status_change(db: Session, job, prev_status: str, actor: str = "system") -> Optional[Activity]:
    """Map a job status change to the appropriate ActivityType."""
    status = (job.status or "").lower()
    type_map = {
        "completed":  ActivityType.JOB_COMPLETED.value,
        "cancelled":  ActivityType.JOB_CANCELLED.value,
        "in_progress": ActivityType.JOB_STARTED.value,
        "scheduled":  ActivityType.JOB_SCHEDULED.value,
    }
    activity_type = type_map.get(status)
    if not activity_type or status == (prev_status or "").lower():
        return None
    return log_activity(
        db,
        activity_type,
        client_id=job.client_id,
        job_id=job.id,
        actor=actor,
        summary=f"Job {status}: {job.title}",
        extra_data={"prev_status": prev_status, "new_status": status},
    )


def log_email(
    db: Session,
    direction: str,  # "received" | "sent"
    *,
    client_id: Optional[int],
    subject: Optional[str] = None,
    from_email: Optional[str] = None,
    to_email: Optional[str] = None,
    message_id: Optional[int] = None,
    extra: Optional[dict] = None,
) -> Optional[Activity]:
    if not client_id:
        return None
    activity_type = (
        ActivityType.EMAIL_RECEIVED.value if direction == "received"
        else ActivityType.EMAIL_SENT.value
    )
    parts: dict[str, Any] = {"subject": subject or "(no subject)"}
    if from_email:
        parts["from"] = from_email
    if to_email:
        parts["to"] = to_email
    if extra:
        parts.update(extra)
    return log_activity(
        db,
        activity_type,
        client_id=client_id,
        message_id=message_id,
        actor=from_email if direction == "received" else "system",
        summary=f"{'Email from' if direction == 'received' else 'Email sent to'} "
                f"{from_email or to_email or 'client'}: {subject or '(no subject)'}",
        extra_data=parts,
    )


def log_calendar_event(
    db: Session,
    action: str,  # "created" | "updated" | "cancelled"
    *,
    client_id: Optional[int],
    job_id: Optional[int] = None,
    title: Optional[str] = None,
    gcal_event_id: Optional[str] = None,
    scheduled_date: Optional[str] = None,
) -> Optional[Activity]:
    """Log a Google Calendar lifecycle event.

    These piggyback on JOB_* ActivityTypes since each GCal event is tied to
    a Job. The extra_data carries the GCal-specific bits the timeline UI
    can choose to render (event_id, action verb).
    """
    type_map = {
        "created":   ActivityType.JOB_SCHEDULED.value,
        "updated":   ActivityType.JOB_SCHEDULED.value,
        "cancelled": ActivityType.JOB_CANCELLED.value,
    }
    activity_type = type_map.get(action, ActivityType.JOB_SCHEDULED.value)
    return log_activity(
        db,
        activity_type,
        client_id=client_id,
        job_id=job_id,
        actor="gcal",
        summary=f"Calendar event {action}: {title or '(untitled)'}",
        extra_data={
            "source": "gcal",
            "action": action,
            "gcal_event_id": gcal_event_id,
            "scheduled_date": scheduled_date,
            "title": title,
        },
    )


def log_visit_skipped(db: Session, visit, reason: Optional[str] = None) -> Optional[Activity]:
    job = getattr(visit, "job", None)
    if not job:
        return None
    return log_activity(
        db,
        ActivityType.JOB_CANCELLED.value,
        client_id=job.client_id,
        job_id=job.id,
        actor="admin",
        summary=f"Visit skipped on {visit.scheduled_date}" + (f": {reason}" if reason else ""),
        extra_data={
            "visit_id": visit.id,
            "scheduled_date": str(visit.scheduled_date) if visit.scheduled_date else None,
            "reason": reason,
            "single_occurrence": True,
        },
    )
