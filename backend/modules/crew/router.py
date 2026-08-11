"""
Crew module — the native crew app.

Phase 1 (read-only): a cleaner logs in with their own BrightBase account and
sees exactly the jobs already assigned to their crew ID in Job.cleaner_ids
(GET /my-day). The account/crew-ID link is managed from the admin Users screen
(auth/router.py's AdminUserUpdate.cleaner_id), not here.

Phase 2a (this file adds): a native time clock — POST /clock-in, POST
/clock-out, and clock status folded into /my-day. Punches land in the
`time_entries` table, a NEW canonical domain (when a cleaner actually worked).
This is deliberately NOT wired into payroll: payroll still reads Connecteam
Time Clock punches. The point of Phase 2a is to prove a native clock works and
accumulate real hours to reconcile against Connecteam before any cutover.

None of this touches the schedule or Connecteam: writing a punch never changes
Job schedule state, so the scheduling-authority contract (BrightBase canonical,
Connecteam a read-only projection) is untouched.

Jobs are fetched for a bounded window and filtered in Python rather than with a
DB-specific JSON-containment query, matching the pattern the rest of
scheduling/dashboard already uses — portable across SQLite (tests/local) and
Postgres (prod), and the window is tiny (one crew member, ~2 weeks).
"""
from datetime import datetime, timedelta, timezone, time as dtime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from database.db import get_db
from database.models import Job, User, TimeEntry
from modules.auth.router import require_role, current_org_id, resolve_org_id
from utils.dates import business_today, business_tz

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


# ── Time clock (Phase 2a) ────────────────────────────────────────────────────

def _now_naive_utc() -> datetime:
    """Naive UTC 'now' — matches how clock times are stored, so clock arithmetic
    never mixes aware and naive datetimes."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _iso_utc(dt):
    """Serialize a stored (naive UTC) timestamp as an explicit-UTC ISO string so
    the browser parses it as UTC, not as local time."""
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _entry_hours(e: TimeEntry):
    """Worked hours for a punch: elapsed minus breaks, never negative. None while
    still on the clock (no clock-out yet)."""
    if not e.clock_out_at:
        return None
    secs = (e.clock_out_at - e.clock_in_at).total_seconds() - (e.break_minutes or 0) * 60
    return round(max(0.0, secs) / 3600, 2)


def _entry_row(e: TimeEntry) -> dict:
    return {
        "id": e.id,
        "job_id": e.job_id,
        "clock_in_at": _iso_utc(e.clock_in_at),
        "clock_out_at": _iso_utc(e.clock_out_at),
        "break_minutes": e.break_minutes or 0,
        "hours": _entry_hours(e),
        "open": e.clock_out_at is None,
    }


def _business_day_bounds_utc(day):
    """[start, end) of a business-local day, as naive UTC — so 'hours today'
    rolls over at local midnight, not UTC midnight."""
    tz = business_tz()
    start_local = datetime.combine(day, dtime(0, 0), tzinfo=tz)
    end_local = start_local + timedelta(days=1)
    to_naive_utc = lambda d: d.astimezone(timezone.utc).replace(tzinfo=None)
    return to_naive_utc(start_local), to_naive_utc(end_local)


def _require_crew_id(current_user: User):
    if not current_user.cleaner_id:
        raise HTTPException(
            status_code=400,
            detail="Your account isn't linked to a crew ID yet — ask an admin to set one "
                   "in Settings → Users.",
        )


class ClockInBody(BaseModel):
    # Optional link to the job being worked — the hook a future native payroll
    # will use to classify hours by job_type. Nothing reads it for pay in 2a.
    job_id: Optional[int] = None


class ClockOutBody(BaseModel):
    break_minutes: Optional[int] = None
    note: Optional[str] = None


@router.get("/my-day")
def my_day(
    days: int = 7,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Today's jobs (plus the next `days`-1 as a preview) assigned to the
    caller's crew ID, plus their native time-clock status. Returns 400 with a
    clear message if the account has no cleaner_id linked yet, rather than
    silently returning an empty list — that distinction matters (mis-set
    account vs. genuinely no jobs)."""
    _require_crew_id(current_user)
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

    # ── Native time clock status ─────────────────────────────────────────────
    # Read-only w.r.t. the schedule and entirely separate from payroll (which
    # still reads Connecteam). Folded into /my-day so the crew app is one call.
    day_start, day_end = _business_day_bounds_utc(today)
    entries_today = (
        db.query(TimeEntry)
        .filter(
            org_scope(TimeEntry),
            TimeEntry.cleaner_id == current_user.cleaner_id,
            TimeEntry.clock_in_at >= day_start,
            TimeEntry.clock_in_at < day_end,
        )
        .order_by(TimeEntry.clock_in_at)
        .all()
    )
    # The open punch is authoritative regardless of which day it started (an
    # overnight shift is still "on the clock").
    active = (
        db.query(TimeEntry)
        .filter(
            org_scope(TimeEntry),
            TimeEntry.cleaner_id == current_user.cleaner_id,
            TimeEntry.clock_out_at.is_(None),
        )
        .order_by(TimeEntry.clock_in_at.desc())
        .first()
    )
    hours_today = round(sum((_entry_hours(e) or 0.0) for e in entries_today), 2)

    return {
        "as_of": today.isoformat(),
        "crew_id": current_user.cleaner_id,
        "today": [_job_row(j) for j in today_jobs],
        "upcoming": [_job_row(j) for j in upcoming_jobs],
        "clock": {
            "active": _entry_row(active) if active else None,
            "hours_today": hours_today,
            "entries_today": [_entry_row(e) for e in entries_today],
        },
    }


@router.post("/clock-in")
def clock_in(
    body: ClockInBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Start a punch. One open punch per cleaner — a second clock-in while
    already on the clock is a 409 (clock out first). Phase 2a: recorded only,
    never read by payroll."""
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    existing = (
        db.query(TimeEntry)
        .filter(org_scope(TimeEntry),
                TimeEntry.cleaner_id == current_user.cleaner_id,
                TimeEntry.clock_out_at.is_(None))
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="You're already clocked in — clock out first.")

    job_id = body.job_id
    if job_id is not None:
        job = db.query(Job).filter(Job.id == job_id, org_scope(Job)).first()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")

    entry = TimeEntry(
        org_id=oid,
        cleaner_id=current_user.cleaner_id,
        user_id=current_user.id,
        job_id=job_id,
        clock_in_at=_now_naive_utc(),
        source="native",
    )
    db.add(entry); db.commit(); db.refresh(entry)
    return _entry_row(entry)


@router.post("/clock-out")
def clock_out(
    body: ClockOutBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Close the open punch. 400 if not currently clocked in. break_minutes is
    clamped to the elapsed time so a fat-fingered break can't make worked hours
    negative."""
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    entry = (
        db.query(TimeEntry)
        .filter(org_scope(TimeEntry),
                TimeEntry.cleaner_id == current_user.cleaner_id,
                TimeEntry.clock_out_at.is_(None))
        .order_by(TimeEntry.clock_in_at.desc())
        .first()
    )
    if not entry:
        raise HTTPException(status_code=400, detail="You're not clocked in.")

    now = _now_naive_utc()
    elapsed_min = (now - entry.clock_in_at).total_seconds() / 60
    bm = max(0, int(body.break_minutes or 0))
    if bm > elapsed_min:
        bm = int(elapsed_min)
    entry.clock_out_at = now
    entry.break_minutes = bm
    if body.note is not None:
        entry.note = body.note.strip() or None
    db.commit(); db.refresh(entry)
    return _entry_row(entry)
