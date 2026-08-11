"""
Crew module (Phase 1 — native crew directory + "My Day" view).

Additive, read-only for now: a cleaner logs in with their own BrightBase
account and sees exactly the jobs already assigned to their crew ID in
Job.cleaner_ids — nothing about dispatch, Connecteam, or payroll changes.
The account/crew-ID link itself is managed from the existing admin Users
screen (auth/router.py's AdminUserUpdate.cleaner_id), not here.

This does not make BrightBase or Connecteam any less/more authoritative:
Connecteam is a read-only projection of canonical Job state (see the
scheduling-invariants contract), and so is this view. The crew just reads the
source of truth directly instead of the mirror.

Jobs are fetched for a bounded window and filtered in Python rather than
with a DB-specific JSON-containment query, matching the pattern the rest of
scheduling/dashboard already uses (board_service.py, useDashboardData) — it
keeps the query portable across SQLite (tests/local) and Postgres (prod)
and the window is small enough (one crew member, ~2 weeks) that this is
cheap.
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from database.db import get_db
from database.models import Job, User
from modules.auth.router import require_role, current_org_id, resolve_org_id
from utils.dates import business_today

router = APIRouter()


def _fmt_time(t) -> str:
    return t.strftime("%H:%M") if t else ""


def _turnover_line(job: Job) -> str:
    """Checkout→check-in window + door code for an STR turnover — same idea
    as board_service._turnover_context, kept independent rather than
    cross-importing a private helper from another module."""
    if (job.job_type or "").lower() != "str_turnover":
        return ""
    prop = job.property
    if not prop:
        return ""
    parts = []
    if prop.check_out_time or prop.check_in_time:
        parts.append(f"Guest out {prop.check_out_time or '?'} → in {prop.check_in_time or '?'}")
    if prop.house_code:
        parts.append(f"Code {prop.house_code}")
    return " · ".join(parts)


def _job_row(job: Job) -> dict:
    prop = job.property
    return {
        "id": job.id,
        "title": job.title,
        "job_type": job.job_type,
        "status": job.status,
        "scheduled_date": job.scheduled_date.isoformat() if job.scheduled_date else None,
        "start_time": _fmt_time(job.start_time),
        "end_time": _fmt_time(job.end_time),
        "property_name": prop.name if prop else None,
        "address": prop.address if prop else (job.address or None),
        # Crew-relevant property context only — no billing/client-financial
        # data belongs in this response.
        "access_notes": (prop.access_notes if prop else None) or None,
        "parking_notes": (prop.parking_notes if prop else None) or None,
        "house_code": (prop.house_code if prop else None) or None,
        "turnover_line": _turnover_line(job),
        "checklist_template": (prop.checklist_template if prop else None) or None,
        "crew_size": len(job.cleaner_ids or []),
    }


@router.get("/my-day")
def my_day(
    days: int = 7,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Today's jobs (plus the next `days`-1 as a preview) assigned to the
    caller's crew ID. Returns 400 with a clear message if the account has no
    cleaner_id linked yet, rather than silently returning an empty list —
    that distinction matters (mis-set account vs. genuinely no jobs)."""
    if not current_user.cleaner_id:
        raise HTTPException(
            status_code=400,
            detail="Your account isn't linked to a crew ID yet — ask an admin to set one "
                   "in Settings → Users.",
        )
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))
    today = business_today()
    window_end = today + timedelta(days=max(1, min(days, 14)) - 1)

    jobs = (
        db.query(Job)
        .options(joinedload(Job.property))
        .filter(
            org_scope(Job),
            Job.scheduled_date >= today,
            Job.scheduled_date <= window_end,
            Job.status.in_(("scheduled", "in_progress")),
        )
        .order_by(Job.scheduled_date, Job.start_time)
        .all()
    )
    mine = [j for j in jobs if current_user.cleaner_id in (j.cleaner_ids or [])]
    today_jobs = [j for j in mine if j.scheduled_date == today]
    upcoming_jobs = [j for j in mine if j.scheduled_date != today]

    return {
        "as_of": today.isoformat(),
        "crew_id": current_user.cleaner_id,
        "today": [_job_row(j) for j in today_jobs],
        "upcoming": [_job_row(j) for j in upcoming_jobs],
    }
