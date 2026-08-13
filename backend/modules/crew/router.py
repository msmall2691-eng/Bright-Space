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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from database.db import get_db
from database.models import Job, User, TimeEntry
from modules.auth.router import require_role, current_org_id, resolve_org_id, send_staff_invite
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
        "today": [_job_row(j) for j in today_jobs],
        "upcoming": [_job_row(j) for j in upcoming_jobs],
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
