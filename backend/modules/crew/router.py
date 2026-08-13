"""
Crew module — the native crew app.

Phase 1 (read-only): a cleaner logs in with their own BrightBase account and
sees exactly the jobs already assigned to their crew ID in Job.cleaner_ids
(GET /my-day). The account/crew-ID link is managed from the admin Users screen
(auth/router.py's AdminUserUpdate.cleaner_id), not here.

Phase 2a added a native time clock — POST /clock-in, POST /clock-out, and clock
status folded into /my-day. Punches land in the `time_entries` table, a
canonical domain (when a cleaner actually worked). Originally dark-launched to
reconcile against Connecteam; as of the Connecteam removal these punches ARE
payroll's default source (payroll_source='native'), and /my-week lets a cleaner
see their own earned + predicted pay for the week.

None of this touches the schedule: writing a punch never changes Job schedule
state, so the scheduling-authority contract (BrightBase canonical) is untouched.

Jobs are fetched for a bounded window and filtered in Python rather than with a
DB-specific JSON-containment query, matching the pattern the rest of
scheduling/dashboard already uses — portable across SQLite (tests/local) and
Postgres (prod), and the window is tiny (one crew member, ~2 weeks).
"""
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone, time as dtime
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from database.db import get_db
from database.models import Job, JobPhoto, User, TimeEntry
from modules.auth.router import require_role, current_org_id, resolve_org_id, send_staff_invite
from modules.scheduling.completion import auto_create_draft_invoice
from utils.activity_logger import log_job_status_change
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


def _job_row(job: Job, names_by_cid: dict | None = None, self_cid: str | None = None) -> dict:
    prop = job.property
    client = job.client
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
        # Who the customer is + how to reach them — the owner's explicit call
        # (crew handle "I'm outside" texts themselves). Name and phone only;
        # nothing billing-shaped.
        "client_name": client.name if client else None,
        "client_phone": (client.phone if client else None) or None,
        "crew_size": len(job.cleaner_ids or []),
        # The OTHER people on this job, as display names (crew-ID strings mean
        # nothing to a human). Resolved from the map my-day builds in one query.
        "teammates": sorted(
            (names_by_cid or {}).get(str(cid), str(cid))
            for cid in (job.cleaner_ids or [])
            if self_cid is None or str(cid) != str(self_cid)
        ) if names_by_cid is not None else [],
        # Mark-done state (Phase 2c): lets the card show "Done ✓" and echo the
        # note the cleaner left, instead of the job silently vanishing.
        "completed_at": _iso_utc(job.completed_at),
        "completion_note": job.completion_note,
    }


def _names_by_cleaner_id(db: Session, jobs) -> dict:
    """crew-ID → display name for every ID appearing on `jobs`, one query.
    Unclaimed IDs stay unmapped (the row falls back to the raw ID, which is
    still more useful than hiding a teammate)."""
    cids = {str(cid) for j in jobs for cid in (j.cleaner_ids or [])}
    if not cids:
        return {}
    rows = (db.query(User.cleaner_id, User.full_name, User.email)
            .filter(User.cleaner_id.in_(cids)).all())
    return {r[0]: (r[1] or r[2]) for r in rows}


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


def _sanitize_miles(v):
    """Clamp crew-entered miles into a sane, non-negative range so a fat-finger
    ('10000') can't reimburse thousands of dollars and a negative can't subtract
    from pay. None (not entered) passes through untouched. The generous 2000-mile
    ceiling clips only nonsense, never a real local drive — clock-out must never
    fail over a mileage typo, so this clamps rather than rejects."""
    if v is None:
        return None
    try:
        m = float(v)
    except (TypeError, ValueError):
        return None
    return round(min(2000.0, max(0.0, m)), 1)


def _entry_row(e: TimeEntry) -> dict:
    return {
        "id": e.id,
        "job_id": e.job_id,
        "clock_in_at": _iso_utc(e.clock_in_at),
        "clock_out_at": _iso_utc(e.clock_out_at),
        "break_minutes": e.break_minutes or 0,
        "miles": e.miles,
        "hours": _entry_hours(e),
        "open": e.clock_out_at is None,
        "clock_in_lat": e.clock_in_lat,
        "clock_in_lng": e.clock_in_lng,
        "has_location": e.clock_in_lat is not None and e.clock_in_lng is not None,
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
    # Browser geolocation captured at clock-in (Phase 2b), best-effort. Omitted
    # when the cleaner's device denies location — a punch is never blocked on it.
    lat: Optional[float] = None
    lng: Optional[float] = None
    accuracy_m: Optional[float] = None


class ClockOutBody(BaseModel):
    break_minutes: Optional[int] = None
    note: Optional[str] = None
    # Miles driven for this job, entered at clock-out.
    # Optional — blank/omitted means no driving to reimburse for this punch.
    miles: Optional[float] = None


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
        .options(joinedload(Job.property), joinedload(Job.client))
        .filter(
            org_scope(Job),
            Job.scheduled_date >= today,
            Job.scheduled_date <= window_end,
            # "completed" is included so a job the cleaner just marked done
            # stays on today's screen as "Done ✓" instead of vanishing the
            # moment they tap the button (which reads as a glitch, not success).
            Job.status.in_(("scheduled", "in_progress", "completed")),
        )
        .order_by(Job.scheduled_date, Job.start_time)
        .all()
    )
    mine = [j for j in jobs if current_user.cleaner_id in (j.cleaner_ids or [])]
    today_jobs = [j for j in mine if j.scheduled_date == today]
    # Completed jobs only show for *today* (the just-marked-done case); in the
    # upcoming preview they'd be noise.
    upcoming_jobs = [j for j in mine if j.scheduled_date != today and j.status != "completed"]
    names = _names_by_cleaner_id(db, mine)

    # ── Native time clock status ─────────────────────────────────────────────
    # Read-only w.r.t. the schedule. Folded into /my-day so the crew app is
    # one call; native payroll reads these same punches.
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
        "today": [_job_row(j, names, current_user.cleaner_id) for j in today_jobs],
        "upcoming": [_job_row(j, names, current_user.cleaner_id) for j in upcoming_jobs],
        "clock": {
            "active": _entry_row(active) if active else None,
            "hours_today": hours_today,
            "entries_today": [_entry_row(e) for e in entries_today],
        },
    }


@router.get("/my-week")
def my_week(
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """A cleaner's week of pay, so they can see what the week is shaping up to
    be worth: what they've EARNED so far (from their closed punches, computed by
    the exact same code the office's Payroll page runs — one pay-math
    implementation, no drift) plus a PREDICTION for the rest of the week from
    the jobs still assigned to them (scheduled length × their hourly rate + any
    per-job bump; piece-rate turnovers at the property's flat rate).

    Only ever returns the CALLER's own numbers — the full payroll breakdown
    stays admin/manager-only."""
    from modules.payroll.router import _get_rates, _native_summary

    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))
    today = business_today()
    week_start = today - timedelta(days=today.weekday())   # Monday
    week_end = week_start + timedelta(days=6)              # Sunday

    rates = _get_rates(db)

    # Earned so far: the payroll engine over this week's window, then pick out
    # ONLY the caller's row. The window is a week and the shop is small, so
    # computing everyone and filtering costs nothing measurable.
    summary = _native_summary(db, week_start.isoformat(), week_end.isoformat(), rates, oid)
    mine = next((e for e in summary["employees"] if e["employee_id"] == current_user.cleaner_id), None)
    earned = {
        "gross_pay": mine["gross_pay"] if mine else 0.0,
        "hours": mine["total_hours"] if mine else 0.0,
        "miles": mine["miles"] if mine else 0.0,
        "mileage_reimbursement": mine["mileage_reimbursement"] if mine else 0.0,
        "turnovers": mine["weekend_turnovers"] if mine else 0,
    }

    # Which jobs already have a CLOSED punch by this cleaner this week — those
    # are in "earned" and must not also be predicted. An OPEN punch keeps its
    # job in the prediction: mid-job, the estimate stands until clock-out.
    tz = business_tz()
    lo = datetime.combine(week_start, dtime(0, 0), tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
    hi = datetime.combine(week_end + timedelta(days=1), dtime(0, 0), tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
    punched_job_ids = {
        e.job_id for e in db.query(TimeEntry).filter(
            org_scope(TimeEntry),
            TimeEntry.cleaner_id == current_user.cleaner_id,
            TimeEntry.clock_out_at.isnot(None),
            TimeEntry.clock_in_at >= lo,
            TimeEntry.clock_in_at < hi,
        ).all() if e.job_id
    }

    jobs = (
        db.query(Job)
        .options(joinedload(Job.property))
        .filter(
            org_scope(Job),
            Job.scheduled_date >= today,
            Job.scheduled_date <= week_end,
            Job.status.in_(("scheduled", "in_progress")),
        )
        .order_by(Job.scheduled_date, Job.start_time)
        .all()
    )
    upcoming = []
    predicted_upcoming = 0.0
    for j in jobs:
        if current_user.cleaner_id not in (j.cleaner_ids or []):
            continue
        if j.id in punched_job_ids:
            continue
        prop = j.property
        weekend = j.scheduled_date.weekday() >= 5
        if j.job_type == "str_turnover":
            kind = "rental"
        elif j.job_type == "deep_clean":
            kind = "deep"
        else:
            kind = "residential"
        mode = (j.pay_mode or "auto").lower()
        use_piece = (kind == "rental" and weekend) if mode == "auto" else (mode == "piece")

        # Scheduled length in hours (start/end are NOT NULL on Job).
        dur = (datetime.combine(j.scheduled_date, j.end_time)
               - datetime.combine(j.scheduled_date, j.start_time)).total_seconds() / 3600.0
        dur = max(0.0, dur)

        bump = float(j.pay_rate_bump or 0.0)
        unpriced = False
        if use_piece:
            rate = getattr(prop, "turnover_rate", None) if prop is not None else None
            if rate is None:
                unpriced = True
                pay = 0.0
            else:
                pay = float(rate)
        else:
            if kind == "deep":
                hourly = (current_user.pay_rate_deep if current_user.pay_rate_deep is not None
                          else rates["deep_clean_rate"])
            elif kind == "rental":
                hourly = (current_user.pay_rate_rental if current_user.pay_rate_rental is not None
                          else rates["rental_weekday_rate"])
            else:
                hourly = (current_user.pay_rate_residential if current_user.pay_rate_residential is not None
                          else rates["residential_rate"])
            pay = dur * (hourly + bump)

        predicted_upcoming += pay
        upcoming.append({
            "id": j.id,
            "date": j.scheduled_date.isoformat(),
            "title": j.title,
            "property_name": prop.name if prop else None,
            "start_time": _fmt_time(j.start_time),
            "end_time": _fmt_time(j.end_time),
            "hours": round(dur, 2),
            "piece": use_piece,
            "bump": bump or 0.0,
            "unpriced": unpriced,
            "predicted_pay": round(pay, 2),
        })

    return {
        "as_of": today.isoformat(),
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "earned": earned,
        "upcoming": upcoming,
        "predicted_upcoming_total": round(predicted_upcoming, 2),
        "predicted_week_total": round(earned["gross_pay"] + predicted_upcoming, 2),
    }


@router.post("/clock-in")
def clock_in(
    body: ClockInBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Start a punch. One open punch per cleaner — a second clock-in while
    already on the clock is a 409 (clock out first). These punches are what
    native payroll pays from."""
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
        # Only clock into a job you're assigned to — otherwise a stale or crafted
        # request could attribute hours (and weekend piece-rate pay) to another
        # cleaner's work once native payroll reads these punches.
        if current_user.cleaner_id not in (job.cleaner_ids or []):
            raise HTTPException(status_code=403, detail="You're not assigned to that job.")

    entry = TimeEntry(
        org_id=oid,
        cleaner_id=current_user.cleaner_id,
        user_id=current_user.id,
        job_id=job_id,
        clock_in_at=_now_naive_utc(),
        source="native",
        clock_in_lat=body.lat,
        clock_in_lng=body.lng,
        clock_in_accuracy_m=body.accuracy_m,
    )
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        # Backstop for the one-open-punch invariant against a concurrent double
        # clock-in — the partial unique index (org_id, cleaner_id WHERE
        # clock_out_at IS NULL) rejects the second row. The pre-check above
        # handles the common (non-racing) case with a friendlier path.
        db.rollback()
        raise HTTPException(status_code=409, detail="You're already clocked in — clock out first.")
    db.refresh(entry)
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
    # Clamp, never reject: a mileage typo must not strand the cleaner on the
    # clock. A wrong value can be corrected via PATCH /entry/{id}/miles.
    if body.miles is not None:
        entry.miles = _sanitize_miles(body.miles)
    db.commit(); db.refresh(entry)
    return _entry_row(entry)


class EntryMilesBody(BaseModel):
    miles: float


@router.patch("/entry/{entry_id}/miles")
def set_entry_miles(
    entry_id: int,
    body: EntryMilesBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Correct the miles on one of the caller's own punches — the safety net for
    a forgotten or fat-fingered clock-out entry, before payroll runs. Scoped to
    the caller's cleaner_id so a cleaner can only edit their own mileage. 404 if
    the punch isn't theirs (or doesn't exist)."""
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    entry = (
        db.query(TimeEntry)
        .filter(org_scope(TimeEntry),
                TimeEntry.id == entry_id,
                TimeEntry.cleaner_id == current_user.cleaner_id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Time entry not found.")
    entry.miles = _sanitize_miles(body.miles)
    db.commit(); db.refresh(entry)
    return _entry_row(entry)


# ── Mark done (Phase 2c) ─────────────────────────────────────────────────────

def _sanitize_note(v: Optional[str]) -> Optional[str]:
    """Trim and cap the completion note. Empty/whitespace → None (no note)."""
    if v is None:
        return None
    v = v.strip()
    return v[:2000] if v else None


class MarkDoneBody(BaseModel):
    # Optional message back to the office ("lockbox was empty", "low on
    # towels"). Internal-only: stored on Job.completion_note, which is kept
    # OFF invoices by design (see the model comment / migration 080).
    note: Optional[str] = None


@router.post("/jobs/{job_id}/complete")
def mark_job_done(
    job_id: int,
    body: MarkDoneBody = MarkDoneBody(),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """The cleaner marks one of THEIR OWN jobs completed, optionally with a
    note for the office.

    This is the crew-side counterpart of the office's POST /api/jobs/{id}/complete
    and produces the same canonical transition: status='completed', completion
    stamps, a JOB_COMPLETED activity on the client timeline, and the draft
    invoice on the completing transition (same shared helper — billing doesn't
    depend on who marked the job done).

    Object-level authorization: the job must be assigned to the caller's crew
    ID. Not-yours reads as 404 (same pattern as the punch endpoints) so job IDs
    can't be probed. completed_by is always the caller — never client-supplied.

    Idempotent: re-marking an already-completed job just refreshes the note
    (their "oops, forgot to mention" path); no duplicate activity or invoice.
    """
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    job = (
        db.query(Job)
        .options(joinedload(Job.property), joinedload(Job.client))
        .filter(org_scope(Job), Job.id == job_id)
        .first()
    )
    if not job or current_user.cleaner_id not in (job.cleaner_ids or []):
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status == "cancelled":
        raise HTTPException(
            status_code=400,
            detail="This job was cancelled — check with the office before cleaning.",
        )

    note = _sanitize_note(body.note)
    prev_status = job.status
    job.status = "completed"
    job.completed_at = job.completed_at or datetime.now(timezone.utc)
    job.completed_by = current_user.id
    if note is not None:
        job.completion_note = note

    if prev_status != "completed":
        try:
            log_job_status_change(db, job, prev_status=prev_status,
                                  actor=getattr(current_user, "full_name", None) or "crew",
                                  note=note)
        except Exception:
            log.exception("log_job_status_change failed on crew mark_job_done")

    db.commit()
    db.refresh(job)

    if prev_status != "completed":
        auto_create_draft_invoice(db, job)

    return _job_row(job, _names_by_cleaner_id(db, [job]), current_user.cleaner_id)


# ── Job photos ───────────────────────────────────────────────────────────────
# Before/after shots, taken on the cleaner's phone from My Day (the office can
# use these endpoints too — the JobDetail gallery reads the same list). Bytes
# are stored in the DB (see the JobPhoto model for why), so serving is a plain
# authenticated GET here — no external storage, no public URLs to leak.

_MAX_PHOTO_BYTES = 5 * 1024 * 1024   # matches the office modal's per-file cap
_MAX_PHOTOS_PER_JOB = 30             # before+after of every room, with headroom


def _sniff_image_mime(data: bytes):
    """Identify the image type from magic bytes — never trust the client's
    content-type header (it's caller-supplied, and the bytes are what we'll
    serve back to a browser later)."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _photo_job_or_404(db: Session, oid: int, job_id: int, current_user: User) -> Job:
    """The job, org-scoped, with object-level access resolved per role:
    office roles see any job in the org; a cleaner only jobs assigned to their
    crew ID. Not-yours reads as 404 (same anti-probing pattern as mark-done).
    Deliberately stricter than GET /api/jobs/{id}/details' role gate — photos
    of clients' homes don't need to be readable across the whole crew."""
    org_scope = or_(Job.org_id == oid, Job.org_id.is_(None))
    job = db.query(Job).filter(org_scope, Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if current_user.role == "cleaner":
        _require_crew_id(current_user)
        if current_user.cleaner_id not in (job.cleaner_ids or []):
            raise HTTPException(status_code=404, detail="Job not found.")
    return job


def _photo_row(p: JobPhoto, current_user: User, uploader_names: dict) -> dict:
    return {
        "id": p.id,
        "job_id": p.job_id,
        "kind": p.kind,
        "content_type": p.content_type,
        "size_bytes": p.size_bytes,
        "created_at": _iso_utc(p.created_at),
        "uploaded_by": p.uploaded_by,
        "uploaded_by_name": uploader_names.get(p.uploaded_by),
        # Drives the delete affordance client-side; the DELETE endpoint
        # re-checks server-side regardless.
        "mine": p.uploaded_by == current_user.id,
        "url": f"/api/crew/jobs/{p.job_id}/photos/{p.id}",
    }


def _uploader_names(db: Session, photos) -> dict:
    ids = {p.uploaded_by for p in photos if p.uploaded_by}
    if not ids:
        return {}
    rows = db.query(User.id, User.full_name, User.email).filter(User.id.in_(ids)).all()
    return {r[0]: (r[1] or r[2]) for r in rows}


@router.post("/jobs/{job_id}/photos")
async def upload_job_photo(
    job_id: int,
    file: UploadFile = File(...),
    kind: str = Form(None),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner", "admin", "manager")),
):
    """Attach one photo to a job. Cleaners only on their own assigned jobs
    (404 otherwise); office roles on any job in the org.

    The frontend downscales to ~1600px JPEG before posting, so the 5MB cap is
    a backstop against raw phone originals, not the normal path. The stored
    content type comes from sniffing the bytes, never the client's header.
    An unknown `kind` is clamped to untagged rather than rejected — a photo
    must never bounce over its label."""
    oid = resolve_org_id(org_id, db)
    job = _photo_job_or_404(db, oid, job_id, current_user)

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="That file is empty.")
    if len(data) > _MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=413,
            detail="That photo is too large (over 5MB) — try again from the app, "
                   "which resizes before uploading.",
        )
    mime = _sniff_image_mime(data)
    if not mime:
        raise HTTPException(status_code=400,
                            detail="That file doesn't look like a photo (JPEG, PNG, or WebP).")

    count = db.query(func.count(JobPhoto.id)).filter(JobPhoto.job_id == job.id).scalar() or 0
    if count >= _MAX_PHOTOS_PER_JOB:
        raise HTTPException(status_code=400,
                            detail=f"This job already has {_MAX_PHOTOS_PER_JOB} photos.")

    k = (kind or "").strip().lower()
    photo = JobPhoto(
        org_id=oid,
        job_id=job.id,
        uploaded_by=current_user.id,
        kind=k if k in ("before", "after") else None,
        content_type=mime,
        size_bytes=len(data),
        data=data,
        created_at=_now_naive_utc(),
    )
    db.add(photo)
    db.commit()
    db.refresh(photo)
    return _photo_row(photo, current_user, _uploader_names(db, [photo]))


@router.get("/jobs/{job_id}/photos")
def list_job_photos(
    job_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner", "admin", "manager", "viewer")),
):
    """Metadata only (no bytes) — the gallery fetches each image lazily via the
    serve endpoint below, so listing stays cheap on a phone connection."""
    oid = resolve_org_id(org_id, db)
    job = _photo_job_or_404(db, oid, job_id, current_user)
    photos = (db.query(JobPhoto)
              .filter(JobPhoto.job_id == job.id)
              .order_by(JobPhoto.created_at, JobPhoto.id)
              .all())
    names = _uploader_names(db, photos)
    return [_photo_row(p, current_user, names) for p in photos]


@router.get("/jobs/{job_id}/photos/{photo_id}")
def serve_job_photo(
    job_id: int,
    photo_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner", "admin", "manager", "viewer")),
):
    """The image bytes. Same access rule as the list; a photo is immutable once
    uploaded, so the browser may cache it privately for a day."""
    oid = resolve_org_id(org_id, db)
    job = _photo_job_or_404(db, oid, job_id, current_user)
    photo = (db.query(JobPhoto)
             .filter(JobPhoto.job_id == job.id, JobPhoto.id == photo_id)
             .first())
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found.")
    return Response(
        content=photo.data,
        media_type=photo.content_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.delete("/jobs/{job_id}/photos/{photo_id}")
def delete_job_photo(
    job_id: int,
    photo_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner", "admin", "manager")),
):
    """Office roles can remove any photo on the job; a cleaner only their own
    uploads (the fat-finger case). Not-yours is a 404, same as everywhere else
    in this module."""
    oid = resolve_org_id(org_id, db)
    job = _photo_job_or_404(db, oid, job_id, current_user)
    q = db.query(JobPhoto).filter(JobPhoto.job_id == job.id, JobPhoto.id == photo_id)
    if current_user.role == "cleaner":
        q = q.filter(JobPhoto.uploaded_by == current_user.id)
    photo = q.first()
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found.")
    db.delete(photo)
    db.commit()
    return {"deleted": photo_id}


# ── Me: the cleaner's own profile (crew app Phase 1) ─────────────────────────
# Self-service contact info so the office file stays current without Meg
# re-typing texted phone numbers. Strictly the CALLER's own row — no user_id
# in the path, nothing about other users, and role/pay/crew-ID stay read-only
# (those are the office's to set, from Settings → Users / Crew).

_PROFILE_FIELD_MAX = 120


def _clean_profile_str(v):
    """Trim + cap a self-entered profile string; empty → None."""
    if v is None:
        return None
    v = str(v).strip()
    return v[:_PROFILE_FIELD_MAX] if v else None


def _me_row(u: User) -> dict:
    return {
        "id": u.id,
        "email": u.email,
        "full_name": u.full_name,
        "phone": u.phone,
        "emergency_contact_name": u.emergency_contact_name,
        "emergency_contact_phone": u.emergency_contact_phone,
        "cleaner_id": u.cleaner_id,
        "member_since": _iso_utc(u.created_at),
    }


class MeUpdate(BaseModel):
    full_name: Optional[str] = None
    phone: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None


@router.get("/me")
def get_me(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    u = db.query(User).filter(User.id == current_user.id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Account not found.")
    return _me_row(u)


@router.patch("/me")
def update_me(
    body: MeUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """Update the caller's own contact info. Omitted fields are untouched;
    sending an empty string clears a field — except full_name, which can be
    corrected but never blanked (every login needs a display name; it's what
    teammates and payroll show)."""
    u = db.query(User).filter(User.id == current_user.id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Account not found.")

    if body.full_name is not None:
        name = _clean_profile_str(body.full_name)
        if name:
            u.full_name = name
    if body.phone is not None:
        u.phone = _clean_profile_str(body.phone)
    if body.emergency_contact_name is not None:
        u.emergency_contact_name = _clean_profile_str(body.emergency_contact_name)
    if body.emergency_contact_phone is not None:
        u.emergency_contact_phone = _clean_profile_str(body.emergency_contact_phone)

    db.commit(); db.refresh(u)
    return _me_row(u)


# ── Reconciliation (office view) ─────────────────────────────────────────────

# ── Crew admin: manage cleaners as native users (Connecteam-free) ────────────
# The office manages the crew here — add a cleaner, set pay rates, and (crucial
# for the Connecteam cutover) claim the crew IDs already sitting on scheduled
# jobs so no assignment is lost. Adding a cleaner emails them an invite link to
# set their own password; accepting it is auth/router.py's public /accept-invite.

log = logging.getLogger(__name__)


def _crew_row(u: User) -> dict:
    return {
        "id": u.id,
        "full_name": u.full_name,
        "email": u.email,
        "cleaner_id": u.cleaner_id,
        "pay_rate_residential": u.pay_rate_residential,
        "pay_rate_rental": u.pay_rate_rental,
        "pay_rate_deep": u.pay_rate_deep,
        "status": u.status or "active",
        # True once they've set a password (accepted the invite) or logged in.
        "activated": bool(u.password_hash) or u.last_login_at is not None,
    }


@router.get("/roster", dependencies=[Depends(require_role("admin", "manager"))])
def crew_roster(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """The native crew list — every cleaner user, no Connecteam."""
    oid = resolve_org_id(org_id, db)
    rows = (db.query(User)
            .filter(User.role == "cleaner", or_(User.org_id == oid, User.org_id.is_(None)))
            .all())
    rows.sort(key=lambda u: (u.full_name or u.email or "").lower())
    return [_crew_row(u) for u in rows]


@router.get("/unclaimed-ids", dependencies=[Depends(require_role("admin", "manager"))])
def unclaimed_crew_ids(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Crew IDs already on upcoming jobs (Job.cleaner_ids) that no native user
    claims yet — read entirely from OUR database, never Connecteam. Naming each
    (create a cleaner with that crew-ID) keeps every scheduled job assigned
    across the cutover, so nobody falls off the schedule."""
    oid = resolve_org_id(org_id, db)
    today = business_today()
    known = {(cid or "").strip()
             for (cid,) in db.query(User.cleaner_id).filter(User.cleaner_id.isnot(None)).all()}
    known.discard("")
    counts: dict = defaultdict(int)
    jobs = (db.query(Job)
            .filter(or_(Job.org_id == oid, Job.org_id.is_(None)), Job.scheduled_date >= today)
            .all())
    for j in jobs:
        for cid in (j.cleaner_ids or []):
            cid = str(cid).strip()
            if cid and cid not in known:
                counts[cid] += 1
    return [{"cleaner_id": cid, "upcoming_jobs": n}
            for cid, n in sorted(counts.items(), key=lambda kv: -kv[1])]


class CrewCreate(BaseModel):
    full_name: str
    email: str
    cleaner_id: Optional[str] = None
    pay_rate_residential: Optional[float] = None
    pay_rate_rental: Optional[float] = None
    pay_rate_deep: Optional[float] = None


@router.post("/{user_id}/resend-invite", dependencies=[Depends(require_role("admin"))])
def resend_crew_invite(user_id: int, db: Session = Depends(get_db),
                       org_id: int = Depends(current_org_id)):
    """Re-email the set-password invite to a cleaner who hasn't activated yet —
    the link expires in 7 days, or the first email got lost. 404 if they're not
    a cleaner in this org; 409 once they've set a password (nothing to invite —
    they sign in, or reset, from there)."""
    oid = resolve_org_id(org_id, db)
    u = (db.query(User)
         .filter(User.id == user_id, User.role == "cleaner",
                 or_(User.org_id == oid, User.org_id.is_(None)))
         .first())
    if not u:
        raise HTTPException(status_code=404, detail="Cleaner not found.")
    if u.password_hash:
        raise HTTPException(status_code=409,
                            detail="This cleaner has already set their password.")
    send_staff_invite(u)
    return _crew_row(u)


@router.post("", dependencies=[Depends(require_role("admin"))])
def add_crew(body: CrewCreate, db: Session = Depends(get_db),
             org_id: int = Depends(current_org_id)):
    """Add a cleaner as a native user and email them an invite to set a password.
    Their optional crew-ID ties them to existing Job.cleaner_ids assignments
    (see /unclaimed-ids). No Connecteam involved."""
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="A valid email is required to invite a cleaner.")
    if db.query(User).filter(func.lower(User.email) == email).first():
        raise HTTPException(status_code=409, detail="A user with that email already exists.")
    for attr in ("pay_rate_residential", "pay_rate_rental", "pay_rate_deep"):
        v = getattr(body, attr)
        if v is not None and v < 0:
            raise HTTPException(status_code=422, detail=f"{attr} cannot be negative.")
    cid = (body.cleaner_id or "").strip() or None
    if cid and db.query(User).filter(User.cleaner_id == cid).first():
        # One crew ID = one person. Two accounts sharing an ID would see the
        # same schedule and both accrue its pay.
        raise HTTPException(status_code=409,
                            detail=f"Crew ID '{cid}' already belongs to another user.")
    oid = resolve_org_id(org_id, db)
    u = User(
        email=email, password_hash=None,
        full_name=(body.full_name or "").strip() or email,
        role="cleaner", status="invited", active=True, org_id=oid,
        auth_provider="password",
        cleaner_id=cid,
        pay_rate_residential=body.pay_rate_residential,
        pay_rate_rental=body.pay_rate_rental,
        pay_rate_deep=body.pay_rate_deep,
    )
    db.add(u)
    db.flush()  # assigns u.id so the auto crew ID can derive from it
    if not u.cleaner_id:
        # Every cleaner needs a crew ID to be assignable — it's the value the
        # Schedule writes into Job.cleaner_ids and dispatch/My-Day key on. New
        # crew (no legacy Connecteam ID to claim) get one minted from the PK:
        # 'bb{id}' is unique by construction and can never collide with the
        # numeric legacy IDs.
        u.cleaner_id = f"bb{u.id}"
    db.commit(); db.refresh(u)
    send_staff_invite(u)
    return _crew_row(u)


# The invite email itself lives in modules/auth/router.py (send_staff_invite) —
# one sender for both the crew add and the generic Users-screen invite, so the
# wording and 7-day TTL can never drift apart.
