"""Crew assignment push — "a job just landed on your list."

Called from the canonical assignment write sites (scheduling's create_job /
update_job / auto-assign) AFTER the Job write commits, never from a background
tick (scheduling-invariants R1: event-driven, no polling). Delivery rides
services.push_service.notify_user, which is best-effort, opens its own
short-lived DB session, and is a silent no-op when VAPID keys aren't
configured — so a push hiccup can never fail or roll back the schedule write.

SECURITY: the payload carries only the day, time window, and property/job
name. Door codes, access notes, and addresses NEVER ride a push — lock-screen
notifications are world-readable and get mirrored to watches/other devices.
The cleaner opens My Day (the url target) for the real details.
"""
from __future__ import annotations

import logging

from sqlalchemy import or_
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _fmt_time_12h(t) -> str:
    if not t:
        return ""
    h12 = t.hour % 12 or 12
    ampm = "AM" if t.hour < 12 else "PM"
    return f"{h12}:{t.minute:02d} {ampm}" if t.minute else f"{h12} {ampm}"


def _job_line(job) -> str:
    """"Tue, Aug 18 · 9 AM–12 PM · Maple Cottage" — no access details, ever."""
    parts = []
    if getattr(job, "scheduled_date", None):
        parts.append(job.scheduled_date.strftime("%a, %b %-d")
                     if hasattr(job.scheduled_date, "strftime") else str(job.scheduled_date))
    start = _fmt_time_12h(getattr(job, "start_time", None))
    end = _fmt_time_12h(getattr(job, "end_time", None))
    if start:
        parts.append(f"{start}–{end}" if end else start)
    prop = getattr(job, "property", None)
    where = (getattr(prop, "name", None) if prop is not None else None) or job.title or "New job"
    parts.append(where)
    return " · ".join(p for p in parts if p)


def notify_job_assigned(db: Session, job, cleaner_ids) -> int:
    """Push "New job for you" to each cleaner in `cleaner_ids` who has a linked
    login. Callers pass only the NEWLY-assigned IDs (create: all; update: the
    added set) so an unrelated edit never re-pings the whole crew. Best-effort:
    returns the number of successful sends, swallows everything."""
    ids = [str(c) for c in (cleaner_ids or []) if str(c).strip()]
    if not ids:
        return 0
    try:
        from database.models import User
        from services.push_service import notify_user, push_enabled

        if not push_enabled():
            return 0
        oid = getattr(job, "org_id", None)
        q = db.query(User).filter(User.cleaner_id.in_(ids), User.role == "cleaner")
        if oid is not None:
            # Same tenant guard as payroll's user map: cleaner_id isn't unique
            # across orgs, so never resolve another org's same-ID login.
            q = q.filter(or_(User.org_id == oid, User.org_id.is_(None)))
        sent = 0
        for u in q.all():
            sent += notify_user(
                u.id,
                "New job for you",
                _job_line(job),
                url="/my-day",
                tag=f"job-assign-{job.id}",
                category="job_assignments",
            )
        return sent
    except Exception:  # pragma: no cover - defensive: push must never break scheduling
        logger.exception("crew assignment push failed (job %s)", getattr(job, "id", "?"))
        return 0
