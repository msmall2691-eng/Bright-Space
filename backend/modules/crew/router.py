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
from datetime import date, datetime, timedelta, timezone, time as dtime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from database.db import get_db
from database.models import (
    CleanerAvailability, CleanerTimeOff, CleanerWeekAvailability, CrewDoc,
    CrewMessage, Job, JobClaimRequest, JobPhoto, JobResponse, PropertyCrewNote,
    PropertyPhoto, User, TimeEntry,
)
from modules.auth.router import (
    get_current_user, require_role, current_org_id, resolve_org_id, send_staff_invite,
)
from modules.scheduling.completion import auto_create_draft_invoice
from utils.activity_logger import log_job_status_change
from utils.dates import business_today, business_tz, week_monday

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


def _job_row(job: Job, names_by_cid: dict | None = None, self_cid: str | None = None,
             my_response: "JobResponse | None" = None,
             house_notes: "list | None" = None,
             my_claim_request: "JobClaimRequest | None" = None) -> dict:
    prop = job.property
    client = job.client
    return {
        "id": job.id,
        "property_id": job.property_id,
        "title": job.title,
        "job_type": job.job_type,
        "status": job.status,
        "scheduled_date": job.scheduled_date.isoformat() if job.scheduled_date else None,
        "start_time": _fmt_time(job.start_time),
        "end_time": _fmt_time(job.end_time),
        "property_name": prop.name if prop else None,
        "address": prop.address if prop else (job.address or None),
        # What the office wrote on the job — "dog in the yard", "bring the
        # tall ladder". Was never sent to crew before Aug 2026 (owner bug
        # report: "I'm still not seeing notes").
        "notes": (job.notes or "").strip() or None,
        # Structured house specs (enrichment columns) + type — the crew house
        # preview's "3 bd · 2.5 ba · 1,850 sqft" line. Read-only context; the
        # client renders only the fields that are present. Not access details,
        # so they may ride open-job offers like the address does.
        "property_type": prop.property_type if prop else None,
        "bedrooms": prop.bedrooms if prop else None,
        "bathrooms": prop.bathrooms if prop else None,
        "square_footage": prop.square_footage if prop else None,
        "year_built": prop.year_built if prop else None,
        # Crew-relevant property context only — no billing/client-financial
        # data belongs in this response.
        "access_notes": (prop.access_notes if prop else None) or None,
        "parking_notes": (prop.parking_notes if prop else None) or None,
        "house_code": (prop.house_code if prop else None) or None,
        # Guest WiFi rides the card AND the offline cache — at a dead-zone
        # house, these credentials ARE the connectivity fix.
        "wifi_ssid": (getattr(prop, "wifi_ssid", None) if prop else None) or None,
        "wifi_password": (getattr(prop, "wifi_password", None) if prop else None) or None,
        # Office-SHARED house notes ("upstairs drain clogs") inline so
        # they're readable offline too. Author-only notes don't ride here.
        "house_notes": house_notes or [],
        "turnover_line": _turnover_line(job),
        "checklist_template": (prop.checklist_template if prop else None) or None,
        # Who the customer is. Their NUMBER is deliberately absent (owner
        # reversed the Phase-1 call, Aug 2026): crew reach customers through
        # the structured-text endpoint below — from the BUSINESS number,
        # logged in the conversation — never a personal phone-to-phone line.
        "client_name": client.name if client else None,
        "can_text_client": bool(client and (client.phone or "").strip()),
        "crew_size": len(job.cleaner_ids or []),
        # The OTHER people on this job, as display names (crew-ID strings mean
        # nothing to a human). Resolved from the map my-day builds in one query.
        "teammates": sorted(
            (names_by_cid or {}).get(str(cid), str(cid))
            for cid in (job.cleaner_ids or [])
            if self_cid is None or str(cid) != str(self_cid)
        ) if names_by_cid is not None else [],
        # The caller's own accept/decline answer for this job (crew app Phase
        # 2) — null until they respond. Drives the Accept / Can't-make-it row.
        "my_response": ({"response": my_response.response, "reason": my_response.reason}
                        if my_response else None),
        # Mark-done state (Phase 2c): lets the card show "Done ✓" and echo the
        # note the cleaner left, instead of the job silently vanishing.
        "completed_at": _iso_utc(job.completed_at),
        "completion_note": job.completion_note,
        # Marketplace pivot (migration 097): posted_rate is the office's
        # asking price on an open offer; agreed_rate is the final rate once
        # a request is approved (may differ — the winner may have
        # countered). my_claim_request is the CALLER's own pending/decided
        # request on this specific job, so the app can show "You asked for
        # $85 — waiting to hear back" instead of letting them request twice.
        "posted_rate": job.posted_rate,
        "agreed_rate": job.agreed_rate,
        "my_claim_request": (
            {"status": my_claim_request.status, "requested_rate": my_claim_request.requested_rate,
             "message": my_claim_request.message}
            if my_claim_request else None
        ),
    }


def _shared_notes_by_property(db: Session, jobs) -> dict:
    """property_id → [{body, author_name}] for office-SHARED notes, one
    batched query, newest first, capped at 5 per property (the card is a
    phone screen, not an archive)."""
    pids = {j.property_id for j in jobs if j.property_id}
    if not pids:
        return {}
    rows = (db.query(PropertyCrewNote)
            .filter(PropertyCrewNote.property_id.in_(pids),
                    PropertyCrewNote.shared.is_(True))
            .order_by(PropertyCrewNote.created_at.desc())
            .all())
    out: dict = {}
    for n in rows:
        bucket = out.setdefault(n.property_id, [])
        if len(bucket) < 5:
            bucket.append({"body": n.body, "author_name": n.author_name})
    return out


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
    # Shared house notes ride only TODAY's rows (they're read on site, and
    # today's payload is what the offline cache keeps). Upcoming rows travel
    # light — see the "upcoming" comment below.
    house_notes = _shared_notes_by_property(db, today_jobs)
    # The caller's own accept/decline answers for the window, one query.
    my_responses = {
        r.job_id: r
        for r in db.query(JobResponse).filter(
            JobResponse.job_id.in_([j.id for j in mine] or [0]),
            JobResponse.cleaner_id == current_user.cleaner_id,
        ).all()
    }

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

    # Jobs the office put "up for grabs" (crew app Phase 3) — visible to every
    # cleaner in the org. Marketplace pivot (migration 097): a sub REQUESTS
    # an open job (optionally countering posted_rate) rather than instantly
    # claiming it — the office picks who gets it. Access details and the
    # customer's phone stay hidden until the job is actually theirs: an open
    # listing is an offer, not a work order, and gate codes don't belong on
    # every phone in the crew.
    open_jobs = []
    open_job_ids = [j.id for j in jobs if getattr(j, "open_for_claims", False)
                    and j.status == "scheduled"]
    my_requests_by_job = {
        r.job_id: r
        for r in db.query(JobClaimRequest).filter(
            JobClaimRequest.job_id.in_(open_job_ids or [0]),
            JobClaimRequest.cleaner_id == current_user.cleaner_id,
        ).all()
    }
    for j in jobs:
        if not getattr(j, "open_for_claims", False) or j.status != "scheduled":
            continue
        if current_user.cleaner_id in (j.cleaner_ids or []):
            continue
        row = _job_row(j, names, current_user.cleaner_id,
                       my_claim_request=my_requests_by_job.get(j.id))
        row.update({"open": True, "house_code": None, "access_notes": None,
                    "parking_notes": None, "can_text_client": False,
                    "checklist_template": None, "turnover_line": "",
                    "notes": None, "wifi_ssid": None, "wifi_password": None,
                    "house_notes": []})   # offers carry no house internals
        open_jobs.append(row)

    return {
        "as_of": today.isoformat(),
        "crew_id": current_user.cleaner_id,
        # For the Today greeting ("Good morning, Sarah").
        "first_name": ((getattr(current_user, "full_name", None) or "").strip().split(" ")[0]
                       or (getattr(current_user, "email", "") or "").split("@")[0]),
        "today": [_job_row(j, names, current_user.cleaner_id, my_responses.get(j.id),
                           house_notes=house_notes.get(j.property_id))
                  for j in today_jobs],
        # Upcoming rows are a 13-day preview and the bulk of the payload, so
        # the heavy per-house fields stay off them (rural cell data): no
        # checklist_template, no house_notes. Both are served on tap — the
        # crew job detail (GET /api/crew/jobs/{id}) and the house sheet
        # (GET /api/crew/properties/{id}/notes) return the full row.
        "upcoming": [{**_job_row(j, names, current_user.cleaner_id, my_responses.get(j.id)),
                      "checklist_template": None}
                     for j in upcoming_jobs],
        "open_jobs": open_jobs,
        # Unread office messages, so the crew app's Chat tab can badge without
        # a second request. Reading the thread (GET /messages) marks them read.
        "unread_messages": (
            db.query(func.count(CrewMessage.id))
            .filter(CrewMessage.user_id == current_user.id,
                    CrewMessage.sender == "office",
                    CrewMessage.read_at.is_(None))
            .scalar() or 0
        ),
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


# ── Open jobs: request to claim (marketplace pivot, migration 097) ──────────

class ClaimRequestBody(BaseModel):
    # NULL/omitted = "I'll take your posted rate." Set = a counter-offer.
    requested_rate: Optional[float] = None
    message: Optional[str] = None


@router.post("/jobs/{job_id}/claim")
def claim_job(
    job_id: int,
    body: ClaimRequestBody = None,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Request an open job — marketplace pivot (migration 097).

    This used to be an instant first-come-first-served claim. It's now a
    REQUEST: the sub optionally counters the office's posted_rate and/or
    leaves a message, and the office picks who gets it (see
    modules.scheduling.router's approve/decline-claim-request endpoints).
    Nothing here writes Job.cleaner_ids or closes the offer — a job can
    carry several pending requests at once, exactly the point of "the
    office picks."

    Still narrowly gated the same way Phase 3 was (scheduling-invariants
    reviewed): the job must carry open_for_claims (being unassigned is NOT
    enough), BrightBase stays the sole schedule-state owner, and a second
    tap from the same sub UPDATES their pending request (a changed-my-mind
    counter-offer) rather than creating a duplicate.

    No row lock here, unlike the claim it replaces: filing a request writes
    nothing anyone else races for. The lock moved to the approval endpoint,
    which is now the step that actually assigns the job and fixes the rate.
    """
    _require_crew_id(current_user)
    body = body or ClaimRequestBody()
    oid = resolve_org_id(org_id, db)
    org_scope = or_(Job.org_id == oid, Job.org_id.is_(None))

    job = (db.query(Job)
           .options(joinedload(Job.property), joinedload(Job.client))
           .filter(org_scope, Job.id == job_id)
           .first())
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if current_user.cleaner_id in (job.cleaner_ids or []):
        raise HTTPException(status_code=400, detail="You're already on this job.")
    if not getattr(job, "open_for_claims", False) or job.status != "scheduled":
        raise HTTPException(status_code=409, detail="This job isn't open anymore.")

    # A request can't be approved into a double-booking, so refuse it here
    # too (not just at approve time) — no point letting the office review a
    # request that could never be honored. Checked again at approval since
    # the sub's schedule may have changed in between.
    from modules.scheduling.router import _find_cleaner_conflicts, _conflict_detail
    conflicts = _find_cleaner_conflicts(
        db, cleaner_ids=[current_user.cleaner_id], scheduled_date=job.scheduled_date,
        start_time=job.start_time, end_time=job.end_time, exclude_job_id=job.id,
        org_id=oid,
    )
    if conflicts:
        raise HTTPException(status_code=409, detail=_conflict_detail(conflicts))

    rate = body.requested_rate
    if rate is not None and rate <= 0:
        raise HTTPException(status_code=422, detail="requested_rate must be positive.")
    # A job posted with no asking price can only be worked for a price if the
    # sub names one. Catching it here means they find out while they're still
    # looking at the offer, rather than having the office's approval bounce
    # later for a reason neither of them can see. Approval enforces it too.
    if rate is None and job.posted_rate is None:
        raise HTTPException(
            status_code=422,
            detail="This job has no posted rate — name your price to request it.")
    msg = _sanitize_note(body.message) if body.message else None

    existing = (db.query(JobClaimRequest)
                .filter(JobClaimRequest.job_id == job.id,
                        JobClaimRequest.cleaner_id == current_user.cleaner_id)
                .first())
    now = _now_naive_utc()
    if existing and existing.status == "pending":
        existing.requested_rate, existing.message, existing.updated_at = rate, msg, now
        request = existing
    elif existing:
        # A previously declined/withdrawn request from this sub — reopen it
        # rather than accumulating rows for the same (job, cleaner) pair.
        existing.status, existing.requested_rate, existing.message = "pending", rate, msg
        existing.updated_at, existing.decided_at, existing.decided_by = now, None, None
        request = existing
    else:
        request = JobClaimRequest(
            org_id=oid, job_id=job.id, cleaner_id=current_user.cleaner_id,
            user_id=current_user.id, requested_rate=rate, message=msg,
            status="pending", created_at=now, updated_at=now,
        )
        db.add(request)

    who = getattr(current_user, "full_name", None) or current_user.email
    when = job.scheduled_date.isoformat() if job.scheduled_date else "unscheduled"
    rate_note = f" at ${rate:,.2f}" if rate is not None else ""
    try:
        from utils.activity_logger import log_activity
        log_activity(
            db, "crew_claim_request", job_id=job.id, client_id=job.client_id, actor=who,
            summary=f"{who} requested {job.title} ({when}){rate_note}",
            extra_data={"cleaner_id": current_user.cleaner_id, "requested_rate": rate},
        )
    except Exception:
        log.exception("activity log failed on claim_job")
    db.commit()
    db.refresh(request)

    try:
        from services.push_service import notify_staff
        notify_staff(
            db, "Job request",
            f"{who} wants {job.title} on {when}{rate_note}"
            + (f' — "{msg}"' if msg else "") + ". Review it in Schedule.",
            url=f"/jobs/{job.id}", tag=f"job-claim-{job.id}", org_id=oid,
            category="crew",
        )
    except Exception:
        log.exception("push notify failed on claim_job")

    return {"job_id": job.id, "status": request.status, "requested_rate": request.requested_rate,
            "message": request.message}


# ── Accept / decline (crew app Phase 2) ──────────────────────────────────────

class RespondBody(BaseModel):
    response: str                      # "accepted" | "declined"
    reason: Optional[str] = None       # declines only, optional


@router.post("/jobs/{job_id}/respond")
def respond_to_job(
    job_id: int,
    body: RespondBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """The cleaner answers an assignment: accepted, or declined with a reason.

    A STATUS, not a schedule write (crew-app plan decision #1): declining
    never touches Job.cleaner_ids — the office keeps schedule authority and
    decides the reassignment. Changing your mind is allowed: one row per
    (job, cleaner), updated in place (the unique constraint backstops races).

    A decline pings staff (web push, best-effort) and both answers land on the
    job's timeline — quiet green check vs. loud red flag, matching how the
    office actually needs to hear about each.
    """
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    org_scope = or_(Job.org_id == oid, Job.org_id.is_(None))

    resp = (body.response or "").strip().lower()
    if resp not in ("accepted", "declined"):
        raise HTTPException(status_code=422, detail="response must be 'accepted' or 'declined'.")

    job = db.query(Job).filter(org_scope, Job.id == job_id).first()
    if not job or current_user.cleaner_id not in (job.cleaner_ids or []):
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status in ("cancelled", "completed"):
        raise HTTPException(status_code=400, detail="This job is already settled.")

    reason = _sanitize_note(body.reason) if resp == "declined" else None
    row = (db.query(JobResponse)
           .filter(JobResponse.job_id == job.id,
                   JobResponse.cleaner_id == current_user.cleaner_id)
           .first())
    changed = row is None or row.response != resp or row.reason != reason
    if row is None:
        row = JobResponse(org_id=oid, job_id=job.id,
                          cleaner_id=current_user.cleaner_id,
                          user_id=current_user.id,
                          response=resp, reason=reason,
                          created_at=_now_naive_utc(), updated_at=_now_naive_utc())
        db.add(row)
    else:
        row.response, row.reason = resp, reason
        row.updated_at = _now_naive_utc()
    try:
        db.commit()
    except IntegrityError:
        # Double-tap race on first response — the unique constraint caught the
        # twin insert; re-apply as an update.
        db.rollback()
        row = (db.query(JobResponse)
               .filter(JobResponse.job_id == job.id,
                       JobResponse.cleaner_id == current_user.cleaner_id)
               .first())
        row.response, row.reason = resp, reason
        row.updated_at = _now_naive_utc()
        db.commit()
    db.refresh(row)

    if changed:
        who = getattr(current_user, "full_name", None) or current_user.email
        when = job.scheduled_date.isoformat() if job.scheduled_date else "unscheduled"
        try:
            from utils.activity_logger import log_activity
            verb = "accepted" if resp == "accepted" else "can't make"
            log_activity(
                db, "crew_response", job_id=job.id, client_id=job.client_id,
                actor=who,
                summary=f"{who} {verb} {job.title} ({when})" + (f" — “{reason}”" if reason else ""),
                extra_data={"response": resp, "reason": reason,
                            "cleaner_id": current_user.cleaner_id},
                commit=True,
            )
        except Exception:
            log.exception("activity log failed on respond_to_job")
        if resp == "declined":
            # Loud path: a decline needs eyes today, not at the next login.
            try:
                from services.push_service import notify_staff
                notify_staff(
                    db, "Crew can't make a job",
                    f"{who} declined {job.title} on {when}"
                    + (f': "{reason}"' if reason else "") + " — needs a reassignment.",
                    url=f"/jobs/{job.id}", tag=f"job-response-{job.id}", org_id=oid,
                    category="crew",
                )
            except Exception:
                log.exception("push notify failed on respond_to_job")

    return {"job_id": job.id, "response": row.response, "reason": row.reason,
            "updated_at": _iso_utc(row.updated_at)}


# ── Property house notes + reference photos (rental pack, migration 090) ────
# Access rule: a cleaner touches a property's notes/photos iff they're
# assigned to ANY non-cancelled job there (they clean that house — they know
# it). Office roles pass on role alone. 404 either way for outsiders.

def _property_or_404(db: Session, oid: int, property_id: int, current_user: User):
    from database.models import Property
    prop = db.query(Property).filter(
        Property.id == property_id,
        or_(Property.org_id == oid, Property.org_id.is_(None))).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found.")
    if current_user.role == "cleaner":
        _require_crew_id(current_user)
        assignments = db.query(Job.cleaner_ids).filter(
            or_(Job.org_id == oid, Job.org_id.is_(None)),
            Job.property_id == property_id,
            Job.status != "cancelled",
        ).all()
        if not any(current_user.cleaner_id in (ids or []) for (ids,) in assignments):
            raise HTTPException(status_code=404, detail="Property not found.")
    return prop


def _note_dict(n: PropertyCrewNote, current_user: User) -> dict:
    return {"id": n.id, "body": n.body, "author_name": n.author_name,
            "shared": bool(n.shared), "mine": n.author_user_id == current_user.id,
            "created_at": _iso_utc(n.created_at)}


class NoteBody(BaseModel):
    body: str


@router.get("/properties/{property_id}/notes",
            dependencies=[Depends(require_role("cleaner", "admin", "manager"))])
def property_notes(
    property_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(get_current_user),
):
    """Shared notes + the caller's own pending ones. Office sees everything
    (that's how pending notes get reviewed and shared)."""
    oid = resolve_org_id(org_id, db)
    _property_or_404(db, oid, property_id, current_user)
    q = db.query(PropertyCrewNote).filter(PropertyCrewNote.property_id == property_id)
    if current_user.role == "cleaner":
        q = q.filter(or_(PropertyCrewNote.shared.is_(True),
                         PropertyCrewNote.author_user_id == current_user.id))
    rows = q.order_by(PropertyCrewNote.shared.desc(),
                      PropertyCrewNote.created_at.desc()).all()
    return [_note_dict(n, current_user) for n in rows]


@router.post("/properties/{property_id}/notes", status_code=201,
             dependencies=[Depends(require_role("cleaner", "admin", "manager"))])
def add_property_note(
    property_id: int,
    body: NoteBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(get_current_user),
):
    """Crew notes arrive UNSHARED (author + office only) and ping the office
    for review; office-authored notes are shared immediately."""
    oid = resolve_org_id(org_id, db)
    prop = _property_or_404(db, oid, property_id, current_user)
    text = _sanitize_note(body.body)
    if not text:
        raise HTTPException(status_code=422, detail="Write the note first.")
    who = getattr(current_user, "full_name", None) or current_user.email
    is_office = current_user.role != "cleaner"
    n = PropertyCrewNote(org_id=oid, property_id=property_id,
                         author_user_id=current_user.id, author_name=who,
                         body=text, shared=is_office,
                         created_at=_now_naive_utc(), updated_at=_now_naive_utc())
    db.add(n); db.commit(); db.refresh(n)
    if not is_office:
        try:
            from services.push_service import notify_staff
            notify_staff(db, "House note to review",
                         f"{who} on {prop.name or prop.address}: "
                         + (text if len(text) <= 100 else text[:97] + "…"),
                         url=f"/properties/{property_id}",
                         tag=f"prop-note-{n.id}", org_id=oid,
                         category="crew")
        except Exception:
            log.exception("push notify failed on add_property_note")
    return _note_dict(n, current_user)


@router.patch("/properties/{property_id}/notes/{note_id}")
def share_property_note(
    property_id: int,
    note_id: int,
    body: dict,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("admin", "manager")),
):
    """Office-only: flip shared on/off — sharing is the curation step."""
    oid = resolve_org_id(org_id, db)
    n = db.query(PropertyCrewNote).filter(
        PropertyCrewNote.id == note_id,
        PropertyCrewNote.property_id == property_id,
        or_(PropertyCrewNote.org_id == oid, PropertyCrewNote.org_id.is_(None))).first()
    if not n:
        raise HTTPException(status_code=404, detail="Note not found.")
    if "shared" in body:
        n.shared = bool(body["shared"])
        n.updated_at = _now_naive_utc()
        db.commit(); db.refresh(n)
    return _note_dict(n, current_user)


@router.delete("/properties/{property_id}/notes/{note_id}",
               dependencies=[Depends(require_role("cleaner", "admin", "manager"))])
def delete_property_note(
    property_id: int,
    note_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(get_current_user),
):
    """Office deletes anything; a cleaner only their own not-yet-shared note
    (shared notes are crew infrastructure now — office's call)."""
    oid = resolve_org_id(org_id, db)
    n = db.query(PropertyCrewNote).filter(
        PropertyCrewNote.id == note_id,
        PropertyCrewNote.property_id == property_id,
        or_(PropertyCrewNote.org_id == oid, PropertyCrewNote.org_id.is_(None))).first()
    if not n:
        raise HTTPException(status_code=404, detail="Note not found.")
    if current_user.role == "cleaner" and (n.author_user_id != current_user.id or n.shared):
        raise HTTPException(status_code=403, detail="Shared notes are managed by the office.")
    db.delete(n); db.commit()
    return {"ok": True}


def _prop_photo_row(p: PropertyPhoto, current_user: User, names: dict) -> dict:
    return {"id": p.id, "property_id": p.property_id, "caption": p.caption,
            "content_type": p.content_type, "size_bytes": p.size_bytes,
            "created_at": _iso_utc(p.created_at),
            "uploaded_by_name": names.get(p.uploaded_by),
            "mine": p.uploaded_by == current_user.id,
            "url": f"/api/crew/properties/{p.property_id}/photos/{p.id}"}


_MAX_PROP_PHOTOS = 40


@router.get("/properties/{property_id}/photos",
            dependencies=[Depends(require_role("cleaner", "admin", "manager"))])
def list_property_photos(
    property_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(get_current_user),
):
    oid = resolve_org_id(org_id, db)
    _property_or_404(db, oid, property_id, current_user)
    rows = (db.query(PropertyPhoto)
            .filter(PropertyPhoto.property_id == property_id)
            .order_by(PropertyPhoto.created_at.desc()).all())
    ids = {p.uploaded_by for p in rows if p.uploaded_by}
    names = ({r[0]: (r[1] or r[2]) for r in
              db.query(User.id, User.full_name, User.email).filter(User.id.in_(ids)).all()}
             if ids else {})
    return [_prop_photo_row(p, current_user, names) for p in rows]


@router.get("/properties/{property_id}/photos/{photo_id}",
            dependencies=[Depends(require_role("cleaner", "admin", "manager"))])
def property_photo_content(
    property_id: int,
    photo_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(get_current_user),
):
    oid = resolve_org_id(org_id, db)
    _property_or_404(db, oid, property_id, current_user)
    p = db.query(PropertyPhoto).filter(PropertyPhoto.id == photo_id,
                                       PropertyPhoto.property_id == property_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Photo not found.")
    return Response(content=p.data, media_type=p.content_type,
                    headers={"Cache-Control": "private, max-age=86400"})


@router.post("/properties/{property_id}/photos",
             dependencies=[Depends(require_role("cleaner", "admin", "manager"))])
async def upload_property_photo(
    property_id: int,
    file: UploadFile = File(...),
    caption: str = Form(""),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(get_current_user),
):
    """Reference photo ("master bed — 4 pillows"). Same caps as job photos;
    the client downscales before upload."""
    oid = resolve_org_id(org_id, db)
    _property_or_404(db, oid, property_id, current_user)
    data = await file.read()
    ctype = _sniff_image_mime(data)
    if ctype is None:
        raise HTTPException(status_code=422, detail="JPEG, PNG or WebP only.")
    if len(data) > _MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="Photo too large (5MB max).")
    count = db.query(PropertyPhoto).filter(PropertyPhoto.property_id == property_id).count()
    if count >= _MAX_PROP_PHOTOS:
        raise HTTPException(status_code=409, detail="This property's gallery is full — remove old photos first.")
    p = PropertyPhoto(org_id=oid, property_id=property_id, uploaded_by=current_user.id,
                      caption=(caption or "").strip()[:200] or None,
                      content_type=ctype, size_bytes=len(data), data=data,
                      created_at=_now_naive_utc())
    db.add(p); db.commit(); db.refresh(p)
    return _prop_photo_row(p, current_user, {current_user.id: getattr(current_user, "full_name", None)})


@router.delete("/properties/{property_id}/photos/{photo_id}",
               dependencies=[Depends(require_role("cleaner", "admin", "manager"))])
def delete_property_photo(
    property_id: int,
    photo_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(get_current_user),
):
    oid = resolve_org_id(org_id, db)
    _property_or_404(db, oid, property_id, current_user)
    p = db.query(PropertyPhoto).filter(PropertyPhoto.id == photo_id,
                                       PropertyPhoto.property_id == property_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Photo not found.")
    if current_user.role == "cleaner" and p.uploaded_by != current_user.id:
        raise HTTPException(status_code=403, detail="Only your own photos.")
    db.delete(p); db.commit()
    return {"ok": True}


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


# ── Single-job detail (assigned only) ────────────────────────────────────────

@router.get("/jobs/{job_id}")
def crew_job_detail(
    job_id: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Full card context for ONE job — powers the tap-through from the month
    view (and anywhere else a row needs to open). Assigned-only, 404 for
    everyone else: even leads who can SEE the whole month only get names and
    times for jobs that aren't theirs — access details stay need-to-know."""
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    job = (db.query(Job)
           .options(joinedload(Job.property), joinedload(Job.client))
           .filter(or_(Job.org_id == oid, Job.org_id.is_(None)), Job.id == job_id)
           .first())
    if not job or current_user.cleaner_id not in (job.cleaner_ids or []):
        raise HTTPException(status_code=404, detail="Job not found.")
    my_resp = (db.query(JobResponse)
               .filter(JobResponse.job_id == job.id,
                       JobResponse.cleaner_id == current_user.cleaner_id)
               .first())
    # Shared house notes ride the single-job payload too, so the month-view
    # tap-through shows the same card my-day renders (nothing silently missing).
    house_notes = _shared_notes_by_property(db, [job]).get(job.property_id)
    return _job_row(job, _names_by_cleaner_id(db, [job]), current_user.cleaner_id, my_resp,
                    house_notes=house_notes)


# ── Weather (Today-tab greeting) ─────────────────────────────────────────────
# Open-Meteo: free, keyless, and fail-soft — a weather hiccup must never
# break the schedule screen. Cached in-process for 30 minutes per worker.

_WEATHER_CACHE: dict = {"at": None, "data": None}
_WEATHER_CODES = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "foggy", 48: "foggy", 51: "drizzle", 53: "drizzle", 55: "drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain",
    67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow",
    77: "snow", 80: "showers", 81: "showers", 82: "heavy showers",
    85: "snow showers", 86: "snow showers", 95: "thunderstorms",
    96: "thunderstorms", 99: "thunderstorms",
}


@router.get("/weather")
def crew_weather(current_user: User = Depends(require_role("cleaner"))):
    """Today's outlook for the crew greeting. {available: false} on ANY
    problem — never an error the UI has to handle."""
    import os
    now = datetime.now(timezone.utc)
    if _WEATHER_CACHE["at"] and (now - _WEATHER_CACHE["at"]).total_seconds() < 1800:
        return _WEATHER_CACHE["data"]
    lat = os.getenv("WEATHER_LAT", "43.66")    # Portland, ME defaults
    lon = os.getenv("WEATHER_LON", "-70.26")
    try:
        import httpx
        r = httpx.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat, "longitude": lon,
                "current": "temperature_2m,weather_code",
                "daily": "temperature_2m_max,precipitation_probability_max",
                "temperature_unit": "fahrenheit",
                "timezone": "auto", "forecast_days": 1,
            },
            timeout=4.0,
        )
        r.raise_for_status()
        d = r.json()
        data = {
            "available": True,
            "temp_f": round(d["current"]["temperature_2m"]),
            "high_f": round(d["daily"]["temperature_2m_max"][0]),
            "precip_chance": int(d["daily"]["precipitation_probability_max"][0] or 0),
            "summary": _WEATHER_CODES.get(d["current"]["weather_code"], ""),
        }
    except Exception:
        data = {"available": False}
    _WEATHER_CACHE.update({"at": now, "data": data})
    return data


# ── Month schedule (own jobs; whole crew for flagged leads) ──────────────────

@router.get("/schedule-month")
def schedule_month(
    year: int,
    month: int,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """One calendar month of jobs for the crew app's Month view.

    Everyone sees their OWN jobs. A lead the admin flagged
    (can_view_full_schedule) also sees everyone else's — but those rows are
    NAMES/TIMES ONLY: no door codes, no access notes, no client phone, no
    office notes. Access details stay need-to-know, scoped to the jobs
    you're actually on (security-roles: gate codes are the crown jewels).
    """
    _require_crew_id(current_user)
    if not (1 <= month <= 12):
        raise HTTPException(status_code=422, detail="month must be 1-12.")
    oid = resolve_org_id(org_id, db)
    first = date(year, month, 1)
    last = date(year + (month == 12), (month % 12) + 1, 1) - timedelta(days=1)
    see_all = bool(getattr(current_user, "can_view_full_schedule", False))

    jobs = (db.query(Job)
            .options(joinedload(Job.property))
            .filter(or_(Job.org_id == oid, Job.org_id.is_(None)),
                    Job.scheduled_date >= first,
                    Job.scheduled_date <= last,
                    Job.status.notin_(("cancelled",)))
            .all())
    if not see_all:
        jobs = [j for j in jobs if current_user.cleaner_id in (j.cleaner_ids or [])]
    names = _names_by_cleaner_id(db, jobs)

    out = []
    for j in sorted(jobs, key=lambda x: (x.scheduled_date, x.start_time is None, x.start_time)):
        mine = current_user.cleaner_id in (j.cleaner_ids or [])
        out.append({
            "id": j.id,
            "date": j.scheduled_date.isoformat(),
            "start_time": _fmt_time(j.start_time),
            "end_time": _fmt_time(j.end_time),
            "title": j.title,
            "property_name": j.property.name if j.property else None,
            "status": j.status,
            "mine": mine,
            "cleaners": sorted(names.get(str(c), str(c)) for c in (j.cleaner_ids or [])),
        })
    return {"year": year, "month": month, "see_all": see_all, "jobs": out}


# ── Personal calendar feed (subscribe from Google/Apple Calendar) ────────────
# A read-only PROJECTION by construction: calendar apps PULL the .ics; we
# never write to anyone's calendar, store no OAuth tokens, and run no sync
# tick (scheduling-invariants R1/R2 clean). The token is the whole auth —
# unguessable, per-user, revocable by rotation.

def _ensure_calendar_token(db: Session, user_id: int) -> str:
    # Always write through a freshly-fetched row — the auth dependency's
    # object may be detached (or a test double).
    row = db.query(User).filter(User.id == user_id).first()
    if not row.calendar_token:
        import secrets
        row.calendar_token = secrets.token_urlsafe(24)
        db.commit(); db.refresh(row)
    return row.calendar_token


@router.get("/me/calendar-link")
def get_calendar_link(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """The caller's personal feed URL (token minted on first ask)."""
    _require_crew_id(current_user)
    token = _ensure_calendar_token(db, current_user.id)
    from config import app_base_url
    return {"url": f"{app_base_url().rstrip('/')}/api/crew-cal/{token}.ics"}


@router.post("/me/calendar-link/rotate")
def rotate_calendar_link(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """New secret, old URL dead — for a lost phone or an over-shared link."""
    _require_crew_id(current_user)
    import secrets
    row = db.query(User).filter(User.id == current_user.id).first()
    row.calendar_token = secrets.token_urlsafe(24)
    db.commit()
    from config import app_base_url
    return {"url": f"{app_base_url().rstrip('/')}/api/crew-cal/{row.calendar_token}.ics"}


def _ics_escape(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _ics_utc(d: date, t) -> str:
    """Business-local date+time → UTC ICS stamp (DST handled by zoneinfo)."""
    local = datetime.combine(d, t, tzinfo=business_tz())
    return local.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# Public sub-router mounted at /api/crew-cal (auth exempt — calendar apps
# can't send headers; the token IS the credential).
public_calendar_router = APIRouter()


@public_calendar_router.get("/{token}.ics")
def personal_ics_feed(token: str, db: Session = Depends(get_db)):
    """The subscribed feed: this cleaner's jobs, -7 to +60 days.

    Deliberately NO door codes, access notes, or office notes — people share
    calendars, and a feed URL forwards. Details live in the app.
    """
    token = (token or "").strip()
    user = (db.query(User)
            .filter(User.calendar_token == token, User.cleaner_id.isnot(None))
            .first()) if len(token) >= 16 else None
    if not user or not getattr(user, "active", True):
        raise HTTPException(status_code=404, detail="Unknown calendar.")

    today = business_today()
    jobs = (db.query(Job)
            .options(joinedload(Job.property))
            .filter(or_(Job.org_id == user.org_id, Job.org_id.is_(None)),  # MT-2 scope
                    Job.scheduled_date >= today - timedelta(days=7),
                    Job.scheduled_date <= today + timedelta(days=60),
                    Job.status.notin_(("cancelled",)))
            .all())
    mine = [j for j in jobs if user.cleaner_id in (j.cleaner_ids or [])]

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//BrightBase//Crew Schedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_ics_escape('Work — The Maine Cleaning Co.')}",
    ]
    for j in mine:
        where = (j.property.name if j.property else None) or j.title
        addr = (j.property.address if j.property else None) or (j.address or "")
        stamp = (j.updated_at or j.created_at)
        lines += [
            "BEGIN:VEVENT",
            f"UID:job-{j.id}@brightbase",
            f"DTSTAMP:{stamp.strftime('%Y%m%dT%H%M%SZ') if stamp else '19700101T000000Z'}",
            f"SUMMARY:{_ics_escape(f'Clean — {where}')}",
        ]
        if j.start_time:
            lines.append(f"DTSTART:{_ics_utc(j.scheduled_date, j.start_time)}")
            lines.append(f"DTEND:{_ics_utc(j.scheduled_date, j.end_time or j.start_time)}")
        else:
            lines.append(f"DTSTART;VALUE=DATE:{j.scheduled_date.strftime('%Y%m%d')}")
        if addr:
            lines.append(f"LOCATION:{_ics_escape(addr)}")
        lines.append(f"DESCRIPTION:{_ics_escape('Details, door codes and checklists are in BrightBase.')}")
        if j.status == "completed":
            lines.append("STATUS:CONFIRMED")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    body = "\r\n".join(lines) + "\r\n"
    return Response(content=body, media_type="text/calendar",
                    headers={"Cache-Control": "private, max-age=300"})


# ── Time-off requests (crew-submitted, office-approved) ──────────────────────

class TimeOffRequestBody(BaseModel):
    start_date: str
    end_date: str
    reason: Optional[str] = None


@router.get("/me/time-off")
def my_time_off(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """The caller's own entries — approved, requested, and denied — newest
    range first, so the Me tab can show request history with status chips."""
    _require_crew_id(current_user)
    rows = (db.query(CleanerTimeOff)
            .filter(CleanerTimeOff.cleaner_id == current_user.cleaner_id,
                    CleanerTimeOff.end_date >= business_today() - timedelta(days=30))
            .order_by(CleanerTimeOff.start_date.desc())
            .all())
    return [{
        "id": t.id,
        "start_date": t.start_date.isoformat(),
        "end_date": t.end_date.isoformat(),
        "reason": t.reason,
        "status": getattr(t, "status", None) or "approved",
    } for t in rows]


@router.post("/me/time-off", status_code=201)
def request_time_off(
    body: TimeOffRequestBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Submit a time-off REQUEST. It lands status='requested' — visible to
    the office (push + Availability panel) but it does NOT count as off
    anywhere until approved. Same-week emergencies are still a phone call;
    this is for planning ahead."""
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    start, end = _to_date(body.start_date), _to_date(body.end_date)
    if start is None or end is None:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD.")
    if end < start:
        raise HTTPException(status_code=422, detail="End date must be on or after the start.")
    if start < business_today():
        raise HTTPException(status_code=422, detail="Time off starts today or later.")
    if (end - start).days > 60:
        raise HTTPException(status_code=422, detail="That's more than 60 days — talk to the office directly.")
    reason = _sanitize_note(body.reason)
    who = getattr(current_user, "full_name", None) or current_user.email
    row = CleanerTimeOff(
        org_id=oid, cleaner_id=current_user.cleaner_id, cleaner_name=who,
        start_date=start, end_date=end, reason=reason,
        status="requested", requested_by_user_id=current_user.id,
    )
    db.add(row); db.commit(); db.refresh(row)
    try:
        from services.push_service import notify_staff
        rng = start.isoformat() if start == end else f"{start.isoformat()} – {end.isoformat()}"
        notify_staff(
            db, "Time-off request",
            f"{who} asked for {rng}" + (f': "{reason}"' if reason else "") + ". Approve or deny in Schedule → time off.",
            url="/schedule?tab=availability", tag=f"timeoff-req-{row.id}", org_id=oid,
            category="crew",
        )
    except Exception:
        log.exception("push notify failed on request_time_off")
    return {"id": row.id, "status": "requested"}


@router.delete("/me/time-off/{entry_id}")
def cancel_time_off_request(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """Withdraw your own PENDING request. Approved time off belongs to the
    office's calendar — changing that is a conversation, not a tap."""
    _require_crew_id(current_user)
    row = (db.query(CleanerTimeOff)
           .filter(CleanerTimeOff.id == entry_id,
                   CleanerTimeOff.cleaner_id == current_user.cleaner_id)
           .first())
    if not row:
        raise HTTPException(status_code=404, detail="Request not found.")
    if (getattr(row, "status", None) or "approved") != "requested":
        raise HTTPException(status_code=409, detail="Only pending requests can be withdrawn — call the office.")
    db.delete(row); db.commit()
    return {"ok": True}


# ── Private notes (owner-only crew docs) ─────────────────────────────────────

def _my_doc_dict(d: CrewDoc) -> dict:
    return {"id": d.id, "title": d.title, "body": d.body or "",
            "updated_at": _iso_utc(d.updated_at)}


class MyDocBody(BaseModel):
    title: str
    body: str = ""


@router.get("/my-docs")
def list_my_docs(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """The caller's PRIVATE notes — owner-scoped rows nobody else lists,
    including the office."""
    rows = (db.query(CrewDoc)
            .filter(CrewDoc.owner_user_id == current_user.id)
            .order_by(CrewDoc.updated_at.desc())
            .all())
    return [_my_doc_dict(d) for d in rows]


@router.post("/my-docs", status_code=201)
def create_my_doc(
    body: MyDocBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    title = (body.title or "").strip()[:200]
    if not title:
        raise HTTPException(status_code=422, detail="Title is required.")
    d = CrewDoc(org_id=resolve_org_id(org_id, db), owner_user_id=current_user.id,
                title=title, body=(body.body or "").replace("\r\n", "\n").strip()[:20000],
                category="other", pinned=False, published=False,
                created_at=_now_naive_utc(), updated_at=_now_naive_utc())
    db.add(d); db.commit(); db.refresh(d)
    return _my_doc_dict(d)


@router.patch("/my-docs/{doc_id}")
def update_my_doc(
    doc_id: int,
    body: MyDocBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    d = db.query(CrewDoc).filter(CrewDoc.id == doc_id,
                                 CrewDoc.owner_user_id == current_user.id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Note not found.")
    title = (body.title or "").strip()[:200]
    if not title:
        raise HTTPException(status_code=422, detail="Title is required.")
    d.title = title
    d.body = (body.body or "").replace("\r\n", "\n").strip()[:20000]
    d.updated_at = _now_naive_utc()
    db.commit(); db.refresh(d)
    return _my_doc_dict(d)


@router.delete("/my-docs/{doc_id}")
def delete_my_doc(
    doc_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    n = (db.query(CrewDoc)
         .filter(CrewDoc.id == doc_id, CrewDoc.owner_user_id == current_user.id)
         .delete(synchronize_session=False))
    db.commit()
    if not n:
        raise HTTPException(status_code=404, detail="Note not found.")
    return {"ok": True}


# ── Office chat (one thread per cleaner) ─────────────────────────────────────

def _msg_dict(m: CrewMessage) -> dict:
    return {"id": m.id, "sender": m.sender, "sender_name": m.sender_name,
            "body": m.body, "created_at": _iso_utc(m.created_at)}


class MessageBody(BaseModel):
    body: str


@router.get("/messages")
def my_messages(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """The caller's thread with the office (oldest first). Loading it marks
    the office's messages read."""
    rows = (db.query(CrewMessage)
            .filter(CrewMessage.user_id == current_user.id)
            .order_by(CrewMessage.created_at.asc())
            .limit(200).all())
    now = _now_naive_utc()
    dirty = False
    for m in rows:
        if m.sender == "office" and m.read_at is None:
            m.read_at = now; dirty = True
    if dirty:
        db.commit()
    return [_msg_dict(m) for m in rows]


@router.post("/messages", status_code=201)
def send_message_to_office(
    body: MessageBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    text = _sanitize_note(body.body)
    if not text:
        raise HTTPException(status_code=422, detail="Say something first.")
    who = getattr(current_user, "full_name", None) or current_user.email
    m = CrewMessage(org_id=resolve_org_id(org_id, db), user_id=current_user.id,
                    sender="cleaner", sender_name=who, body=text,
                    created_at=_now_naive_utc())
    db.add(m); db.commit(); db.refresh(m)
    try:
        from services.push_service import notify_staff
        notify_staff(db, f"Message from {who}",
                     text if len(text) <= 120 else text[:117] + "…",
                     url="/crew", tag=f"crew-msg-{current_user.id}",
                     org_id=m.org_id, category="crew")
    except Exception:
        log.exception("push notify failed on send_message_to_office")
    return _msg_dict(m)


# Office side of the same thread — read/send per cleaner (Messages page Crew
# view + the Crew page drawer), the whole roster as a thread list, and a
# one-shot broadcast that fans a single message out to many threads.

@router.get("/threads", dependencies=[Depends(require_role("admin", "manager"))])
def office_crew_threads(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Every cleaner's office thread in one list for the Messages page's Crew
    view — last-message preview, unread-from-cleaner count, newest activity
    first (cleaners with no thread yet sort last, alphabetically), so the
    office sees at a glance who's waiting on a reply."""
    oid = resolve_org_id(org_id, db)
    cleaners = (db.query(User)
                .filter(User.role == "cleaner",
                        or_(User.org_id == oid, User.org_id.is_(None)))
                .all())
    ids = [u.id for u in cleaners]
    last_by_user: dict = {}
    unread_by_user: dict = {}
    if ids:
        # Newest message per thread via MAX(id) (ids are monotonic with insert
        # order) — one grouped query + one fetch, same pattern as the comms
        # inbox previews.
        max_ids = [mid for (mid,) in
                   db.query(func.max(CrewMessage.id))
                     .filter(CrewMessage.user_id.in_(ids))
                     .group_by(CrewMessage.user_id).all()]
        if max_ids:
            for m in db.query(CrewMessage).filter(CrewMessage.id.in_(max_ids)).all():
                last_by_user[m.user_id] = m
        unread_by_user = dict(
            db.query(CrewMessage.user_id, func.count(CrewMessage.id))
              .filter(CrewMessage.user_id.in_(ids),
                      CrewMessage.sender == "cleaner",
                      CrewMessage.read_at.is_(None))
              .group_by(CrewMessage.user_id).all())
    rows = []
    for u in cleaners:
        last = last_by_user.get(u.id)
        rows.append({
            "user_id": u.id,
            "name": u.full_name or u.email,
            "email": u.email,
            "status": u.status or "active",
            "unread": int(unread_by_user.get(u.id, 0)),
            "last_message": _msg_dict(last) if last else None,
            "last_activity": _iso_utc(last.created_at) if last else None,
        })
    active = sorted([r for r in rows if r["last_activity"]],
                    key=lambda r: r["last_activity"], reverse=True)
    empty = sorted([r for r in rows if not r["last_activity"]],
                   key=lambda r: (r["name"] or "").lower())
    return active + empty


class BroadcastBody(BaseModel):
    body: str
    # Narrow the fan-out; omitted/empty = every non-disabled cleaner.
    user_ids: Optional[List[int]] = None


# NOTE: registered before POST /messages/{user_id} below — FastAPI matches in
# registration order, and the path-param route would otherwise eat "broadcast".
@router.post("/messages/broadcast", status_code=201)
def office_broadcast(
    body: BroadcastBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("admin", "manager")),
):
    """One message to many cleaners at once ("park behind the shop today") —
    each copy lands in that cleaner's normal office thread and pushes to their
    phone exactly like a 1:1 office reply; the crew side needs nothing new."""
    text = _sanitize_note(body.body)
    if not text:
        raise HTTPException(status_code=422, detail="Say something first.")
    oid = resolve_org_id(org_id, db)
    q = (db.query(User)
         .filter(User.role == "cleaner",
                 or_(User.org_id == oid, User.org_id.is_(None)),
                 or_(User.status.is_(None), User.status != "disabled")))
    if body.user_ids:
        q = q.filter(User.id.in_(body.user_ids))
    targets = q.all()
    if not targets:
        raise HTTPException(status_code=404, detail="No cleaners to send to.")
    who = getattr(current_user, "full_name", None) or current_user.email
    now = _now_naive_utc()
    for u in targets:
        db.add(CrewMessage(org_id=oid, user_id=u.id, sender="office",
                           sender_name=who, body=text, created_at=now))
    db.commit()
    try:
        from services.push_service import notify_user
        for u in targets:
            notify_user(u.id, "Message from the office",
                        text if len(text) <= 120 else text[:117] + "…",
                        url="/my-day", tag=f"office-msg-{u.id}",
                        category="office_messages")
    except Exception:
        log.exception("push notify failed on office_broadcast")
    return {"sent": len(targets), "user_ids": [u.id for u in targets]}


@router.get("/messages/{user_id}", dependencies=[Depends(require_role("admin", "manager"))])
def office_thread(user_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    oid = resolve_org_id(org_id, db)
    rows = (db.query(CrewMessage)
            .filter(CrewMessage.user_id == user_id,
                    or_(CrewMessage.org_id == oid, CrewMessage.org_id.is_(None)))
            .order_by(CrewMessage.created_at.asc())
            .limit(200).all())
    now = _now_naive_utc()
    dirty = False
    for m in rows:
        if m.sender == "cleaner" and m.read_at is None:
            m.read_at = now; dirty = True
    if dirty:
        db.commit()
    return [_msg_dict(m) for m in rows]


@router.post("/messages/{user_id}", status_code=201)
def office_reply(
    user_id: int,
    body: MessageBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("admin", "manager")),
):
    text = _sanitize_note(body.body)
    if not text:
        raise HTTPException(status_code=422, detail="Say something first.")
    target = db.query(User).filter(User.id == user_id, User.role == "cleaner").first()
    if not target:
        raise HTTPException(status_code=404, detail="Cleaner not found.")
    who = getattr(current_user, "full_name", None) or current_user.email
    m = CrewMessage(org_id=resolve_org_id(org_id, db), user_id=user_id,
                    sender="office", sender_name=who, body=text,
                    created_at=_now_naive_utc())
    db.add(m); db.commit(); db.refresh(m)
    try:
        from services.push_service import notify_user
        notify_user(user_id, "Message from the office",
                    text if len(text) <= 120 else text[:117] + "…",
                    url="/my-day", tag=f"office-msg-{user_id}",
                    category="office_messages")
    except Exception:
        log.exception("push notify failed on office_reply")
    return _msg_dict(m)


# ── Structured client texts (no numbers on crew phones) ──────────────────────
# The owner's updated call (Aug 2026, reversing Phase 1): crew never see the
# customer's number. Instead they send TEMPLATED texts from the BUSINESS
# number — logged in the same comms conversation the office reads — with an
# optional short personal line.

TEXT_TEMPLATES = ("on_the_way", "tomorrow")


class ClientTextBody(BaseModel):
    template: str
    note: Optional[str] = None      # one personal sentence, clamped


def _compose_client_text(template: str, job: Job, cleaner_name: str, note: "str | None") -> str:
    from config import DEFAULT_COMPANY_NAME
    import os
    company = os.getenv("COMPANY_NAME", DEFAULT_COMPANY_NAME)
    client_first = ((job.client.name if job.client else "") or "").strip().split(" ")[0]
    hi = f"Hi {client_first}! " if client_first else "Hi! "
    if template == "on_the_way":
        msg = f"{hi}{cleaner_name} from {company} is on the way now. See you soon!"
    else:
        # Customer-facing 12-hour time ("1 PM"), not the app's 24h format.
        t = job.start_time
        when = ((f"{t.hour % 12 or 12}:{t.minute:02d} " if t.minute else f"{t.hour % 12 or 12} ")
                + ("AM" if t.hour < 12 else "PM")) if t else "as scheduled"
        msg = (f"{hi}A friendly reminder — {company} will be there tomorrow at {when}. "
               f"Looking forward to it!")
    if note:
        msg += f" {note}"
    msg += " Reply here if you need anything."
    return msg


@router.post("/jobs/{job_id}/notify-client")
def text_client(
    job_id: int,
    body: ClientTextBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Send one structured text to the job's client, from the business number.

    Guardrails: assigned-only; template vocabulary fixed; "on the way" only
    on the job's day, "tomorrow" only the day before; ONE send per (job,
    template) — the guard is the activity log, which also gives the office
    the paper trail; the personal line is sanitized and clamped to 160 chars
    and always rides inside the template, never instead of it.
    """
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    template = (body.template or "").strip().lower()
    if template not in TEXT_TEMPLATES:
        raise HTTPException(status_code=422, detail="Unknown message type.")

    job = (db.query(Job)
           .options(joinedload(Job.client), joinedload(Job.property))
           .filter(or_(Job.org_id == oid, Job.org_id.is_(None)), Job.id == job_id)
           .first())
    if not job or current_user.cleaner_id not in (job.cleaner_ids or []):
        raise HTTPException(status_code=404, detail="Job not found.")
    phone = ((job.client.phone if job.client else "") or "").strip()
    if not phone:
        raise HTTPException(status_code=409, detail="This client has no phone on file — tell the office.")

    today = business_today()
    if template == "on_the_way" and job.scheduled_date != today:
        raise HTTPException(status_code=409, detail='"On the way" only works on the day of the job.')
    if template == "tomorrow" and job.scheduled_date != today + timedelta(days=1):
        raise HTTPException(status_code=409, detail="That job isn't tomorrow.")

    from database.models import Activity
    already = db.query(Activity).filter(
        Activity.job_id == job.id,
        Activity.activity_type == "crew_client_text",
    ).all()
    if any((a.extra_data or {}).get("template") == template for a in already):
        raise HTTPException(status_code=409, detail="That message was already sent for this job.")

    note = _sanitize_note(body.note)
    if note:
        note = note[:160]
    who_first = ((getattr(current_user, "full_name", None) or "").strip().split(" ")[0]
                 or "Your cleaner")
    msg_body = _compose_client_text(template, job, who_first, note)

    from integrations.twilio_client import send_sms
    from modules.comms.router import (
        _normalize_contact, find_or_create_conversation, _apply_outbound,
    )
    from database.models import Message
    to = _normalize_contact(phone)
    try:
        result = send_sms(to=to, body=msg_body)
    except ValueError as e:
        raise HTTPException(status_code=409, detail="Texting isn't set up yet — tell the office.")
    except Exception:
        log.exception("crew client text failed")
        raise HTTPException(status_code=502, detail="Couldn't send right now — try again or call the office.")

    # Log into the same conversation thread the office reads, then the job
    # timeline (which is also the once-per-template guard).
    try:
        import os
        conv = find_or_create_conversation(db, channel="sms", client_id=job.client_id,
                                           external_contact=to, org_id=oid)
        m = Message(client_id=job.client_id, conversation_id=conv.id, channel="sms",
                    direction="outbound",
                    from_addr=_normalize_contact(os.getenv("TWILIO_PHONE_NUMBER", "")),
                    to_addr=to, body=msg_body,
                    status=result.get("status", "sent"), external_id=result.get("sid"),
                    org_id=oid)  # BB-MT-01
        db.add(m); db.flush()
        _apply_outbound(conv, m)
        from utils.activity_logger import log_activity
        log_activity(db, "crew_client_text", job_id=job.id, client_id=job.client_id,
                     actor=who_first,
                     summary=f"{who_first} texted the client ({'on the way' if template == 'on_the_way' else 'tomorrow reminder'})",
                     extra_data={"template": template, "sid": result.get("sid")})
        db.commit()
    except Exception:
        log.exception("crew client text sent (sid=%s) but logging failed", result.get("sid"))
        try:
            db.rollback()
        except Exception:
            pass
    return {"sent": True, "preview": msg_body}


# ── Ask (grounded crew assistant) ────────────────────────────────────────────
# A quiet Q&A box in the Learn tab — NOT a floating widget (owner: "no AI
# badges get in the way"). Answers come ONLY from what this cleaner can
# already see: their own jobs (with codes/wifi/house notes), published
# company docs, their private notes, today's weather. The context is built
# server-side from the same queries the crew endpoints use, so the model
# can never be tricked into fetching someone else's data — there's nothing
# else in the prompt to leak.

ASK_SYSTEM = """You are the in-app helper inside a cleaning company's crew app.
The person asking is a cleaner on the crew, often on a phone, sometimes mid-job.

Rules:
- Answer ONLY from the CONTEXT below. If the answer isn't there, say you
  don't have it and point them to the right place: schedule/job questions →
  the office (Me tab → Message the office); how-to questions → the Learn tab
  guides.
- Be brief and concrete — a phone answer, not an essay. Bullet lists only
  when listing jobs.
- NEVER invent addresses, times, or prices. Quote them exactly from the
  context or say you don't have them.
- You do NOT have door codes, access notes, or WiFi passwords, even for the
  cleaner's own jobs — that's by design. If asked, say those are on the job
  card (tap the job in Today/Schedule) and never guess or make one up.
- Do not discuss pay rates, other cleaners' schedules beyond names shown,
  or anything not in the context."""


def build_ask_context(db: Session, current_user: User) -> str:
    """Everything THIS cleaner may see, as one prompt block. Pure read;
    capped so the request stays fast on a phone connection."""
    today = business_today()
    parts = [f"Today is {today.strftime('%A, %B %d, %Y')}.",
             f"The cleaner's name is {getattr(current_user, 'full_name', None) or current_user.email}."]

    org_scope = or_(Job.org_id == current_user.org_id, Job.org_id.is_(None))
    jobs = (db.query(Job)
            .options(joinedload(Job.property), joinedload(Job.client))
            .filter(org_scope,
                    Job.scheduled_date >= today,
                    Job.scheduled_date <= today + timedelta(days=14),
                    Job.status.notin_(("cancelled",)))
            .order_by(Job.scheduled_date, Job.start_time)
            .all())
    mine = [j for j in jobs if current_user.cleaner_id in (j.cleaner_ids or [])]
    names = _names_by_cleaner_id(db, mine)
    house_notes = _shared_notes_by_property(db, mine)
    if mine:
        parts.append("THEIR JOBS (next 14 days):")
        for j in mine[:30]:
            r = _job_row(j, names, current_user.cleaner_id,
                         house_notes=house_notes.get(j.property_id))
            has_access_details = bool(r['house_code'] or r['access_notes'] or r['wifi_ssid'])
            line = (f"- {r['scheduled_date']} {r['start_time'] or ''}-{r['end_time'] or ''} "
                    f"{r['property_name'] or r['title']} at {r['address'] or 'address TBD'}."
                    f" Client: {r['client_name'] or 'n/a'}."
                    # Door code / access notes / WiFi password are deliberately
                    # NOT included here (BB-SEC-08..12: access details never
                    # ride an AI prompt, only /api/crew/* to the assigned
                    # cleaner). Just a flag so the assistant can point back to
                    # the job card instead of claiming there's nothing there.
                    + (" (access details are on the job card)" if has_access_details else "")
                    + (f" Teammates: {', '.join(r['teammates'])}." if r['teammates'] else "")
                    + (f" Office notes: {r['notes']}" if r['notes'] else "")
                    + ((" House notes: " + " | ".join(n['body'] for n in r['house_notes']))
                       if r['house_notes'] else ""))
            parts.append(line)
    else:
        parts.append("THEIR JOBS: none scheduled in the next 14 days.")

    docs = (db.query(CrewDoc)
            .filter(or_(CrewDoc.org_id == current_user.org_id, CrewDoc.org_id.is_(None)),
                    CrewDoc.published.is_(True), CrewDoc.owner_user_id.is_(None))
            .order_by(CrewDoc.pinned.desc(), CrewDoc.updated_at.desc())
            .limit(20).all())
    if docs:
        parts.append("COMPANY GUIDES:")
        budget = 9000
        for d in docs:
            body = (d.body or "")[:1200]
            if budget - len(body) < 0:
                break
            budget -= len(body)
            parts.append(f"## {d.title}\n{body}")

    notes = (db.query(CrewDoc)
             .filter(CrewDoc.owner_user_id == current_user.id)
             .order_by(CrewDoc.updated_at.desc()).limit(10).all())
    if notes:
        parts.append("THEIR PRIVATE NOTES:")
        for n in notes:
            parts.append(f"## {n.title}\n{(n.body or '')[:600]}")

    try:
        wx = _WEATHER_CACHE.get("data")
        if wx and wx.get("available"):
            parts.append(f"WEATHER today: {wx['temp_f']}°F now, high {wx['high_f']}°F, "
                         f"{wx.get('summary', '')}, {wx.get('precip_chance', 0)}% precip chance.")
    except Exception:
        pass

    return "\n".join(parts)


class AskBody(BaseModel):
    question: str
    history: Optional[list] = None    # [{role: 'user'|'assistant', content: str}]


@router.post("/ask")
def crew_ask(
    body: AskBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    _require_crew_id(current_user)
    q = (body.question or "").strip()
    if not q:
        raise HTTPException(status_code=422, detail="Ask something first.")
    if len(q) > 500:
        raise HTTPException(status_code=422, detail="Keep it under 500 characters.")

    from modules.ai.router import _anthropic_client
    client = _anthropic_client()
    if client is None:
        raise HTTPException(status_code=409,
                            detail="The helper isn't set up yet — message the office instead.")

    context = build_ask_context(db, current_user)
    messages = []
    for h in (body.history or [])[-6:]:
        role = h.get("role") if isinstance(h, dict) else None
        content = (h.get("content") or "").strip()[:1000] if isinstance(h, dict) else ""
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": q})

    import os
    model = os.getenv("CREW_ASSISTANT_MODEL", "claude-haiku-4-5-20251001")
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=500,
            system=f"{ASK_SYSTEM}\n\nCONTEXT:\n{context}",
            messages=messages,
        )
        answer = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    except Exception:
        log.exception("crew ask failed")
        raise HTTPException(status_code=502,
                            detail="The helper couldn't answer right now — try again or message the office.")
    return {"answer": answer or "I don't have that — try messaging the office from the Me tab."}


# ── Training / docs library, read side (crew app Phase 5) ────────────────────

@router.get("/docs")
def list_crew_docs(
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Published docs only, pinned first then freshest — the Learn tab's feed.
    Office drafts (published=False) never reach a phone."""
    oid = resolve_org_id(org_id, db)
    rows = (db.query(CrewDoc)
            .filter(or_(CrewDoc.org_id == oid, CrewDoc.org_id.is_(None)),
                    CrewDoc.published.is_(True),
                    CrewDoc.owner_user_id.is_(None))   # company docs only here
            .order_by(CrewDoc.pinned.desc(), CrewDoc.updated_at.desc())
            .all())
    return [
        {
            "id": d.id,
            "title": d.title,
            "body": d.body or "",
            "url": d.url,
            "category": d.category or "other",
            "pinned": bool(d.pinned),
            "updated_at": _iso_utc(d.updated_at),
        }
        for d in rows
    ]


# ── Weekly availability (crew app Phase 4) ───────────────────────────────────
# The recurring shape of a cleaner's week — per day, AM / PM / Off (owner
# decision #3). A SIGNAL for the office's assign surfaces, never a block;
# one-off absences stay in CleanerTimeOff. Empty week {} = available never
# — distinct from "no row" = never set a pattern (unknown).

_WEEK_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_SLOTS = ("am", "pm")


def _normalize_week(raw) -> dict:
    """Clamp arbitrary input to the canonical shape: every day present, each
    a sorted subset of ["am","pm"]. Unknown days/slots are dropped, never an
    error — availability must be un-messupable from a phone."""
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for day in _WEEK_DAYS:
        slots = raw.get(day)
        slots = slots if isinstance(slots, (list, tuple)) else []
        out[day] = [s for s in _DAY_SLOTS
                    if any(str(x).strip().lower() == s for x in slots)]
    return out


class AvailabilityBody(BaseModel):
    week: dict


# How many future weeks a cleaner can plan ahead — matches the recurring
# generator's default horizon (generate_weeks_ahead=8), the furthest the
# office actually materializes jobs.
WEEKS_AHEAD = 8


@router.get("/me/availability")
def get_my_availability(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """The caller's availability picture in ONE fetch (the Me tab's rule):

    - week / updated_at: the recurring "usual week" template (back-compat
      keys; None when never set).
    - current_week_start: this week's Monday per the BUSINESS clock — the
      phone's own clock is never trusted for lock math.
    - weeks[]: current week + the next WEEKS_AHEAD, each {week_start,
      week|null, source: "set"|"template", locked, updated_at}. `week` is
      the explicit row only — null means the template applies. `locked` is
      computed server-side: the running week and the past are read-only.
    """
    _require_crew_id(current_user)
    template = (db.query(CleanerAvailability)
                .filter(CleanerAvailability.cleaner_id == current_user.cleaner_id)
                .first())
    this_monday = week_monday(business_today())
    mondays = [this_monday + timedelta(weeks=i) for i in range(WEEKS_AHEAD + 1)]
    rows = {r.week_start: r for r in db.query(CleanerWeekAvailability).filter(
        CleanerWeekAvailability.cleaner_id == current_user.cleaner_id,
        CleanerWeekAvailability.week_start.in_(mondays),
    ).all()}
    return {
        "week": _normalize_week(template.week) if template else None,
        "updated_at": _iso_utc(template.updated_at) if template else None,
        "current_week_start": this_monday.isoformat(),
        "weeks_ahead": WEEKS_AHEAD,
        "weeks": [
            {
                "week_start": m.isoformat(),
                "week": _normalize_week(rows[m].week) if m in rows else None,
                "source": "set" if m in rows else "template",
                "locked": m <= business_today(),
                "updated_at": _iso_utc(rows[m].updated_at) if m in rows else None,
            }
            for m in mondays
        ],
    }


@router.put("/me/availability")
def set_my_availability(
    body: AvailabilityBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Save the caller's weekly pattern (upsert, whole-week replace)."""
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    week = _normalize_week(body.week)
    row = (db.query(CleanerAvailability)
           .filter(CleanerAvailability.cleaner_id == current_user.cleaner_id)
           .first())
    if row:
        row.week = week
        row.updated_at = _now_naive_utc()
    else:
        row = CleanerAvailability(org_id=oid, cleaner_id=current_user.cleaner_id,
                                  week=week, updated_at=_now_naive_utc())
        db.add(row)
    db.commit(); db.refresh(row)
    return {"week": row.week, "updated_at": _iso_utc(row.updated_at)}


class WeekBody(BaseModel):
    week_start: str          # any date in the target week; server snaps to Monday
    week: dict


def _to_date(s: str) -> "date | None":
    try:
        return date.fromisoformat((s or "").strip())
    except (ValueError, AttributeError):
        return None


def _assert_week_editable(monday) -> None:
    """The lock (crew app Phase 4b): a week is writable only BEFORE it starts.

    Compared against business_today() in Python — never the phone clock, and
    never SQL CURRENT_DATE (the Railway box runs UTC and would lock Sunday
    evenings, the likeliest edit time, a night early). The 409 carries the
    first editable Monday so the UI can resync its lock display without doing
    its own timezone math.
    """
    today = business_today()
    if monday <= today:
        first_editable = week_monday(today) + timedelta(weeks=1)
        raise HTTPException(
            status_code=409,
            detail=f"That week is locked — the office schedules from it. "
                   f"Weeks from {first_editable.isoformat()} on are still open; "
                   f"for changes this week, contact the office.",
            headers={"X-First-Editable-Week": first_editable.isoformat()},
        )


def _uncovered_assignments(db: Session, oid: int, cleaner_id: str, monday, week: dict) -> list[dict]:
    """Jobs this cleaner is already assigned in [monday, monday+6] whose
    day/slot the new week no longer covers — the write-time contradiction
    check. Saving is allowed (the future stays theirs to plan), but both
    sides get told: the cleaner in the response, the office via push."""
    org_scope = or_(Job.org_id == oid, Job.org_id.is_(None))
    jobs = db.query(Job).filter(
        org_scope,
        Job.scheduled_date >= monday,
        Job.scheduled_date <= monday + timedelta(days=6),
        Job.status.in_(("scheduled", "in_progress")),
    ).all()
    out = []
    for j in jobs:
        if cleaner_id not in (j.cleaner_ids or []):
            continue
        slots = set(week.get(_WEEK_DAYS[j.scheduled_date.weekday()], []))
        needs = set()
        if j.start_time is not None or j.end_time is not None:
            if (j.start_time or j.end_time).hour < 12:
                needs.add("am")
            if (j.end_time or j.start_time).hour >= 12:
                needs.add("pm")
        else:
            needs = {"am", "pm"}
        if needs - slots:
            out.append({
                "job_id": j.id, "title": j.title,
                "scheduled_date": j.scheduled_date.isoformat(),
                "start_time": str(j.start_time)[:5] if j.start_time else None,
            })
    return out


@router.put("/me/availability/week")
def set_week_availability(
    body: WeekBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("cleaner")),
):
    """Save availability for ONE specific week (upsert, whole-week replace).

    week_start is snapped server-side to its Monday before both the lock
    check and the unique lookup — a client sending a mid-week date can
    neither dodge the lock nor strand a row where the resolver won't look.
    """
    _require_crew_id(current_user)
    oid = resolve_org_id(org_id, db)
    d = _to_date(body.week_start)
    if d is None:
        raise HTTPException(status_code=422, detail="week_start must be YYYY-MM-DD.")
    monday = week_monday(d)
    _assert_week_editable(monday)
    week = _normalize_week(body.week)

    row = (db.query(CleanerWeekAvailability)
           .filter(CleanerWeekAvailability.cleaner_id == current_user.cleaner_id,
                   CleanerWeekAvailability.week_start == monday)
           .first())
    if row:
        row.week = week
        row.updated_at = _now_naive_utc()
    else:
        row = CleanerWeekAvailability(org_id=oid, cleaner_id=current_user.cleaner_id,
                                      week_start=monday, week=week,
                                      updated_at=_now_naive_utc())
        db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Two devices racing on the first save of the same week — the unique
        # constraint caught the twin insert; re-apply as an update.
        db.rollback()
        row = (db.query(CleanerWeekAvailability)
               .filter(CleanerWeekAvailability.cleaner_id == current_user.cleaner_id,
                       CleanerWeekAvailability.week_start == monday)
               .first())
        row.week = week
        row.updated_at = _now_naive_utc()
        db.commit()
    db.refresh(row)

    # Contradiction check: the office may have ALREADY assigned this cleaner
    # in that week — a quiet flip would invalidate finished scheduling work.
    uncovered = _uncovered_assignments(db, oid, current_user.cleaner_id, monday, week)
    if uncovered:
        who = getattr(current_user, "full_name", None) or current_user.email
        try:
            from utils.activity_logger import log_activity
            for u in uncovered:
                log_activity(
                    db, "crew_availability_conflict", job_id=u["job_id"], actor=who,
                    summary=f"{who} set availability for week of {monday.isoformat()} "
                            f"that no longer covers {u['title']} ({u['scheduled_date']})",
                    extra_data={"cleaner_id": current_user.cleaner_id,
                                "week_start": monday.isoformat()},
                    commit=True,
                )
        except Exception:
            log.exception("activity log failed on set_week_availability")
        try:
            from services.push_service import notify_staff
            first = uncovered[0]
            more = f" (+{len(uncovered) - 1} more)" if len(uncovered) > 1 else ""
            notify_staff(
                db, "Availability change conflicts with the schedule",
                f"{who}'s week of {monday.isoformat()} no longer covers "
                f"{first['title']} on {first['scheduled_date']}{more} — check the assignment.",
                url=f"/jobs/{first['job_id']}",
                tag=f"avail-conflict-{current_user.cleaner_id}-{monday.isoformat()}",
                org_id=oid, category="crew",
            )
        except Exception:
            log.exception("push notify failed on set_week_availability")

    return {"week_start": monday.isoformat(), "week": row.week,
            "updated_at": _iso_utc(row.updated_at), "uncovered_jobs": uncovered}


@router.delete("/me/availability/week")
def clear_week_availability(
    week_start: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("cleaner")),
):
    """Revert a week to "use my usual week" (delete its explicit row).

    Same lock as writing — removing a locked week's row would change the
    stable picture the office is scheduling from just as surely as editing it.
    """
    _require_crew_id(current_user)
    d = _to_date(week_start)
    if d is None:
        raise HTTPException(status_code=422, detail="week_start must be YYYY-MM-DD.")
    monday = week_monday(d)
    _assert_week_editable(monday)
    (db.query(CleanerWeekAvailability)
     .filter(CleanerWeekAvailability.cleaner_id == current_user.cleaner_id,
             CleanerWeekAvailability.week_start == monday)
     .delete(synchronize_session=False))
    db.commit()
    return {"week_start": monday.isoformat(), "week": None, "source": "template"}


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
        # Drive-mileage source for Payroll (home → first job → between houses).
        # Editable from Settings → Users too (same PATCH /api/auth/users/{id}
        # field) — surfaced here so it isn't the one cleaner field that's only
        # reachable from a different page than the rest of their info.
        "home_address": u.home_address,
        "status": u.status or "active",
        # True once they've set a password (accepted the invite) or logged in.
        "activated": bool(u.password_hash) or u.last_login_at is not None,
        # Lead flag: their crew app shows the whole month schedule.
        "can_view_full_schedule": bool(getattr(u, "can_view_full_schedule", False)),
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
