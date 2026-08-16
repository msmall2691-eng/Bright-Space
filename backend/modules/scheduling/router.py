import logging
import os
import secrets
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, and_, func
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List, Union
from datetime import datetime, timezone, date, time, timedelta
from zoneinfo import ZoneInfo

from database.db import get_db
from database.models import (
    Job, Client, ICalEvent, CleanerTimeOff, Property, RecurrenceException, AppSetting,
)
from modules.auth.router import get_current_user, require_role, current_org_id, resolve_org_id
from utils.activity_logger import (
    log_job_created, log_job_status_change, log_calendar_event, log_activity
)
from utils.integration_log import log_integration_event as _log_integration
from utils.dates import business_today, coerce_time, coerce_date
from ratelimit import rate_limit

logger = logging.getLogger(__name__)
router = APIRouter()


class JobCreate(BaseModel):
    client_id: int
    title: str
    job_type: Optional[str] = "residential"  # "residential" | "deep_clean" | "commercial" | "str_turnover"
    pay_mode: Optional[str] = None            # native-payroll override: auto | hourly | piece
    pay_rate_bump: Optional[float] = None     # extra $/hr on top of hourly rates for this job
    scheduled_date: str       # YYYY-MM-DD
    start_time: str           # HH:MM
    end_time: str             # HH:MM
    address: Optional[str] = None
    quote_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    property_id: Optional[int] = None
    cleaner_ids: Optional[List[str]] = []
    notes: Optional[str] = None
    custom_fields: Optional[dict] = {}
    # When true, bypass the cleaner double-booking guard (intentional overlap).
    allow_conflicts: Optional[bool] = False


class JobUpdate(BaseModel):
    title: Optional[str] = None
    scheduled_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    address: Optional[str] = None
    cleaner_ids: Optional[List[str]] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = None
    # Every job field is editable after creation. property_id was always SENT
    # by the edit modal but never declared here, so pydantic silently dropped
    # it and property changes never saved.
    job_type: Optional[str] = None
    pay_mode: Optional[str] = None            # native-payroll override: auto | hourly | piece
    pay_rate_bump: Optional[float] = None     # extra $/hr on top of hourly rates for this job
    property_id: Optional[int] = None
    allow_conflicts: Optional[bool] = False
    # Per-move notification override for THIS edit (see update_job). None = fall
    # back to the Settings → Automation "email on move" toggle; True/False is an
    # explicit "do / don't email the customer about this reschedule" for one call.
    # Lets an operator nudge a job around the calendar silently (the default) but
    # still opt into telling the customer when a move actually matters to them.
    notify_customer: Optional[bool] = None
    # Crew app Phase 3: put the job "up for grabs" on every cleaner's phone
    # (claiming flips it back off atomically, crew router's /claim).
    open_for_claims: Optional[bool] = None

JOB_TYPES = {"residential", "deep_clean", "commercial", "str_turnover", "one_time"}
JOB_STATUSES = {"unscheduled", "scheduled", "in_progress", "completed", "cancelled"}
# Native-payroll per-job override (Job.pay_mode). "auto" = the automatic rule.
PAY_MODES = {"auto", "hourly", "piece"}


class BookingInfo(BaseModel):
    """Phase 5 turnover-enrichment payload — surfaces ICalEvent fields on
    str_turnover Job responses. All fields are optional so a partially-
    populated event still serializes cleanly."""
    uid: Optional[str] = None
    summary: Optional[str] = None
    guest_count: Optional[int] = None
    checkin_date: Optional[str] = None
    checkout_date: Optional[str] = None
    source: str


class JobResponse(BaseModel):
    """Phase 6 step 2: concrete response model for GET /api/jobs.

    Matches the dict returned by ``job_to_dict``. Adding this here makes the
    OpenAPI schema explicit so ``npm run gen:types`` produces a real
    ``Job`` type in the frontend instead of ``unknown``.
    """
    id: int
    client_id: Optional[int] = None
    client_name: str = ""
    quote_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    job_type: str
    property_id: Optional[int] = None
    # Denormalized property.name so Schedule / Dashboard / PropertyDetail can
    # render the property label without a second fetch (was on Visit responses;
    # ported here as part of the Job/Visit unification PR-B).
    property_name: Optional[str] = None
    recurring_schedule_id: Optional[int] = None
    calendar_invite_sent: Optional[bool] = None
    sms_reminder_sent: Optional[bool] = None
    skip_sms_reminder: Optional[bool] = None
    title: str
    scheduled_date: Optional[date] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    address: Optional[str] = None
    cleaner_ids: List[str] = []
    status: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: dict = {}
    dispatched: bool = False
    gcal_event_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    booking: Optional[BookingInfo] = None
    next_arrival: Optional[BookingInfo] = None
    is_immediate_turnover: bool = False
    # Tier 3 roadmap: hours between this turnover's scheduled end and the next
    # guest's check-in (property.check_in_time is the proxy — iCal feeds only
    # carry a check-in DATE, not a time); None when it can't be computed.
    turnover_lead_hours: Optional[float] = None
    turnover_lead_warning: bool = False


def _detect_booking_source(uid: str) -> str:
    """Best-effort identification of the booking platform from the iCal UID."""
    if not uid:
        return "iCal"
    low = uid.lower()
    if "airbnb" in low:
        return "Airbnb"
    if "vrbo" in low or "homeaway" in low:
        return "VRBO"
    if "hospitable" in low:
        return "Hospitable"
    if "guesty" in low:
        return "Guesty"
    if "booking.com" in low or "booking_com" in low:
        return "Booking.com"
    return "iCal"


def _booking_dict(event: Optional[ICalEvent]) -> Optional[dict]:
    """Serialize the subset of ICalEvent fields useful for a turnover Job card."""
    if not event:
        return None
    return {
        "uid": event.uid,
        "summary": event.summary,
        "guest_count": event.guest_count,
        "checkin_date": event.checkin_date,
        "checkout_date": event.checkout_date,
        "source": _detect_booking_source(event.uid),
    }


def _to_date(value):
    """Parse a 'YYYY-MM-DD' string (or pass through a date) → date | None.

    Thin wrapper over the shared utils.dates.coerce_date so every router coerces
    dates identically (coerce_date also normalizes a datetime to a date, which a
    bare isinstance check missed — a datetime never compares equal to a date)."""
    return coerce_date(value)


def _to_time(value):
    """Parse a 'HH:MM[:SS]' string (or pass through a time) → time | None.

    Thin wrapper over the shared utils.dates.coerce_time so the scheduling and
    recurring routers coerce times identically (they had drifted — see
    coerce_time)."""
    return coerce_time(value)


def _validate_job_timing(scheduled_date, start_time, end_time, *, is_new: bool):
    """Reject obviously-wrong timings before they reach the DB.

    - end before/equal start → invalid window
    - new jobs scheduled in the past → almost always a typo

    Past-date is only enforced on create: editing an old job (e.g. marking it
    completed) must stay allowed. Raises HTTPException(400) on failure.
    """
    d = _to_date(scheduled_date)
    st = _to_time(start_time)
    et = _to_time(end_time)
    if st is not None and et is not None and et <= st:
        raise HTTPException(
            status_code=400,
            detail=f"End time ({end_time}) must be after start time ({start_time}).",
        )
    if is_new and d is not None and d < business_today():
        raise HTTPException(
            status_code=400,
            detail=f"Cannot schedule a job in the past ({d.isoformat()}).",
        )


def _overlaps(a_start, a_end, b_start, b_end):
    """Simple interval overlap. Missing times treated as full-day (worst-
    case: assume they overlap so the operator gets a warning).

    Callers mix "HH:MM" strings (raw query params) and real `time` objects
    (Job.start_time/end_time, already deserialized by SQLAlchemy) — comparing
    a str to a time raises TypeError, so every input is coerced through
    _to_time first. This was a real, untested bug in the pre-existing
    cleaner_availability endpoint: it 500'd whenever start/end query params
    were supplied AND a genuinely conflicting same-day job existed — i.e.
    exactly the case the endpoint exists to detect."""
    a_start, a_end, b_start, b_end = _to_time(a_start), _to_time(a_end), _to_time(b_start), _to_time(b_end)
    if not a_start or not a_end or not b_start or not b_end:
        return True
    return not (a_end <= b_start or a_start >= b_end)


def _find_cleaner_conflicts(db: Session, *, cleaner_ids, scheduled_date,
                            start_time, end_time, exclude_job_id=None,
                            org_id=None):
    """Return [(cleaner_id, conflicting Job)] where a cleaner is already booked
    on an overlapping job the same day. Two intervals overlap iff
    start < other_end and end > other_start. Cancelled jobs don't count.

    When org_id is given, scopes to that tenant so a 409 detail can't leak
    another tenant's Job row (BB-SEC: cross-tenant scheduling leak)."""
    d = _to_date(scheduled_date)
    st = _to_time(start_time)
    et = _to_time(end_time)
    if not cleaner_ids or d is None or st is None or et is None:
        return []
    ids = {str(c) for c in cleaner_ids}

    same_day = (
        db.query(Job)
        .filter(
            Job.scheduled_date == d,
            Job.status.notin_(["cancelled"]),
            Job.cleaner_ids.isnot(None),
        )
    )
    if isinstance(org_id, int):
        same_day = same_day.filter(Job.org_id == org_id)
    if exclude_job_id is not None:
        same_day = same_day.filter(Job.id != exclude_job_id)

    conflicts = []
    for other in same_day.all():
        o_st = _to_time(other.start_time)
        o_et = _to_time(other.end_time)
        if o_st is None or o_et is None:
            continue
        if not (st < o_et and et > o_st):
            continue  # no time overlap
        shared = ids.intersection({str(c) for c in (other.cleaner_ids or [])})
        for cid in shared:
            conflicts.append((cid, other))
    return conflicts


def _conflict_detail(conflicts):
    """Human-readable 409 message for a list of (cleaner_id, Job) conflicts."""
    lines = []
    for cid, job in conflicts:
        when = ""
        if job.start_time and job.end_time:
            when = f" ({_to_time(job.start_time).strftime('%H:%M')}–{_to_time(job.end_time).strftime('%H:%M')})"
        lines.append(f"cleaner {cid} is already on Job #{job.id} \"{job.title}\"{when}")
    joined = "; ".join(lines)
    return (
        f"Scheduling conflict: {joined}. "
        "Re-assign, change the time, or resubmit with allow_conflicts=true to override."
    )


def _find_unavailable_cleaners(db: Session, *, cleaner_ids, scheduled_date, org_id=None):
    """Return [(cleaner_id, CleanerTimeOff)] for any assigned cleaner who has
    approved time off covering scheduled_date (inclusive range).

    When org_id is given, scopes to that tenant so a 409 detail can't leak
    another tenant's CleanerTimeOff row."""
    d = _to_date(scheduled_date)
    if not cleaner_ids or d is None:
        return []
    ids = {str(c) for c in cleaner_ids}
    q = db.query(CleanerTimeOff).filter(
        CleanerTimeOff.cleaner_id.in_(ids),
        CleanerTimeOff.start_date <= d,
        CleanerTimeOff.end_date >= d,
        # Crew-submitted requests (migration 089) only count once APPROVED —
        # a pending ask must not block scheduling.
        CleanerTimeOff.status == "approved",
    )
    if isinstance(org_id, int):
        q = q.filter(CleanerTimeOff.org_id == org_id)
    rows = q.all()
    return [(r.cleaner_id, r) for r in rows]


def _unavailable_detail(unavailable):
    """Human-readable 409 message for time-off conflicts."""
    lines = []
    for cid, off in unavailable:
        who = off.cleaner_name or f"cleaner {cid}"
        reason = f" ({off.reason})" if off.reason else ""
        lines.append(f"{who} is off {off.start_date}–{off.end_date}{reason}")
    return (
        f"Cleaner unavailable: {'; '.join(lines)}. "
        "Re-assign, change the date, or resubmit with allow_conflicts=true to override."
    )


CAPACITY_PER_CLEANER_PER_DAY = int(os.getenv("MAX_JOBS_PER_CLEANER_PER_DAY", "0") or 0)


def _find_over_capacity(db: Session, *, cleaner_ids, scheduled_date,
                        exclude_job_id=None, org_id=None):
    """If MAX_JOBS_PER_CLEANER_PER_DAY > 0, return [(cleaner_id, count)] for any
    assigned cleaner who would exceed that many non-cancelled jobs on the day.
    Disabled (returns []) when the cap is 0/unset.

    When org_id is given, scopes to that tenant so the count doesn't include
    jobs from another tenant."""
    if CAPACITY_PER_CLEANER_PER_DAY <= 0:
        return []
    d = _to_date(scheduled_date)
    if not cleaner_ids or d is None:
        return []
    ids = {str(c) for c in cleaner_ids}
    q = db.query(Job).filter(
        Job.scheduled_date == d,
        Job.status.notin_(["cancelled"]),
        Job.cleaner_ids.isnot(None),
    )
    if isinstance(org_id, int):
        q = q.filter(Job.org_id == org_id)
    if exclude_job_id is not None:
        q = q.filter(Job.id != exclude_job_id)
    counts = {cid: 0 for cid in ids}
    for other in q.all():
        for cid in ids.intersection({str(c) for c in (other.cleaner_ids or [])}):
            counts[cid] += 1
    # +1 for the job being created/updated.
    return [(cid, counts[cid] + 1) for cid in ids if counts[cid] + 1 > CAPACITY_PER_CLEANER_PER_DAY]


def _cleaner_roster(db: Session, org_id=None) -> list:
    """The pool of candidate cleaners: every distinct cleaner_id that appears on
    a non-cancelled job. Derived from real assignments so it needs no external
    roster call (Connecteam) and reflects who actually works turnovers.

    When org_id is an int, the roster is scoped to that tenant so one org's
    turnovers can't be assigned another org's cleaners (MT-2). org_id=None
    (the background scheduler) spans all orgs, matching prior behavior."""
    seen = []
    q = db.query(Job).filter(
        Job.status.notin_(["cancelled"]),
        Job.cleaner_ids.isnot(None),
    )
    if isinstance(org_id, int):
        q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))
    rows = q.all()
    for j in rows:
        for cid in (j.cleaner_ids or []):
            cid = str(cid)
            if cid and cid not in seen:
                seen.append(cid)
    return seen


def _day_load(db: Session, cleaner_id: str, d, org_id=None) -> int:
    """How many non-cancelled jobs the cleaner already has on day d.

    Scoped to org_id when an int (MT-2) so load-balancing counts only this
    tenant's jobs; org_id=None spans all orgs (background scheduler)."""
    n = 0
    q = db.query(Job).filter(
        Job.scheduled_date == d,
        Job.status.notin_(["cancelled"]),
        Job.cleaner_ids.isnot(None),
    )
    if isinstance(org_id, int):
        q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))
    for j in q.all():
        if str(cleaner_id) in {str(c) for c in (j.cleaner_ids or [])}:
            n += 1
    return n


def auto_assign_unassigned_turnovers(db: Session, *, dry_run: bool = False,
                                     limit: int = 100, org_id=None) -> dict:
    """Assign an available cleaner to upcoming, unassigned str_turnover jobs.

    For each such job, a candidate is eligible when — by the same rules the
    create/update guard enforces — they have no time-off covering the date, no
    overlapping job, and aren't over the daily cap. Among eligible candidates
    the least-loaded that day is chosen (simple load balancing). Jobs with no
    eligible candidate are left unassigned and reported.

    dry_run=True computes the picks without writing them (for a preview).

    org_id scopes every read/write to one tenant (MT-2) when it's an int: the
    endpoint passes the caller's org so a tenant admin can't read or reassign
    another org's jobs. org_id=None (the background scheduler) spans all orgs,
    preserving prior behavior."""
    today = business_today()
    roster = _cleaner_roster(db, org_id=org_id)
    q = db.query(Job).filter(
        Job.job_type == "str_turnover",
        Job.scheduled_date >= today,
        Job.status.notin_(["cancelled", "completed"]),
    )
    if isinstance(org_id, int):
        q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))
    jobs = q.order_by(Job.scheduled_date, Job.start_time).all()
    jobs = [j for j in jobs if not (j.cleaner_ids or [])][:limit]

    assigned, unassignable = [], []
    for job in jobs:
        d = _to_date(job.scheduled_date)
        best, best_load = None, None
        for cid in roster:
            # Reuse the create/update guard rules for eligibility.
            if _find_unavailable_cleaners(db, cleaner_ids=[cid], scheduled_date=d, org_id=org_id):
                continue
            if _find_cleaner_conflicts(db, cleaner_ids=[cid], scheduled_date=d,
                                       start_time=job.start_time, end_time=job.end_time,
                                       exclude_job_id=job.id, org_id=org_id):
                continue
            if _find_over_capacity(db, cleaner_ids=[cid], scheduled_date=d,
                                   exclude_job_id=job.id, org_id=org_id):
                continue
            load = _day_load(db, cid, d, org_id=org_id)
            if best is None or load < best_load:
                best, best_load = cid, load
        if best is None:
            unassignable.append({"job_id": job.id, "title": job.title,
                                 "date": str(job.scheduled_date)})
            continue
        assigned.append({"job_id": job.id, "title": job.title,
                         "date": str(job.scheduled_date), "cleaner_id": best})
        if not dry_run:
            job.cleaner_ids = [best]
            try:
                log_activity(db, "job_scheduled", job_id=job.id,
                             summary=f"Auto-assigned cleaner {best} to turnover {job.title}")
            except Exception:
                pass
    if not dry_run and assigned:
        db.commit()
        # Auto-assignment is still an assignment: the picked cleaner's phone
        # gets the same "new job for you" push as a manual assign (post-commit,
        # best-effort, no access details in the payload).
        try:
            from services.crew_notify import notify_job_assigned
            picked = {a["job_id"]: a["cleaner_id"] for a in assigned}
            for job in jobs:
                if job.id in picked:
                    notify_job_assigned(db, job, [picked[job.id]])
        except Exception:
            logger.warning("assignment push after auto-assign failed", exc_info=True)
    return {
        "dry_run": dry_run,
        "candidates": len(roster),
        "considered": len(jobs),
        "assigned": assigned,
        "unassignable": unassignable,
    }


def _turnover_lead_hours(j: Job, next_arrival: Optional[ICalEvent],
                          check_in_time: Optional[str] = None) -> Optional[float]:
    """Hours between this turnover job's scheduled end and the next guest's
    check-in. iCal feeds only carry a check-in DATE (no time), so the
    property's configured check_in_time stands in for "what time do they
    actually arrive" (default 16:00, the common STR standard, when unset).
    None when there isn't enough data to compute a real gap (no next
    arrival, or the job/property is missing a time).

    ``check_in_time`` lets bulk callers (get_jobs) pass a pre-fetched value
    instead of triggering a lazy-load of ``j.property`` per row; single-job
    callers can omit it and fall back to the relationship."""
    if next_arrival is None or not next_arrival.checkin_date or not j.end_time or not j.scheduled_date:
        return None
    if check_in_time is None:
        prop = getattr(j, "property", None)
        check_in_time = prop.check_in_time if prop else None
    checkin_time_str = check_in_time or "16:00"
    try:
        checkin_date = (next_arrival.checkin_date if isinstance(next_arrival.checkin_date, date)
                        else date.fromisoformat(str(next_arrival.checkin_date)))
        hh, mm = (int(x) for x in checkin_time_str.split(":")[:2])
        checkin_dt = datetime.combine(checkin_date, time(hh, mm))
        end_date = j.scheduled_date if isinstance(j.scheduled_date, date) else date.fromisoformat(str(j.scheduled_date))
        end_t = j.end_time if isinstance(j.end_time, time) else time.fromisoformat(str(j.end_time))
        end_dt = datetime.combine(end_date, end_t)
        return (checkin_dt - end_dt).total_seconds() / 3600
    except (ValueError, TypeError):
        return None


def job_to_dict(j: Job, client: Client = None, effective_date=None,
                booking_event: ICalEvent = None, next_arrival: ICalEvent = None,
                property_name: Optional[str] = None, lead_buffer_hours: float = 3.0,
                property_check_in_time: Optional[str] = None) -> dict:
    # Resolve client name if not passed in
    client_name = ""
    if client:
        client_name = client.name or ""
    elif j.client and hasattr(j, "client"):
        client_name = j.client.name if j.client else ""
    # Property name is optional at the caller: get_jobs bulk-fetches names into
    # a dict for perf; single-job endpoints fall back to the joined attr.
    if property_name is None and getattr(j, "property", None) is not None:
        property_name = j.property.name
    # `effective_date` used to be COALESCE(Job.scheduled_date, min Visit date);
    # after the Job/Visit unification (migration 039) Job.scheduled_date is the
    # single source. The kwarg is kept for callers that still pass an override.
    sched = effective_date if effective_date is not None else j.scheduled_date
    lead_hours = (_turnover_lead_hours(j, next_arrival, check_in_time=property_check_in_time)
                  if booking_event is not None else None)
    return {
        "id": j.id,
        "client_id": j.client_id,
        "client_name": client_name,
        "quote_id": j.quote_id,
        "opportunity_id": j.opportunity_id,
        "job_type": j.job_type or "residential",
        "pay_mode": j.pay_mode or "auto",
        "pay_rate_bump": j.pay_rate_bump,
        "property_id": j.property_id,
        "property_name": property_name,
        "recurring_schedule_id": j.recurring_schedule_id,
        "calendar_invite_sent": j.calendar_invite_sent,
        "sms_reminder_sent": j.sms_reminder_sent,
        "skip_sms_reminder": bool(j.skip_sms_reminder),
        "title": j.title,
        "scheduled_date": sched,
        "start_time": j.start_time,
        "end_time": j.end_time,
        "address": j.address,
        "cleaner_ids": j.cleaner_ids or [],
        "status": j.status,
        "notes": j.notes,
        # Completion state, so the office UI can show when/who marked a job
        # done and the note the cleaner left (kept off invoices by design).
        "completed_at": j.completed_at.isoformat() if j.completed_at else None,
        "completed_by": j.completed_by,
        "completion_note": j.completion_note,
        "custom_fields": j.custom_fields or {},
        "dispatched": bool(j.dispatched),
        # Crew app Phase 3: "up for grabs" flag the office toggles; claiming
        # flips it back off (crew router's /claim).
        "open_for_claims": bool(getattr(j, "open_for_claims", False)),
        "gcal_event_id": j.gcal_event_id,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "updated_at": j.updated_at.isoformat() if j.updated_at else None,
        # Customer-link state so the operator UI can badge a visit the customer
        # confirmed or asked to move (previously email-only — invisible in-app).
        "customer_confirmed_at": j.customer_confirmed_at.isoformat() if j.customer_confirmed_at else None,
        "reschedule_requested_at": j.reschedule_requested_at.isoformat() if j.reschedule_requested_at else None,
        "reschedule_request_message": j.reschedule_request_message,
        # A pending self-reschedule awaiting approval (busy-slot hold): the
        # requested date + scope so the badge can offer one-tap approve.
        "reschedule_requested_date": str(j.reschedule_requested_date) if j.reschedule_requested_date else None,
        "reschedule_requested_scope": j.reschedule_requested_scope,
        "is_recurring": bool(j.recurring_schedule_id),
        # Phase 5: booking enrichment for STR turnovers. Lazy-matched in
        # get_jobs() if the Job has no direct ical_event_id link.
        "booking": _booking_dict(booking_event) if booking_event else None,
        "next_arrival": _booking_dict(next_arrival) if next_arrival else None,
        "is_immediate_turnover": (
            booking_event is not None
            and next_arrival is not None
            and next_arrival.checkin_date == booking_event.checkout_date
        ),
        "turnover_lead_hours": lead_hours,
        "turnover_lead_warning": lead_hours is not None and lead_hours < lead_buffer_hours,
    }


def _job_booking_info(db: Session, j: Job):
    """Single-job counterpart to get_jobs()'s bulk booking/next-arrival match
    (lines ~611-648): finds the ICalEvent this str_turnover job's checkout
    corresponds to, and the next reservation's check-in at the same property
    (the pair job_to_dict needs for `booking`/`next_arrival`/
    `is_immediate_turnover`). get_jobs() bulk-fetches this per property to
    stay O(1) queries for a whole list; single-job endpoints (get_job,
    create_job, update_job) call this instead since they're already O(1) —
    they used to skip this entirely and silently return is_immediate_turnover
    always False.

    Returns (booking, next_arrival) — both None for non-turnover jobs, jobs
    with no property, or a turnover with no matching iCal reservation.
    """
    if j.job_type != "str_turnover" or not j.property_id:
        return None, None
    events = (
        db.query(ICalEvent)
          .filter(ICalEvent.property_id == j.property_id, ICalEvent.event_type == "reservation")
          .all()
    )
    events.sort(key=lambda e: e.checkin_date or "")
    booking = None
    if j.ical_event_id:
        booking = next((e for e in events if e.id == j.ical_event_id), None)
    if booking is None:
        iso = j.scheduled_date.isoformat() if hasattr(j.scheduled_date, "isoformat") \
            else (str(j.scheduled_date) if j.scheduled_date else None)
        booking = next((e for e in events if e.checkout_date == iso), None)
    next_arrival = None
    if booking is not None:
        next_arrival = next(
            (e for e in events if e.checkin_date and e.checkin_date >= booking.checkout_date
             and e.uid != booking.uid),
            None,
        )
    return booking, next_arrival


def _job_to_dict_enriched(db: Session, j: Job, **kwargs) -> dict:
    """job_to_dict() plus single-job booking enrichment — the wiring
    get_job/create_job/update_job/get_job_details need for a str_turnover
    job's `booking`/`next_arrival`/`is_immediate_turnover`/
    `turnover_lead_hours` to ever be populated outside the jobs list."""
    booking, next_arrival = _job_booking_info(db, j)
    kwargs.setdefault("lead_buffer_hours", _get_turnover_lead_buffer_hours(db))
    return job_to_dict(j, booking_event=booking, next_arrival=next_arrival, **kwargs)


def _get_turnover_lead_buffer_hours(db: Session) -> float:
    from modules.settings.router import turnover_lead_buffer_hours
    return turnover_lead_buffer_hours(db)


from typing import Annotated
from fastapi import Query as _Query   # local alias to keep the existing `date` name free


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_jobs(
    client_id: Optional[int] = None,
    property_id: Optional[int] = None,
    recurring_schedule_id: Optional[int] = None,
    status: Optional[str] = None,
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    job_type: Optional[str] = None,
    unassigned: Optional[bool] = None,
    # T-23: paginate + cap the response so no single request can hog a
    # worker. Annotated[int, Query(...)] gives us plain Python int
    # defaults (500 / 0) — so direct in-process callers get a working
    # SQLAlchemy `.offset(offset)` — AND FastAPI still reads the Query
    # metadata for HTTP-level 422 validation on out-of-range values
    # (Codex review on #526). `limit` default 500 keeps a month-of-jobs
    # fetch in one round trip for the calendar; max 1000 gives an
    # operator wiggle room for an ad-hoc query.
    limit: Annotated[int, _Query(ge=1, le=1000)] = 500,
    offset: Annotated[int, _Query(ge=0)] = 0,
    # Opt-in envelope: when true, the response is
    #   {"items": [...], "total": N, "limit": L, "offset": O}
    # so callers can drive real pagination. Default false to keep the
    # legacy bare-array shape working (CalendarView + others read that
    # shape directly).
    paginated: bool = False,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    # Job/Visit unification (PR-C): the pre-migration code had a `visit_min`
    # subquery so consumers could bucket by the earliest Visit date when
    # Job.scheduled_date was NULL. Job is now the sole source of scheduling
    # truth, so the fallback is gone — a NULL Job.scheduled_date is just NULL.
    q = db.query(Job).options(joinedload(Job.client))

    # MT-2: scope to the caller's workspace; tolerate legacy NULL-org rows
    # (jobs created by internal paths — recurring, gcal sync — before backfill).
    org_id = resolve_org_id(org_id, db)
    q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))

    if client_id:
        q = q.filter(Job.client_id == client_id)
    if property_id:
        q = q.filter(Job.property_id == property_id)
    if recurring_schedule_id:
        q = q.filter(Job.recurring_schedule_id == recurring_schedule_id)
    if status:
        q = q.filter(Job.status == status)
    if date:
        q = q.filter(Job.scheduled_date == date)
    if date_from:
        q = q.filter(Job.scheduled_date >= date_from)
    if date_to:
        q = q.filter(Job.scheduled_date <= date_to)
    if job_type:
        q = q.filter(Job.job_type == job_type)

    base_query = q.order_by(Job.scheduled_date, Job.start_time)

    # Unassigned filter: cleaner_ids is JSON, so filter in Python (cross-dialect
    # safe). A job "needs assignment" when it has no cleaners and isn't done/
    # cancelled — that's the actionable queue the Schedule page surfaces.
    #
    # Codex review on #526: when `unassigned` is set we MUST apply the
    # predicate BEFORE the offset/limit slice, else the endpoint drops
    # matching jobs on later pages. Ex: default cadence is scheduled_date
    # asc, so if the first 500 rows are all assigned and the caller asks
    # `?unassigned=true&limit=500`, DB-side pagination returns the first
    # 500 (all assigned), Python filter removes all of them, and the
    # caller sees an empty result even though matches exist.
    #
    # When `unassigned` is None (the calendar's common case), we keep the
    # cheap SQL-only path — .offset().limit() on the ordered query — so
    # this hot code stays fast.
    if unassigned is not None:
        def _is_unassigned(j):
            return (not (j.cleaner_ids or [])) and j.status in ("scheduled", "in_progress")
        all_matches = [j for j in base_query.all() if _is_unassigned(j) == unassigned]
        total = len(all_matches) if paginated else None
        page = all_matches[offset:offset + limit]
        rows = [(j, j.scheduled_date) for j in page]
    else:
        # Total BEFORE limit/offset so the envelope's `total` reflects the whole
        # filtered set, not just this page. Cheap even on a big table because
        # the same predicates are indexed (scheduled_date has an index; status/
        # job_type are low-cardinality).
        total = base_query.count() if paginated else None
        # Order + paginate at the DB layer. Was: `.all()` — unbounded, which
        # is exactly the 502-triggering pathology the spec called out.
        page = base_query.offset(offset).limit(limit).all()
        rows = [(j, j.scheduled_date) for j in page]

    if len(rows) >= limit:
        # A caller hitting the ceiling is likely NOT scoping (default
        # limit=500 will only trip on huge date ranges or an unscoped
        # fetch). Log a WARNING so we can spot un-paginated consumers
        # in the perf log.
        logger.warning(
            "[get_jobs] response hit the cap (limit=%s, offset=%s) — "
            "consider a narrower date range or pass paginated=true",
            limit, offset,
        )

    # Phase 5: build a per-property index of relevant ICalEvent rows so
    # we can attach booking details to str_turnover Jobs that lack a
    # direct ical_event_id (production data is currently mostly unlinked).
    rendered = []
    if rows:
        # Bulk-fetch property names for the property_name field on JobResponse
        # (needed by Schedule / Dashboard after the Job/Visit unification).
        all_prop_ids = {j.property_id for j, _ in rows if j.property_id}
        # (name, check_in_time) — the latter feeds turnover_lead_hours below
        # without a per-row lazy-load of j.property.
        prop_meta = (
            {p.id: (p.name, p.check_in_time) for p in
             db.query(Property.id, Property.name, Property.check_in_time)
               .filter(Property.id.in_(all_prop_ids)).all()}
            if all_prop_ids else {}
        )
        prop_names = {pid: meta[0] for pid, meta in prop_meta.items()}
        from modules.settings.router import turnover_lead_buffer_hours
        lead_buffer_hours = turnover_lead_buffer_hours(db)
        prop_ids = {j.property_id for j, _ in rows if j.property_id and j.job_type == "str_turnover"}
        events_by_prop = {}
        if prop_ids:
            ical_rows = (
                db.query(ICalEvent)
                  .filter(ICalEvent.property_id.in_(prop_ids))
                  .filter(ICalEvent.event_type == "reservation")
                  .all()
            )
            for ev in ical_rows:
                events_by_prop.setdefault(ev.property_id, []).append(ev)
            # Sort each property's events by checkin_date for next-arrival lookup.
            for pid, evs in events_by_prop.items():
                evs.sort(key=lambda e: e.checkin_date or "")

        for j, eff in rows:
            booking = None
            next_arrival = None
            if j.job_type == "str_turnover" and j.property_id:
                # Already-linked ical_event_id wins.
                if j.ical_event_id:
                    booking = next((e for e in events_by_prop.get(j.property_id, [])
                                     if e.id == j.ical_event_id), None)
                # Fall back to checkout-date == job-date matching.
                if booking is None:
                    iso = eff.isoformat() if hasattr(eff, "isoformat") else (str(eff) if eff else None)
                    booking = next((e for e in events_by_prop.get(j.property_id, [])
                                     if e.checkout_date == iso), None)
                # Find the next reservation that starts on/after this turnover.
                if booking is not None:
                    next_arrival = next(
                        (e for e in events_by_prop.get(j.property_id, [])
                         if e.checkin_date and e.checkin_date >= booking.checkout_date and e.uid != booking.uid),
                        None,
                    )
            rendered.append(job_to_dict(j, effective_date=eff,
                                        booking_event=booking,
                                        next_arrival=next_arrival,
                                        property_name=prop_names.get(j.property_id),
                                        lead_buffer_hours=lead_buffer_hours,
                                        property_check_in_time=prop_meta.get(j.property_id, (None, None))[1]))
    if paginated:
        return {
            "items": rendered,
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    return rendered


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_job(data: JobCreate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    # Resolved once up front (was re-resolved 3x further down via a separate
    # `_org_scope` local) and used everywhere below that needs the caller's
    # workspace, including the quote/job lookups just below — those used to
    # query by caller-supplied id with no org filter at all, so a user in one
    # org could read (and get returned in full) another org's Job by passing
    # its quote_id here.
    org_id = resolve_org_id(org_id, db)

    # ── CLIENT OWNERSHIP ── data.client_id is caller-supplied; nothing further
    # down validated it belonged to this org before using it to seed a new
    # Property (copying the client's name/address) and stamping it onto the
    # new Job — a user in one org could pass another org's client_id and get
    # a job created that's linked to (and leaks the name/address of) that
    # other org's client.
    owned_client = db.query(Client).filter(
        Client.id == data.client_id,
        or_(Client.org_id == org_id, Client.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not owned_client:
        raise HTTPException(status_code=404, detail="Client not found")

    # ── QUOTE LINKAGE (P1-A) ──
    # When a job is scheduled from an accepted quote, link it back and convert
    # the quote. Idempotent: a double-submit (or a second click of "Set up
    # schedule") returns the existing job instead of creating a duplicate, and
    # preserves the revenue→job traceability that POST /api/jobs used to drop
    # (quote_id was on JobCreate but never set, leaving jobs with quote_id null
    # and quotes stuck at "accepted").
    source_quote = None
    if data.quote_id:
        from database.models import Quote
        source_quote = db.query(Quote).filter(
            Quote.id == data.quote_id,
            or_(Quote.org_id == org_id, Quote.org_id.is_(None)),  # MT-2 tenant scope
        ).first()
        if source_quote and source_quote.status == "converted":
            existing = (db.query(Job).filter(
                Job.quote_id == source_quote.id,
                or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
            ).order_by(Job.id.asc()).first())
            if existing:
                return job_to_dict(existing)

    # ── TIMING VALIDATION ── reject past dates / inverted windows up front.
    _validate_job_timing(data.scheduled_date, data.start_time, data.end_time, is_new=True)

    # A negative hourly bump would silently dock pay — reject it here the same
    # way the PATCH path does.
    if data.pay_rate_bump is not None and data.pay_rate_bump < 0:
        raise HTTPException(status_code=400, detail="pay_rate_bump cannot be negative")

    # ── CONFLICT / DUPLICATE CHECK ──
    # Prevent creating duplicate jobs for the same property + date + time
    if data.property_id and data.job_type == "str_turnover":
        existing = db.query(Job).filter(
            Job.property_id == data.property_id,
            Job.scheduled_date == data.scheduled_date,
            Job.job_type == "str_turnover",
            Job.status.notin_(["cancelled"]),
            or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
        ).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"A turnover job already exists for this property on {data.scheduled_date} (Job #{existing.id}: {existing.title}). Edit the existing job or cancel it first."
            )

    # General duplicate guard for one-off jobs: the same PROPERTY can't have two
    # live jobs at the same date + start time + type — that's a double-submit,
    # not a real second visit. Keyed on property (not client) so a client with
    # two homes cleaned simultaneously isn't wrongly blocked. Overridable via
    # allow_conflicts. Recurring + turnover have their own indexes/checks above.
    if (not data.allow_conflicts and data.job_type != "str_turnover"
            and getattr(data, "property_id", None) and data.scheduled_date and data.start_time
            and not getattr(data, "recurring_schedule_id", None)):
        dup = db.query(Job).filter(
            Job.property_id == data.property_id,
            Job.scheduled_date == data.scheduled_date,
            Job.start_time == data.start_time,
            Job.job_type == (data.job_type or "residential"),
            Job.status.notin_(["cancelled"]),
            or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
        ).first()
        if dup:
            raise HTTPException(
                status_code=409,
                detail=(f"A job already exists for this property on {data.scheduled_date} "
                        f"at {data.start_time} (Job #{dup.id}: {dup.title}). Edit that job, "
                        f"or resubmit with allow_conflicts=true to create anyway."),
            )

    # ── CLEANER GUARDS ── double-booking, time-off, capacity. All overridable
    # via allow_conflicts so an operator can intentionally force an assignment.
    if not data.allow_conflicts:
        conflicts = _find_cleaner_conflicts(
            db, cleaner_ids=data.cleaner_ids, scheduled_date=data.scheduled_date,
            start_time=data.start_time, end_time=data.end_time,
            org_id=org_id,
        )
        if conflicts:
            raise HTTPException(status_code=409, detail=_conflict_detail(conflicts))
        unavailable = _find_unavailable_cleaners(
            db, cleaner_ids=data.cleaner_ids, scheduled_date=data.scheduled_date,
            org_id=org_id,
        )
        if unavailable:
            raise HTTPException(status_code=409, detail=_unavailable_detail(unavailable))
        over = _find_over_capacity(
            db, cleaner_ids=data.cleaner_ids, scheduled_date=data.scheduled_date,
            org_id=org_id,
        )
        if over:
            who = ", ".join(f"cleaner {cid} ({n} jobs)" for cid, n in over)
            raise HTTPException(
                status_code=409,
                detail=f"Over capacity: {who} would exceed the daily limit of "
                       f"{CAPACITY_PER_CLEANER_PER_DAY}. Resubmit with allow_conflicts=true to override.",
            )

        # ── DON'T DOUBLE-BOOK THE SLOT ── Google Free/Busy guard: if the
        # calendar this job_type lands on is already busy in this window, block
        # (overridable via allow_conflicts). Fails open when Google isn't
        # connected or the check errors, so it never wedges scheduling.
        try:
            from modules.settings.router import freebusy_check_enabled
            if freebusy_check_enabled(db):
                from integrations.google_calendar import free_busy_conflicts
                busy = free_busy_conflicts(
                    data.job_type, data.scheduled_date, data.start_time, data.end_time,
                )
                if busy:
                    raise HTTPException(
                        status_code=409,
                        detail=(f"That slot is already booked on Google Calendar "
                                f"({len(busy)} conflicting event(s) between {data.start_time} and "
                                f"{data.end_time} on {data.scheduled_date}). Pick another time, "
                                f"or resubmit with allow_conflicts=true to book anyway."),
                    )
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"Free/Busy guard skipped for new job: {e}")

    # ── PROPERTY DEFAULTING ──
    # Every job needs a property (DB-level NOT NULL), but the one-screen
    # Quick-schedule flow lets the user skip it. Resolve to the client's existing
    # property, or create a sensible default, so a fast booking never fails here.
    resolved_property_id = data.property_id
    if resolved_property_id:
        # Caller-supplied property_id — same class of issue as client_id above:
        # verify it's this org's property before linking a new Job to it.
        owned_property = db.query(Property).filter(
            Property.id == resolved_property_id,
            or_(Property.org_id == org_id, Property.org_id.is_(None)),  # MT-2 tenant scope
        ).first()
        if not owned_property:
            raise HTTPException(status_code=404, detail="Property not found")
    if not resolved_property_id:
        existing_prop = (db.query(Property)
                         .filter(Property.client_id == data.client_id)
                         .order_by(Property.id.asc()).first())
        if existing_prop:
            resolved_property_id = existing_prop.id
        else:
            client = owned_client
            ptype = "str" if data.job_type == "str_turnover" else (
                data.job_type if data.job_type in ("residential", "commercial") else "residential")
            new_prop = Property(
                client_id=data.client_id,
                name=f"{client.name} — Main" if client and client.name else "Main location",
                address=data.address or (getattr(client, "address", None) if client else "") or "",
                property_type=ptype,
            )
            if hasattr(new_prop, "org_id"):
                new_prop.org_id = org_id
            db.add(new_prop); db.commit(); db.refresh(new_prop)
            resolved_property_id = new_prop.id

    payload = data.model_dump(exclude={"allow_conflicts"})
    payload["property_id"] = resolved_property_id
    # Store real date/time objects (the columns are Date/Time) rather than
    # relying on the DB to implicitly cast the inbound strings — keeps writes
    # portable and matches what a post-refresh read returns anyway.
    payload["scheduled_date"] = _to_date(payload.get("scheduled_date"))
    payload["start_time"] = _to_time(payload.get("start_time"))
    payload["end_time"] = _to_time(payload.get("end_time"))
    job = Job(**payload)
    job.org_id = org_id  # MT-2: stamp the caller's workspace
    db.add(job)
    db.commit()
    db.refresh(job)

    # Convert the source quote now that its job exists (mirrors
    # quoting.convert_quote_to_job so there's one definition of "converted").
    if source_quote is not None and source_quote.status != "converted":
        source_quote.status = "converted"
        source_quote.converted_at = datetime.now()
        source_quote.updated_at = datetime.now()
        db.commit()

    # Log to unified activity timeline
    log_job_created(db, job)
    # Booking a job is a definitive "this lead is now a real customer" signal —
    # promote them off the "lead" stage so they don't linger as both a lead and
    # an active customer (lifecycle overlap cleanup). No-op if already active.
    from utils.activity_logger import promote_client_from_lead
    promote_client_from_lead(db, job.client_id, reason="job_booked")
    db.commit()

    # Ping the assigned crew's phones that a job landed on their list —
    # event-driven at the write site (no polling tick, R1), post-commit so a
    # push hiccup can't roll back the booking, and the payload carries no
    # access details (see services/crew_notify.py).
    if job.cleaner_ids:
        from services.crew_notify import notify_job_assigned
        notify_job_assigned(db, job, job.cleaner_ids)

    # (The old Visit dual-write was removed by migration 039; occurrences are
    # the Job row itself now.)

    # ── WRITE TO GOOGLE CALENDAR (source of truth) ──
    # Creating an appointment writes the event straight to Google Calendar.
    # We surface the outcome on the response so the UI can tell the operator
    # whether it landed on Google — instead of silently leaving an app-only
    # appointment that has to be "pushed" later.
    gcal_status = {"synced": False, "reason": None}
    try:
        from integrations.google_calendar import create_event, is_configured
        if not is_configured():
            gcal_status["reason"] = "not_connected"
        else:
            client = db.query(Client).filter(Client.id == job.client_id).first()
            client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None)}
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
                "property_id": job.property_id,
            }
            # Invite the customer (attendee + email) so the cleaning lands on
            # their own calendar — gated by the Settings toggle and requires an
            # email to invite to.
            from modules.settings.router import (
                customer_invites_enabled, customer_notify_enabled, gcal_reminder_overrides,
            )
            invite = customer_invites_enabled(db) and bool(client and client.email)
            # notify controls whether Google EMAILS the customer; reminders come
            # from the operator's Settings choice (default: Google's own).
            _su = "all" if (invite and customer_notify_enabled(db)) else "none"
            event_id = create_event(job_dict, client_dict, send_invite=invite,
                                    reminders=gcal_reminder_overrides(db), send_updates=_su)
            if event_id:
                job.calendar_invite_sent = invite
                job.gcal_event_id = event_id
                from integrations.google_calendar import active_account_id as _gcal_acct
                job.gcal_account_id = _gcal_acct()
                db.commit()
                db.refresh(job)
                log_calendar_event(
                    db, "created",
                    client_id=job.client_id, job_id=job.id,
                    title=job.title, gcal_event_id=event_id,
                    scheduled_date=str(job.scheduled_date) if job.scheduled_date else None,
                )
                db.commit()
                gcal_status["synced"] = True
                _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                                 action="create", status="ok", external_id=event_id)
            else:
                gcal_status["reason"] = "error"
                _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                                 action="create", status="failed", detail="create_event returned no id")
    except Exception as e:
        logger.warning(f"GCal push failed for job {job.id}: {e}")
        gcal_status["reason"] = "error"
        _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                         action="create", status="failed", detail=str(e))

    # Connecteam removal (step 3): job creation no longer auto-dispatches a
    # shift to Connecteam — the crew sees new work on their native My Day
    # schedule the moment it's assigned. The response key stays as an explicit
    # retirement marker (not a silently vanished field).
    result = _job_to_dict_enriched(db, job)
    result["gcal"] = gcal_status
    result["connecteam"] = {"dispatched": False, "reason": "retired"}
    return result


@router.get("/client/{client_id}/gcal-events", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def client_gcal_events(client_id: int, days_back: int = 90, days_ahead: int = 180,
                       db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Live Google Calendar events linked to this client (Twenty-style timeline).

    Matches events by the client's email (attendee) or our brightbase_client_id
    tag, across every configured calendar. Returns {connected, events} so the
    profile can show the real linked timeline, or a connect prompt when Google
    isn't linked yet."""
    oid = resolve_org_id(org_id, db)
    client = db.query(Client).filter(
        Client.id == client_id,
        or_(Client.org_id == oid, Client.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    try:
        from integrations.google_calendar import list_events_for_client, is_configured
    except ImportError as e:
        logger.warning(f"client_gcal_events import failed: {e}")
        return {"connected": False, "reason": "error",
                "detail": "Google Calendar integration unavailable.", "events": []}

    if not is_configured():
        return {"connected": False, "reason": "not_connected", "events": []}

    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(days=days_back)).isoformat()
    time_max = (now + timedelta(days=days_ahead)).isoformat()
    try:
        events = list_events_for_client(
            client_id=client.id,
            client_email=getattr(client, "email", None),
            time_min_iso=time_min,
            time_max_iso=time_max,
        )
        return {"connected": True, "events": events, "client_email": getattr(client, "email", None)}
    except RuntimeError as e:
        # _get_service raises when the token is missing/expired.
        logger.warning(f"client_gcal_events not authorized for client {client_id}: {e}")
        return {"connected": False, "reason": "not_authorized",
                "detail": "Google account not connected.", "events": []}
    except Exception as e:
        logger.warning(f"client_gcal_events failed for client {client_id}: {e}")
        return {"connected": True, "reason": "error",
                "detail": "Could not load events from Google.", "events": []}


@router.get("/gcal-sync-status", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def gcal_sync_status(db: Session = Depends(get_db)):
    """How many upcoming jobs aren't on Google Calendar yet.

    The Calendar page is a read-only Google embed, so it only shows jobs that
    were actually pushed to GCal. This drives a "reconcile" banner there: when
    app jobs (often created before Google was connected, or whose push failed)
    have no gcal_event_id, they're invisible on that page — surfacing the count
    + a Push button lets the operator close the gap in one click.
    """
    try:
        from integrations.google_calendar import is_configured
        configured = bool(is_configured())
    except Exception:
        configured = False
    today = business_today().isoformat()
    unsynced = db.query(Job).filter(
        Job.gcal_event_id.is_(None),
        Job.status.in_(["scheduled", "in_progress"]),
        Job.scheduled_date >= today,
    ).count()
    return {"unsynced_count": unsynced, "configured": configured}


def _app_flag(db: Session, key: str, env_name: str, default: bool = True) -> bool:
    """Read a boolean automation flag the same way the background scheduler does
    (app_settings row overrides the env default), so the Schedule 'auto-flow'
    indicator can't disagree with what the ticks actually honor."""
    from config import env_flag
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is None or row.value is None:
        return env_flag(env_name, default)
    return str(row.value).strip().lower() in {"1", "true", "yes", "on"}


def _sync_overall(*, duplicates: int, orphans: int, backlog: int,
                  auto_flow_on: bool, google_connected: bool) -> str:
    """Decide the Schedule health pill. Pure so it's deterministically testable.

    'attention' is reserved for what a human should actually look at:
      - a data-integrity issue (duplicate jobs / orphaned shifts);
      - Google disconnected — the scheduling backbone is down, so no job can
        reach the calendar (never show a calm green 'ok' in that state);
      - auto-flow OFF with a real backlog the ticks won't clear on their own.
    A backlog while auto-flow is ON is just 'syncing' (the next tick clears it),
    so the badge stays calm instead of crying wolf.
    """
    if duplicates or orphans:
        return "attention"
    if not google_connected:
        return "attention"
    if not auto_flow_on and backlog:
        return "attention"
    if backlog:
        return "syncing"
    return "ok"


@router.get("/sync-health", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def sync_health(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """One consolidated read powering the Schedule 'sync health' badge + panel.

    The point: let the operator TRUST the schedule at a glance instead of
    clicking a pile of redundant 'push now' buttons. Rolls up, read-only:
      - whether Google is connected and auto-flow is actually on
        (all the background ticks that keep the schedule current);
      - how many upcoming jobs aren't on Google yet (a backlog the ticks will
        clear on their own — not something to push manually);
      - the data-integrity issues the background audit already computes
        (duplicate jobs) — the only things a human should act on.
    Never mutates.
    """
    try:
        from integrations.google_calendar import is_configured as _g_ok
        gcal_configured = bool(_g_ok())
    except Exception:
        gcal_configured = False
    from integrations.gcal_sync import calendar_source_of_truth

    today = business_today().isoformat()
    active = ["scheduled", "in_progress"]

    # Scope every count to the caller's tenant (+ legacy null-org rows), like
    # find_schedule_issues / push_to_gcal — otherwise tenant A's pill counts
    # tenant B's unsynced jobs (cross-tenant leak, and a backlog A can't clear).
    oid = resolve_org_id(org_id, db)
    def _org_scoped(q):
        return q.filter(or_(Job.org_id == oid, Job.org_id.is_(None)))

    unsynced_gcal = (
        _org_scoped(db.query(Job).filter(
            Job.gcal_event_id.is_(None),
            Job.status.in_(active),
            Job.scheduled_date >= today,
        )).count()
        if gcal_configured else 0
    )

    automation = {
        "ical_auto_sync": _app_flag(db, "ical_auto_sync_enabled", "ICAL_AUTO_SYNC_ENABLED"),
        "gcal_auto_sync": _app_flag(db, "gcal_auto_sync_enabled", "GCAL_AUTO_SYNC_ENABLED"),
        "recurring_auto_generate": _app_flag(db, "recurring_auto_generate_enabled", "RECURRING_AUTO_GENERATE_ENABLED"),
        "sync_reconcile": _app_flag(db, "sync_reconcile_enabled", "SYNC_RECONCILE_ENABLED"),
        "calendar_source_of_truth": calendar_source_of_truth(db),
    }
    # "Auto-flow on" = the schedule maintains itself with zero manual pushes:
    # feeds pull, jobs generate, and the calendar stays reconciled on its own.
    # Google is the scheduling backbone, so a disconnected Google account breaks
    # the flow (jobs can't reach the calendar) even with every toggle on.
    auto_flow_on = bool(
        gcal_configured
        and automation["ical_auto_sync"]
        and automation["gcal_auto_sync"]
        and automation["recurring_auto_generate"]
        and automation["sync_reconcile"]
    )

    issues = find_schedule_issues(db, oid)
    dup = issues["counts"]["duplicate_groups"]

    backlog = unsynced_gcal
    overall = _sync_overall(
        duplicates=dup, orphans=0, backlog=backlog,
        auto_flow_on=auto_flow_on, google_connected=gcal_configured,
    )

    return {
        "overall": overall,
        "auto_flow_on": auto_flow_on,
        "google": {"configured": gcal_configured, "unsynced_count": unsynced_gcal},
        "issues": {"duplicate_jobs": dup},
        "automation": automation,
    }


@router.get("/sync-overview", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def sync_overview(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """The full Sync Control Center payload (frontend `/sync`): every schedule
    BrightBase syncs with, rolled into one read-only picture — channels with
    flow direction + who-wins + last-sync + backlog, the ~14 background ticks
    finally made visible, and an attention list of only what a human should act
    on. Richer sibling of `/sync-health` (which still powers the compact pill);
    never mutates. Shape lives in
    `modules/scheduling/sync_overview.build_sync_overview`."""
    from modules.scheduling.sync_overview import build_sync_overview
    return build_sync_overview(db, org_id)


@router.post("/push-to-gcal", dependencies=[Depends(require_role("admin", "manager"))])
def push_to_gcal(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Push any BrightBase jobs that don't yet have a GCal event.

    Scoped to the caller's org (MT-2) when reached as an endpoint, so one
    tenant's push can't create Google events — or email calendar invites — for
    another tenant's jobs. In-process callers that pass no org_id (the
    background scheduler's all-orgs reconcile) span every org, as before; the
    per-tenant sync-reconcile endpoint passes its caller's org explicitly."""
    try:
        from integrations.google_calendar import create_event
    except ImportError as e:
        logger.warning(f"push_to_gcal import failed: {e}")
        raise HTTPException(status_code=500, detail="Google Calendar integration unavailable.")

    # int → this tenant; the Depends sentinel (in-process, no org passed) or
    # None → all orgs. resolve_org_id isn't used here because it coerces the
    # sentinel to the default org, but the scheduler needs all-orgs breadth.
    scoped_org = org_id if isinstance(org_id, int) else None
    q = db.query(Job).options(joinedload(Job.client)).filter(
        Job.gcal_event_id.is_(None),
        Job.status.in_(["scheduled", "in_progress"]),
        Job.scheduled_date >= business_today().isoformat(),
    )
    if scoped_org is not None:
        q = q.filter(or_(Job.org_id == scoped_org, Job.org_id.is_(None)))
    jobs = q.order_by(Job.id).all()  # stable lock order (below) so two pushers can't deadlock

    if not jobs:
        return {"pushed": 0, "message": "All upcoming jobs already have GCal events"}

    from modules.settings.router import customer_invites_enabled
    invites_on = customer_invites_enabled(db)
    created_count = 0
    errors = []

    for job in jobs:
        # Serialize against a concurrent pusher (the sync-reconcile tick running
        # the same query) so two paths can't both create a Google event for one
        # job → a duplicate calendar entry. Lock the row and re-check under it;
        # if it already got an event id since the query, skip. Postgres honors
        # FOR UPDATE (rows locked in ascending id order — see order_by above — so
        # two pushers can't deadlock); SQLite ignores it but is single-threaded.
        # autoflush is off, so don't refresh a dirty job (would drop un-flushed
        # edits) — the jobs here are always freshly-queried clean reads.
        try:
            if job not in db.dirty:
                db.refresh(job, with_for_update=True)
        except Exception:  # pragma: no cover - lock unavailable; re-check still applies
            pass
        if job.gcal_event_id:
            continue
        client = job.client
        client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None) if client else None}
        job_dict = {
            "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
            "scheduled_date": job.scheduled_date, "start_time": job.start_time,
            "end_time": job.end_time, "address": job.address, "notes": job.notes,
            "property_id": job.property_id,
        }
        try:
            from modules.settings.router import customer_notify_enabled as _ne, gcal_reminder_overrides as _ro
            invite = invites_on and bool(client and client.email)
            event_id = create_event(job_dict, client_dict, send_invite=invite,
                                    reminders=_ro(db), send_updates=("all" if (invite and _ne(db)) else "none"))
            if event_id:
                job.gcal_event_id = event_id
                from integrations.google_calendar import active_account_id as _gcal_acct
                job.gcal_account_id = _gcal_acct()
                job.calendar_invite_sent = invite
                created_count += 1
        except Exception as e:
            errors.append({"job_id": job.id, "error": str(e)})

    db.commit()
    return {"pushed": created_count, "errors": errors, "message": f"Pushed {created_count} job(s) to Google Calendar"}


@router.post("/sync-reconcile", dependencies=[Depends(require_role("admin", "manager"))])
def sync_reconcile(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """One-click fix for the schedule "Needs attention" banner.

    Pushes every upcoming unsynced job to Google Calendar (same logic as
    /push-to-gcal); a no-op for jobs already synced, so this is safe to call
    repeatedly. The background reconcile tick (scheduler.sync_reconcile_tick)
    runs the same repair automatically.

    Connecteam removal (step 3): this endpoint's Connecteam half (outbox drain
    → read-back → dispatch → drift repair) is retired along with the background
    tick's — a blanket reconcile must not mass-push to a projection the crew no
    longer works from. The per-job /dispatch tools remain until their UI goes.

    Scoped to the caller's org (MT-2): the GCal push only touches this
    tenant's jobs, so this endpoint can't be used to reach around
    push-to-gcal's own tenant scoping.
    """
    oid = resolve_org_id(org_id, db)
    result = {"gcal": {"pushed": 0, "errors": 0}, "connecteam": {"skipped": "retired"}}

    # Google Calendar
    try:
        from integrations.google_calendar import is_configured as _gcal_ok
        if _gcal_ok():
            # One-way self-heal: restore events deleted in Google (clears the
            # stale id so push re-creates them) before the normal push.
            healed = {}
            try:
                from integrations.gcal_sync import reassert_deleted_gcal_events
                healed = reassert_deleted_gcal_events(db)
            except Exception as e:
                logger.warning(f"sync-reconcile: Google re-assert failed: {e}")
            pushed = push_to_gcal(db, org_id=oid)
            result["gcal"] = {"pushed": pushed.get("pushed", 0),
                              "errors": len(pushed.get("errors") or []),
                              "restored": healed.get("restored", 0)}
        else:
            result["gcal"]["skipped"] = "not_configured"
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"sync-reconcile: GCal push failed: {e}")
        result["gcal"] = {"pushed": 0, "errors": 1, "detail": str(e)}

    parts = []
    if result["gcal"].get("pushed"):
        parts.append(f"{result['gcal']['pushed']} pushed to Google")
    total_errors = result["gcal"].get("errors", 0)
    if total_errors:
        parts.append(f"{total_errors} error(s)")
    result["message"] = ", ".join(parts) if parts else "Everything already in sync"
    return result


def find_schedule_issues(db: Session, org_id: int | None = None) -> dict:
    """Scan the live schedule for problems worth surfacing — read-only, never
    mutates: duplicate_jobs, more than one LIVE job for the same property +
    date + start time + type (usually a double-submit). Used by the /audit
    endpoint and the background schedule-audit tick. (The orphaned-Connecteam-
    shifts scan left with the Connecteam removal.)"""
    from collections import defaultdict
    q = db.query(Job).filter(Job.status.notin_(["cancelled"]))
    if org_id is not None:
        q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))
    groups = defaultdict(list)
    for j in q.all():
        if j.property_id and j.scheduled_date and j.start_time:
            key = (j.property_id, str(j.scheduled_date), str(j.start_time), j.job_type or "residential")
            groups[key].append(j)
    duplicate_jobs = [
        {"property_id": k[0], "date": k[1], "start_time": k[2], "job_type": k[3],
         "client_id": js[0].client_id,
         "job_ids": [j.id for j in js], "titles": [j.title for j in js]}
        for k, js in groups.items() if len(js) > 1
    ]

    return {
        "duplicate_jobs": duplicate_jobs,
        "counts": {"duplicate_groups": len(duplicate_jobs)},
    }


@router.get("/audit", dependencies=[Depends(require_role("admin", "manager"))])
def schedule_audit(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """On-demand schedule audit: duplicate jobs. The same scan the background
    tick runs, exposed for a Settings/admin view."""
    return find_schedule_issues(db, resolve_org_id(org_id, db))


@router.post("/sync-gcal", dependencies=[Depends(require_role("admin", "manager"))])
def sync_from_gcal(db: Session = Depends(get_db)):
    """
    Full two-way sync with Google Calendar.
    Matches events to clients by: extendedProperties → attendee email → address.
    """
    from integrations.gcal_sync import sync_calendar, sync_gcal_cancellations
    result = sync_calendar(db)
    if result.get("error"):
        raise HTTPException(status_code=502, detail=result["error"])
    # Reverse linkage check: catch events that were deleted in GCal
    # (deleted events disappear from events.list, so sync_calendar
    # misses them). Non-fatal if it errors.
    try:
        result["cancellations"] = sync_gcal_cancellations(db)
    except Exception as e:
        result["cancellations"] = {"error": str(e)}
    return result


# ---------------------------------------------------------------------------
# Cleaner availability (time-off)
# Defined BEFORE /{job_id} so the literal "/time-off" path isn't captured by
# the int job_id route.
# ---------------------------------------------------------------------------

class TimeOffCreate(BaseModel):
    cleaner_id: str
    cleaner_name: Optional[str] = None
    start_date: str            # YYYY-MM-DD
    end_date: str              # YYYY-MM-DD
    reason: Optional[str] = None


def _timeoff_to_dict(t: CleanerTimeOff) -> dict:
    return {
        "id": t.id,
        "cleaner_id": t.cleaner_id,
        "cleaner_name": t.cleaner_name,
        "start_date": t.start_date.isoformat() if t.start_date else None,
        "end_date": t.end_date.isoformat() if t.end_date else None,
        "reason": t.reason,
        # 'approved' (office-entered or approved request) | 'requested' |
        # 'denied'. Only approved rows count as off anywhere.
        "status": getattr(t, "status", None) or "approved",
    }


@router.get("/cleaner-availability", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def cleaner_availability(
    date: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    exclude_job_id: Optional[int] = None,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Per-cleaner availability status for the given date + time window.

    Returns [{cleaner_id, status, detail}] where status is one of:
      - "off"         — approved time off covering that date
      - "conflict"    — already assigned to another job overlapping the window
      - "unavailable" — an EXPLICIT week entry (crew app Phase 4b) says this
                        date/window doesn't work. Firmer than usually_off
                        (the cleaner said it about THIS week) but still not
                        a block. Outranks same_day: "I can't that day" beats
                        "they're stackable".
      - "same_day"    — assigned to another job that day (no time overlap)
      - "usually_off" — their recurring template doesn't cover this
                        date/window. The softest signal.
      - "free"        — no conflicts detected

    A week entry MASKS the template for its week in BOTH directions: a
    cleaner who marks a usually-off Friday as available for one week must
    show as free, not "usually off" — that's the volunteer case.

    Powers the JobEdit cleaner picker's inline availability hints so
    operators aren't picking blind from an alphabetical list (audit
    finding: assigning blind led to double-bookings), and the dispatch
    board's crew chips (same payload, no window).
    """
    d = _to_date(date)
    if d is None:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD.")
    oid = resolve_org_id(org_id, db)
    # 1) Time-off: everyone off that day.
    off_rows = db.query(CleanerTimeOff).filter(
        CleanerTimeOff.start_date <= d, CleanerTimeOff.end_date >= d,
        CleanerTimeOff.status == "approved",   # pending requests aren't off yet
        or_(CleanerTimeOff.org_id == oid, CleanerTimeOff.org_id.is_(None)),  # MT-2 tenant scope
    ).all()
    off_by_id = {str(r.cleaner_id): r for r in off_rows}

    # 2) Same-day jobs excluding cancelled + optionally excluding the job
    #    being edited (self-conflict is not a conflict).
    q = db.query(Job).filter(
        Job.scheduled_date == d.isoformat(),
        Job.status.notin_(["cancelled"]),
        Job.cleaner_ids.isnot(None),
        or_(Job.org_id == oid, Job.org_id.is_(None)),  # MT-2 tenant scope
    )
    if exclude_job_id is not None:
        q = q.filter(Job.id != exclude_job_id)
    same_day_jobs = q.all()

    conflicts: dict[str, list] = {}
    same_day_only: dict[str, list] = {}
    for j in same_day_jobs:
        for cid in (j.cleaner_ids or []):
            cid = str(cid)
            if _overlaps(start, end, j.start_time, j.end_time):
                conflicts.setdefault(cid, []).append(j)
            else:
                same_day_only.setdefault(cid, []).append(j)

    # 2b) Availability patterns (crew app Phase 4/4b). Two tiers, and the
    #     explicit week entry MASKS the template for its week in BOTH
    #     directions (a volunteer who opened a usually-off day must show
    #     free). Shared window logic:
    from database.models import CleanerAvailability as _CA, CleanerWeekAvailability as _CWA
    from modules.crew.router import _normalize_week
    from utils.dates import week_monday as _week_monday
    weekday_key = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[d.weekday()]
    st, en = _to_time(start) if start else None, _to_time(end) if end else None
    needs = set()
    if st is not None or en is not None:
        if (st or en).hour < 12:
            needs.add("am")
        if (en or st).hour >= 12:
            needs.add("pm")
    else:
        needs = {"am", "pm"}

    def _misses(week: dict) -> "str | None":
        """Human wording when `week` doesn't cover the needed slots, else None.
        Day-level asks (no window) only flag fully-off days — partial
        availability is not a warning."""
        slots = set(_normalize_week(week).get(weekday_key, []))
        missing = needs - slots
        if not slots:
            return weekday_key.capitalize()
        if missing == needs and missing:
            label = " + ".join(sorted("mornings" if m == "am" else "afternoons" for m in missing))
            return f"{weekday_key.capitalize()} {label}"
        return None

    # Explicit rows for the week containing `d` — the firm tier.
    monday = _week_monday(d)
    week_rows = {str(r.cleaner_id): r for r in db.query(_CWA).filter(
        _CWA.week_start == monday,
        or_(_CWA.org_id == oid, _CWA.org_id.is_(None))).all()}
    unavailable: dict[str, str] = {}
    for cid, r in week_rows.items():
        miss = _misses(r.week)
        if miss:
            unavailable[cid] = f"unavailable {miss} (set for this week)"

    # Template tier — only for cleaners with NO week row (the mask).
    usually_off: dict[str, str] = {}
    for row in db.query(_CA).filter(
            or_(_CA.org_id == oid, _CA.org_id.is_(None))).all():
        cid = str(row.cleaner_id)
        if cid in week_rows:
            continue
        miss = _misses(row.week)
        if miss:
            usually_off[cid] = f"usually off {miss}"

    # 3) Build the result for every known cleaner id we've seen (from any
    #    source); the caller's cleaner list is separate — this endpoint just
    #    answers "for these cleaners, what's their state". Priority:
    #    off > conflict > unavailable > same_day > usually_off — an explicit
    #    "I can't that day" outranks "they're stackable", and a booking that
    #    contradicts the week entry is flagged in the detail rather than
    #    swallowed.
    all_ids = (set(off_by_id) | set(conflicts) | set(same_day_only)
               | set(unavailable) | set(usually_off))
    out = []
    for cid in sorted(all_ids):
        contradiction = " · marked unavailable this week" if cid in unavailable else ""
        if cid in off_by_id:
            r = off_by_id[cid]
            out.append({"cleaner_id": cid, "status": "off",
                        "detail": f"off {r.start_date}–{r.end_date}" +
                                  (f" ({r.reason})" if r.reason else "")})
        elif cid in conflicts:
            j = conflicts[cid][0]
            slot = f"{j.start_time}-{j.end_time}" if j.start_time and j.end_time else "same window"
            out.append({"cleaner_id": cid, "status": "conflict",
                        "detail": f"booked {slot}{contradiction}", "conflict_job_id": j.id})
        elif cid in unavailable:
            out.append({"cleaner_id": cid, "status": "unavailable",
                        "detail": unavailable[cid]})
        elif cid in same_day_only:
            j = same_day_only[cid][0]
            slot = f"{j.start_time}-{j.end_time}" if j.start_time and j.end_time else "same day"
            out.append({"cleaner_id": cid, "status": "same_day",
                        "detail": f"another job {slot}", "conflict_job_id": j.id})
        else:
            out.append({"cleaner_id": cid, "status": "usually_off",
                        "detail": usually_off[cid]})
    return out


@router.get("/property-availability", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def property_availability(
    property_id: int,
    date: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    exclude_job_id: Optional[int] = None,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Other non-cancelled jobs already on the calendar at this property on
    this date, for a soft "heads up" warning while creating/editing a job.

    Unlike the str_turnover-only hard 409 in create_job (a duplicate-turnover
    guard), this covers every job_type and never blocks — it's meant to be
    surfaced as a dismissible warning in the edit form, not a save-blocking
    error, since a property legitimately CAN have two jobs the same day
    (e.g. a morning turnover + an afternoon deep clean).

    Returns {"conflicts": [{job_id, title, job_type, start_time, end_time,
    overlaps}]} — `overlaps` is true when the window actually overlaps
    start/end (when given), false when it's just "also that day".
    """
    d = _to_date(date)
    if d is None:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD.")
    oid = resolve_org_id(org_id, db)
    q = db.query(Job).filter(
        Job.property_id == property_id,
        Job.scheduled_date == d.isoformat(),
        Job.status.notin_(["cancelled"]),
        or_(Job.org_id == oid, Job.org_id.is_(None)),  # MT-2 tenant scope
    )
    if exclude_job_id is not None:
        q = q.filter(Job.id != exclude_job_id)
    others = q.all()
    return {
        "conflicts": [
            {
                "job_id": j.id,
                "title": j.title,
                "job_type": j.job_type,
                "start_time": str(j.start_time) if j.start_time else None,
                "end_time": str(j.end_time) if j.end_time else None,
                "overlaps": _overlaps(start, end, j.start_time, j.end_time),
            }
            for j in others
        ],
    }


@router.get("/time-off", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def list_time_off(
    cleaner_id: Optional[str] = None,
    upcoming_only: bool = True,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """List cleaner time-off entries. Defaults to current + future ranges."""
    oid = resolve_org_id(org_id, db)
    q = db.query(CleanerTimeOff).filter(
        or_(CleanerTimeOff.org_id == oid, CleanerTimeOff.org_id.is_(None)),  # MT-2 tenant scope
    )
    if cleaner_id:
        q = q.filter(CleanerTimeOff.cleaner_id == str(cleaner_id))
    if upcoming_only:
        q = q.filter(CleanerTimeOff.end_date >= business_today())
    rows = q.order_by(CleanerTimeOff.start_date).all()
    return [_timeoff_to_dict(t) for t in rows]


@router.post("/time-off", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_time_off(data: TimeOffCreate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Mark a cleaner unavailable for a date range (inclusive)."""
    start = _to_date(data.start_date)
    end = _to_date(data.end_date)
    if start is None or end is None:
        raise HTTPException(status_code=400, detail="start_date and end_date must be YYYY-MM-DD.")
    if end < start:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date.")
    row = CleanerTimeOff(
        cleaner_id=str(data.cleaner_id),
        cleaner_name=data.cleaner_name,
        start_date=start,
        end_date=end,
        reason=data.reason,
        org_id=resolve_org_id(org_id, db),  # MT-2: stamp the caller's workspace
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _timeoff_to_dict(row)


class TimeOffStatusBody(BaseModel):
    status: str    # "approved" | "denied"


@router.patch("/time-off/{time_off_id}/status", dependencies=[Depends(require_role("admin", "manager"))])
def set_time_off_status(
    time_off_id: int,
    data: TimeOffStatusBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Approve or deny a crew-submitted time-off request (migration 089).

    Approving makes it real time off (top-priority in every availability
    surface); denying keeps the row for the cleaner's own history but it
    never blocks scheduling. Either way the requester's phone gets a push.
    """
    status = (data.status or "").strip().lower()
    if status not in ("approved", "denied"):
        raise HTTPException(status_code=422, detail="status must be 'approved' or 'denied'.")
    oid = resolve_org_id(org_id, db)
    row = db.query(CleanerTimeOff).filter(
        CleanerTimeOff.id == time_off_id,
        or_(CleanerTimeOff.org_id == oid, CleanerTimeOff.org_id.is_(None)),
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Time-off entry not found.")
    row.status = status
    db.commit(); db.refresh(row)
    if row.requested_by_user_id:
        try:
            from services.push_service import notify_user
            rng = (row.start_date.isoformat() if row.start_date == row.end_date
                   else f"{row.start_date.isoformat()} – {row.end_date.isoformat()}")
            notify_user(
                row.requested_by_user_id,
                "Time off " + ("approved ✓" if status == "approved" else "not approved"),
                f"Your request for {rng} was {status}."
                + ("" if status == "approved" else " Talk to the office if you need it."),
                url="/my-day", tag=f"timeoff-{row.id}", category="time_off",
            )
        except Exception:
            logger.exception("push notify failed on set_time_off_status")
    return _timeoff_to_dict(row)


@router.delete("/time-off/{time_off_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_time_off(time_off_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Remove a time-off entry."""
    oid = resolve_org_id(org_id, db)
    row = db.query(CleanerTimeOff).filter(
        CleanerTimeOff.id == time_off_id,
        or_(CleanerTimeOff.org_id == oid, CleanerTimeOff.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Time-off entry not found")
    db.delete(row)
    db.commit()


# Registered before /{job_id} so the literal path isn't swallowed by the int route.
@router.post("/auto-assign-turnovers", dependencies=[Depends(require_role("admin", "manager"))])
def auto_assign_turnovers(dry_run: bool = False, db: Session = Depends(get_db),
                          org_id: int = Depends(current_org_id)):
    """Assign available cleaners to upcoming unassigned STR turnover jobs.
    Pass ?dry_run=true to preview the picks without writing them.

    Scoped to the caller's org (MT-2): reads and reassigns only this tenant's
    turnovers, never another org's."""
    return auto_assign_unassigned_turnovers(db, dry_run=dry_run,
                                            org_id=resolve_org_id(org_id, db))


class BulkRescheduleRequest(BaseModel):
    job_ids: List[int]
    shift_days: int


# Registered before /{job_id} so the literal path isn't swallowed by the int route.
@router.post("/bulk-reschedule", dependencies=[Depends(require_role("admin", "manager"))])
def bulk_reschedule(body: BulkRescheduleRequest, db: Session = Depends(get_db),
                    org_id: int = Depends(current_org_id)):
    """Shift a set of jobs by N days in one action — the "weather day" /
    sick-day move (Tier 4 roadmap): select today's jobs, push the whole day
    back without touching each one individually.

    Recurring occurrences go through the same reschedule-exception path
    JobEditModal's "this visit only" scope uses (not a bare scheduled_date
    PATCH) — otherwise the next generate_jobs tick would regenerate the
    original date alongside the shifted one instead of replacing it, the
    same duplicate-occurrence bug Fix 1 closed for the single-job path.
    """
    if body.shift_days == 0:
        raise HTTPException(status_code=400, detail="shift_days must be non-zero")
    if not body.job_ids:
        raise HTTPException(status_code=400, detail="job_ids must not be empty")

    oid = resolve_org_id(org_id, db)
    jobs = (
        db.query(Job)
        .filter(Job.id.in_(body.job_ids), or_(Job.org_id == oid, Job.org_id.is_(None)))
        .all()
    )
    found_ids = {j.id for j in jobs}

    from modules.recurring.router import _reschedule_occurrence, _get_schedule_or_404
    # Operator bulk move: recurring occurrences email the customer only when both
    # the master notify + the move toggle are on (default silent). One-off jobs in
    # the else-branch route through update_job, which applies the same rule.
    from modules.settings.router import (
        customer_notify_enabled as _bulk_ne, customer_notify_on_move_enabled as _bulk_nom,
    )
    _bulk_notify_move = _bulk_ne(db) and _bulk_nom(db)

    shifted, skipped = [], []
    for job_id in body.job_ids:
        job = next((j for j in jobs if j.id == job_id), None)
        if job is None:
            skipped.append({"job_id": job_id, "reason": "not found"})
            continue
        if job.status in ("cancelled", "completed"):
            skipped.append({"job_id": job_id, "reason": f"job is {job.status}"})
            continue
        if not job.scheduled_date:
            skipped.append({"job_id": job_id, "reason": "no scheduled_date"})
            continue
        new_date = job.scheduled_date + timedelta(days=body.shift_days)
        try:
            if job.recurring_schedule_id:
                sched = _get_schedule_or_404(db, job.recurring_schedule_id, oid)
                _reschedule_occurrence(
                    db, sched, job.scheduled_date, new_date,
                    rescheduled_start_time=job.start_time, rescheduled_end_time=job.end_time,
                    cleaner_ids=job.cleaner_ids, reason="Bulk reschedule",
                    notify_customer=_bulk_notify_move,
                )
            else:
                # Route one-off moves through update_job so the Google Calendar
                # event moves too (a bare scheduled_date write left the event on
                # the old day permanently — reconcile can't fix a job that
                # already has an event id) and the confirmed/reminder flags reset.
                update_job(job.id, JobUpdate(
                    scheduled_date=new_date.isoformat(), allow_conflicts=True),
                    db=db, org_id=oid)
            shifted.append(job_id)
        except HTTPException as e:
            skipped.append({"job_id": job_id, "reason": e.detail})
    db.commit()
    return {"shifted": len(shifted), "shifted_ids": shifted, "skipped": skipped}


def _job_source(j: Job) -> str:
    """Best-effort inference of what created a job, to explain missing times."""
    if j.ical_event_id is not None:
        return "ical_sync"
    if j.gcal_event_id:
        return "google_calendar"
    if j.recurring_schedule_id is not None:
        return "recurring"
    return "manual_or_legacy"


# Registered before /{job_id} so the literal path isn't swallowed by the int route.
@router.get("/diagnostics/missing-times", dependencies=[Depends(require_role("admin", "manager"))])
def diagnose_missing_times(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Diagnostic: list jobs with no start_time — the records that render as
    '– –' on the schedule. Visits can't be null (DB constraint), so a blank time
    always traces to a Job with start_time IS NULL shown via the job→visit
    fallback. Each row is tagged with the likely source so we can fix the
    actual producer rather than guess. Read-only; writes nothing.

    Scoped to the caller's org (MT-2) so it can't enumerate another tenant's
    job titles and property names."""
    oid = resolve_org_id(org_id, db)
    today = business_today()
    missing = (
        db.query(Job)
        .filter(Job.start_time.is_(None), Job.status.notin_(["cancelled"]),
                or_(Job.org_id == oid, Job.org_id.is_(None)))  # MT-2 tenant scope
        .order_by(Job.scheduled_date.desc())
        .limit(200)
        .all()
    )
    prop_names = {
        p.id: p.name for p in db.query(Property.id, Property.name)
        .filter(or_(Property.org_id == oid, Property.org_id.is_(None))).all()
    } if missing else {}

    by_source: dict = {}
    rows = []
    for j in missing:
        src = _job_source(j)
        by_source[src] = by_source.get(src, 0) + 1
        rows.append({
            "job_id": j.id,
            "title": j.title,
            "job_type": j.job_type,
            "status": j.status,
            "scheduled_date": str(j.scheduled_date) if j.scheduled_date else None,
            "start_time": None,
            "end_time": str(j.end_time) if j.end_time else None,
            "property_id": j.property_id,
            "property_name": prop_names.get(j.property_id),
            "source": src,
            "has_ical_event": j.ical_event_id is not None,
            "has_gcal_event": bool(j.gcal_event_id),
            "is_recurring": j.recurring_schedule_id is not None,
            "created_at": str(j.created_at) if j.created_at else None,
            "upcoming": bool(j.scheduled_date and j.scheduled_date >= today),
        })

    return {
        "summary": {
            "jobs_missing_start_time": len(rows),
            "upcoming_missing": sum(1 for r in rows if r["upcoming"]),
            "by_source": by_source,
            "note": ("Blank times come from Jobs with start_time IS NULL. Fix the "
                     "source(s) listed in by_source."),
        },
        "jobs": rows,
    }


# Registered before /{job_id} so the literal path isn't swallowed by the int route.
@router.post("/backfill-missing-times", dependencies=[Depends(require_role("admin", "manager"))])
def backfill_missing_times(dry_run: bool = False, db: Session = Depends(get_db),
                           org_id: int = Depends(current_org_id)):
    """Fill a sensible time on every non-cancelled job that has no start_time
    (the records that render as '– –'). Uses the same rule iCal sync uses:
    turnovers get the property's check-out time (fallback 10:00), other jobs
    get 09:00; end = start + the property's default duration (fallback 3h).
    Pass ?dry_run=true to preview without writing. Review-first.

    Scoped to the caller's org (MT-2) so a tenant admin can only rewrite times
    on their own jobs, never another org's."""
    from integrations.ical_sync import _make_end_time
    oid = resolve_org_id(org_id, db)
    missing = (
        db.query(Job)
        .filter(Job.start_time.is_(None), Job.status.notin_(["cancelled"]),
                or_(Job.org_id == oid, Job.org_id.is_(None)))  # MT-2 tenant scope
        .order_by(Job.scheduled_date.desc())
        .limit(500)
        .all()
    )
    prop_map = {
        p.id: p for p in db.query(Property)
        .filter(or_(Property.org_id == oid, Property.org_id.is_(None))).all()
    } if missing else {}

    changes = []
    for j in missing:
        prop = prop_map.get(j.property_id)
        # After the Job/Visit unification (migration 039), completion state is
        # on the Job row itself — a completed job never lands here anyway (it
        # already has a real start_time), so pick a sensible default: STR uses
        # the property's checkout time; everything else is 09:00 + property
        # default duration.
        if j.job_type == "str_turnover":
            start_str = (prop.check_out_time if prop and prop.check_out_time else None) or "10:00"
        else:
            start_str = "09:00"
        dur = (prop.default_duration_hours if prop and prop.default_duration_hours else None) or 3.0
        end_str = _make_end_time(start_str, dur)
        st, et = _to_time(start_str), _to_time(end_str)
        new_start, new_end = start_str, end_str

        changes.append({
            "job_id": j.id, "title": j.title, "job_type": j.job_type,
            "scheduled_date": str(j.scheduled_date) if j.scheduled_date else None,
            "property_name": prop.name if prop else None,
            "source": _job_source(j),
            "time_source": "default",
            "new_start": new_start, "new_end": new_end,
        })
        if not dry_run:
            j.start_time = st
            j.end_time = et
    if not dry_run and changes:
        db.commit()
    return {"dry_run": dry_run, "count": len(changes), "jobs": changes}


def _ensure_job_public_token(job: Job) -> str:
    """Return the job's public confirm-link token, generating one if missing."""
    if not job.public_token:
        job.public_token = secrets.token_urlsafe(32)
    return job.public_token


def _job_by_token(token: str, db: Session) -> Job:
    job = db.query(Job).filter(Job.public_token == token).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# ── Customer self-reschedule ──────────────────────────────────────────────
# Arrival windows offered on the public confirm page. Mirrors the quote
# self-schedule windows (modules/quoting/router.py) so the two customer-facing
# flows speak the same language; the owner confirms the exact time, the job
# carries a concrete start/end so it lands on the calendar.
SELF_RESCHEDULE_WINDOWS = {"morning": ("09:00", "12:00"), "afternoon": ("13:00", "16:00")}
SELF_RESCHEDULE_DAYS = 42          # how far ahead a customer can move a visit
SELF_RESCHEDULE_MIN_LEAD_DAYS = 1  # earliest is tomorrow (never same-day)


def _self_reschedule_days(db: Session) -> list:
    """Every bookable business day over the next SELF_RESCHEDULE_DAYS (Sundays
    closed). We deliberately do NOT drop days where cleaners are busy — a
    customer may double-book on purpose; those land as a pending approval — so
    this is just the calendar of offerable days."""
    today = business_today()
    out = []
    for i in range(SELF_RESCHEDULE_MIN_LEAD_DAYS, SELF_RESCHEDULE_DAYS + 1):
        d = today + timedelta(days=i)
        if d.weekday() == 6:  # Sunday: closed
            continue
        out.append(d.isoformat())
    return out


def _gcal_busy_blocks_for(db: Session, job: Job, day_isos: list) -> list:
    """One Google Free/Busy range query for the job's calendar over the span of
    the offered days. Empty (fail-open) when Google isn't connected/enabled."""
    if not day_isos:
        return []
    try:
        from modules.settings.router import freebusy_check_enabled
        if not freebusy_check_enabled(db):
            return []
        from integrations.google_calendar import free_busy_range
        return free_busy_range(job.job_type or "residential", day_isos[0], day_isos[-1]) or []
    except Exception as e:
        logger.warning(f"[jobs] self-reschedule Free/Busy skipped: {e}")
        return []


def _window_covered_by_busy(day_iso: str, start: str, end: str, busy_blocks: list) -> bool:
    """True when a Google busy block spans the whole arrival window."""
    if not busy_blocks:
        return False
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("America/New_York")
        ws = datetime.fromisoformat(f"{day_iso}T{start}:00").replace(tzinfo=tz)
        we = datetime.fromisoformat(f"{day_iso}T{end}:00").replace(tzinfo=tz)
        for b in busy_blocks:
            bs = datetime.fromisoformat(b["start"])
            be = datetime.fromisoformat(b["end"])
            if bs <= ws and be >= we:
                return True
    except Exception:
        return False
    return False


def _crew_busy_on(db: Session, job: Job, d, start: str, end: str) -> bool:
    """Whether the job's assigned crew already has a conflicting visit in this
    window (cheap DB check; skipped when the job has no crew yet)."""
    if not job.cleaner_ids:
        return False
    try:
        conflicts = _find_cleaner_conflicts(
            db, cleaner_ids=job.cleaner_ids, scheduled_date=d,
            start_time=start, end_time=end, exclude_job_id=job.id, org_id=job.org_id)
        return bool(conflicts)
    except Exception:
        return False


def _job_self_reschedule_availability(db: Session, job: Job) -> list:
    """Days + arrival windows for the self-reschedule picker. Every business day
    is offered (double-book allowed); each window is flagged ``busy`` when the
    crew is already booked or Google Calendar shows the slot taken. A busy pick
    doesn't move the job — it lands as a pending approval for the owner. The
    job's own current date is skipped (moving onto today's date is a no-op)."""
    day_isos = _self_reschedule_days(db)
    cur = job.scheduled_date.isoformat() if job.scheduled_date else None
    busy_blocks = _gcal_busy_blocks_for(db, job, day_isos)

    out = []
    for day_iso in day_isos:
        if day_iso == cur:
            continue
        d = _to_date(day_iso)
        windows = []
        for key, (s, e) in SELF_RESCHEDULE_WINDOWS.items():
            busy = _window_covered_by_busy(day_iso, s, e, busy_blocks) or _crew_busy_on(db, job, d, s, e)
            windows.append({"key": key, "busy": busy})
        out.append({"date": day_iso, "windows": windows})
    return out


def _slot_busy(db: Session, job: Job, d, start: str, end: str) -> bool:
    """Whether the chosen slot double-books — crew already booked, or Google
    Calendar shows this job_type's calendar busy in the window. Drives the
    approval gate: a busy pick is held for the owner instead of moving."""
    if _crew_busy_on(db, job, d, start, end):
        return True
    try:
        from modules.settings.router import freebusy_check_enabled
        if freebusy_check_enabled(db):
            from integrations.google_calendar import free_busy_conflicts
            if free_busy_conflicts(job.job_type or "residential", d, start, end):
                return True
    except Exception:
        pass
    return False


class _GcalSyncSkipped(Exception):
    """Internal signal: a Google Calendar sync did NOT apply, so the caller
    should skip recording a success timeline entry. Failure is already logged."""


def _shift_series_weekday(existing_days, from_date, to_date) -> list:
    """The series' days_of_week with the dragged occurrence's weekday replaced
    by the target weekday, preserving the OTHER days. Moving one occurrence of
    a Mon/Wed/Fri series to Thursday shifts that leg (→ Mon/Thu/Fri), it does
    NOT collapse the rule to a single [Thu] — which silently deleted every
    other weekday's future visits. A single-day series naturally yields
    [target]; an every-day series (no day filter) is left to the target day
    since split can't express 'every day'."""
    to_wd = to_date.weekday()
    days = set(existing_days or [])
    if not days:
        return [to_wd]
    if from_date is not None:
        days.discard(from_date.weekday())
    days.add(to_wd)
    return sorted(days)


def _apply_reschedule_move(db: Session, job: Job, d, start: str, end: str, scope: str) -> Job:
    """Actually move the visit. Returns the resulting Job.

    - one-off job → move the row in place (keeps token + Google event).
    - recurring, scope 'this' → single-occurrence exception (carries the
      customer link onto the new row).
    - recurring, scope 'future' → split the series at the earlier of the two
      dates so this visit and every future one follow the new day/time.
    All paths keep Google Calendar in sync (update_job / generate_jobs)."""
    org_id = resolve_org_id(job.org_id, db)
    if job.recurring_schedule_id:
        from modules.recurring.router import (
            _reschedule_occurrence, _get_schedule_or_404, split_schedule, ScheduleSplit)
        sched = _get_schedule_or_404(db, job.recurring_schedule_id, org_id)
        if scope == "future":
            # split_schedule soft-cancels THIS job and regenerates a fresh
            # series with no token — so grab the customer's link first and move
            # it onto the new visit, or their confirm/manage link would resolve
            # to the cancelled original ("this visit was cancelled").
            token = job.public_token
            split_date = min(job.scheduled_date, d) if job.scheduled_date else d
            # Shift ONLY this occurrence's weekday; keep the series' other days.
            new_days = _shift_series_weekday(sched.days_of_week, job.scheduled_date, d)
            split_result = split_schedule(job.recurring_schedule_id, ScheduleSplit(
                split_date=split_date, days_of_week=new_days, day_of_week=d.weekday(),
                day_of_month=d.day, start_time=start, end_time=end,
                cleaner_ids=[str(c) for c in (job.cleaner_ids or [])],
            ), db=db, org_id=org_id)
            db.flush()
            # Find the moved occurrence by the NEW schedule's id + target date,
            # not a property+date+max(id) guess that could grab an unrelated
            # job on the same property/date and hand it the customer's token.
            new_sched_id = split_result.get("id")
            moved = (
                db.query(Job)
                .filter(Job.recurring_schedule_id == new_sched_id,
                        Job.scheduled_date == d,
                        Job.status != "cancelled")
                .first()
                if new_sched_id else None
            )
            if moved is not None:
                job.public_token = None
                if token and not moved.public_token:
                    moved.public_token = token
                    moved.customer_confirmed_at = None
                return moved
            # The new series didn't materialize the target date (e.g. it's
            # beyond the schedule's generation horizon). Leave the customer's
            # link on the original rather than orphaning it or, worse,
            # attaching it to a stranger's job.
            return job
        # scope 'this' — move just this occurrence (swaps the Job row).
        token = job.public_token
        # Customer-initiated move: keep notifying (notify_customer default True).
        # The move-toggle governs OPERATOR moves only — a customer who just moved
        # their own visit should still get the confirming calendar update.
        _, newjob = _reschedule_occurrence(
            db, sched, exception_date=job.scheduled_date, rescheduled_date=d,
            rescheduled_start_time=start, rescheduled_end_time=end,
            cleaner_ids=job.cleaner_ids, reason="Customer self-reschedule",
            notify_customer=True)
        db.flush()
        if newjob is not None and newjob.id != job.id:
            newjob.public_token = token
            job.public_token = None
        return newjob or job
    # One-off visit — move in place so the token + Google event follow it.
    update_job(job.id, JobUpdate(
        scheduled_date=d.isoformat(), start_time=start, end_time=end,
        allow_conflicts=True), db=db, org_id=org_id)
    return job


def _public_job_dict(job: Job, db: Session) -> dict:
    """Client-facing serialization for the public confirm page — no internal
    IDs/notes/cleaner assignments, just what the customer needs to recognize
    and confirm (or move) their own visit."""
    from modules.quoting.router import _company_info
    from modules.settings.router import customer_self_reschedule_enabled
    company = _company_info(db)
    prop = job.property
    return {
        "title": job.title,
        "status": job.status,
        "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None,
        "start_time": str(job.start_time) if job.start_time else None,
        "end_time": str(job.end_time) if job.end_time else None,
        "address": (prop.address if prop else None) or job.address,
        "company_name": company["company_name"],
        "company_phone": company["company_phone"],
        "brand_color": company["brand_color"],
        "company_logo_url": company["company_logo_url"],
        "customer_confirmed_at": job.customer_confirmed_at.isoformat() if job.customer_confirmed_at else None,
        "reschedule_requested_at": job.reschedule_requested_at.isoformat() if job.reschedule_requested_at else None,
        "is_cancelled": job.status == "cancelled",
        # Whether the customer can self-serve a move (feature enabled + visit is
        # live). The picker still fetches concrete open days from /availability.
        "can_self_reschedule": (
            customer_self_reschedule_enabled(db) and job.status != "cancelled"
        ),
        # Recurring visits let the customer choose "this visit" vs "all future".
        "is_recurring": bool(job.recurring_schedule_id),
        # A pending self-reschedule that's awaiting owner approval (busy slot).
        "pending_reschedule": (
            {
                "date": str(job.reschedule_requested_date),
                "start_time": str(job.reschedule_requested_start_time) if job.reschedule_requested_start_time else None,
                "scope": job.reschedule_requested_scope,
            }
            if job.reschedule_requested_date else None
        ),
    }


def _notify_owner_job_event(subject: str, lines: list) -> None:
    """Best-effort owner email for a customer job-confirm-link event. Never
    raises — mirrors modules/quoting/router.py's _notify_owner_quote_event_core."""
    try:
        from integrations.email import _load_smtp_creds, send_email
        creds = _load_smtp_creds()
        owner = creds.get("from_email")
        if not owner:
            return
        import html as _html
        body = "<br>".join(_html.escape(l) if l else "&nbsp;" for l in lines)
        send_email(to=owner, subject=subject, html_body=f"<div style='font-family:sans-serif'>{body}</div>",
                   text_body="\n".join(lines))
    except Exception as e:
        logger.warning(f"[jobs] owner notification failed: {e}")


# Registered before /{job_id} so the literal path isn't swallowed by the int route.
@router.get("/public/{token}", dependencies=[Depends(rate_limit(120, 3600, "job_view"))])
def public_view_job(token: str, db: Session = Depends(get_db)):
    """Client-facing view of a single job via its confirm-link token."""
    job = _job_by_token(token, db)
    return _public_job_dict(job, db)


@router.post("/public/{token}/confirm", dependencies=[Depends(rate_limit(20, 3600, "job_confirm"))])
def public_confirm_job(token: str, db: Session = Depends(get_db)):
    """Customer confirms they'll be home/ready for the visit. Idempotent."""
    job = _job_by_token(token, db)
    if job.status == "cancelled":
        raise HTTPException(status_code=409, detail="This visit was cancelled.")
    if not job.customer_confirmed_at:
        job.customer_confirmed_at = datetime.now(timezone.utc)
        log_activity(
            db, "job_customer_confirmed", job_id=job.id, client_id=job.client_id,
            actor="client", summary="Customer confirmed the visit", commit=False,
        )
        db.commit()
    return {"status": "confirmed"}


class PublicRescheduleRequest(BaseModel):
    message: Optional[str] = None


@router.post("/public/{token}/request-reschedule", dependencies=[Depends(rate_limit(20, 3600, "job_reschedule_request"))])
def public_request_reschedule(token: str, data: PublicRescheduleRequest = None, db: Session = Depends(get_db)):
    """Customer asks to reschedule from the public link. Does NOT move the
    job — it queues the request for staff, same as a change-request on a
    quote; an operator still picks the new date/time from the schedule."""
    job = _job_by_token(token, db)
    if job.status == "cancelled":
        raise HTTPException(status_code=409, detail="This visit was cancelled.")
    msg = ((data.message if data else None) or "").strip()
    job.reschedule_requested_at = datetime.now(timezone.utc)
    job.reschedule_request_message = msg or None
    log_activity(
        db, "job_reschedule_requested", job_id=job.id, client_id=job.client_id,
        actor="client",
        summary=f"Customer requested a reschedule: {msg[:500]}" if msg else "Customer requested a reschedule",
        commit=False,
    )
    db.commit()
    when = f"{job.scheduled_date} {job.start_time}".strip()
    lines = [f"A customer requested to reschedule an upcoming visit ({when}).".strip()]
    if msg:
        lines += ["", f"“{msg}”"]
    lines += ["", "Open the schedule to pick a new time."]
    _notify_owner_job_event(f"\U0001f4c5 Reschedule requested: {job.title}", lines)
    return {"status": "received"}


@router.get("/public/{token}/availability", dependencies=[Depends(rate_limit(60, 3600, "job_availability"))])
def public_job_availability(token: str, db: Session = Depends(get_db)):
    """Open days + arrival windows a customer can move THIS visit to, for the
    self-reschedule picker on the public confirm page. 404s on a bad token;
    returns an empty `dates` list (not an error) when self-reschedule is off or
    nothing is open, so the page cleanly falls back to the request flow."""
    from modules.settings.router import customer_self_reschedule_enabled
    job = _job_by_token(token, db)
    enabled = customer_self_reschedule_enabled(db) and job.status != "cancelled"
    return {
        "enabled": enabled,
        "windows": [
            {"key": "morning", "label": "Morning (9am–12pm)"},
            {"key": "afternoon", "label": "Afternoon (1pm–4pm)"},
        ],
        "dates": _job_self_reschedule_availability(db, job) if enabled else [],
    }


class PublicSelfRescheduleRequest(BaseModel):
    date: str
    window: Optional[str] = "morning"
    # "this" (single visit) or "future" (this + all future) for a recurring
    # visit; ignored for one-off jobs (always treated as "this").
    scope: Optional[str] = "this"


def _win_label(window: str) -> str:
    return "morning (9am–12pm)" if window == "morning" else "afternoon (1pm–4pm)"


@router.post("/public/{token}/reschedule", dependencies=[Depends(rate_limit(20, 3600, "job_self_reschedule"))])
def public_self_reschedule(token: str, data: PublicSelfRescheduleRequest, db: Session = Depends(get_db)):
    """Customer moves their own visit to a new day + arrival window.

    Open slot → the job moves immediately (+ Google Calendar). Busy slot (a
    double-book) → the move is held as a PENDING APPROVAL: the owner gets a
    notification and approves it from the dashboard. Recurring visits carry a
    scope ('this' | 'future'). No new quote — the same booked job just moves,
    keeping its title, price, and details."""
    from modules.settings.router import customer_self_reschedule_enabled
    job = _job_by_token(token, db)
    if job.status == "cancelled":
        raise HTTPException(status_code=409, detail="This visit was cancelled.")
    if not customer_self_reschedule_enabled(db):
        raise HTTPException(
            status_code=409,
            detail="Online rescheduling isn't available right now — please send us a request instead.")

    d = _to_date(data.date)
    if not d or d < business_today() + timedelta(days=SELF_RESCHEDULE_MIN_LEAD_DAYS):
        raise HTTPException(status_code=400, detail="Please choose a valid upcoming date.")
    window = (data.window or "morning").lower()
    if window not in SELF_RESCHEDULE_WINDOWS:
        raise HTTPException(status_code=400, detail="Please choose a morning or afternoon window.")
    # Scope only applies to recurring visits.
    scope = (data.scope or "this").lower()
    if scope not in ("this", "future") or not job.recurring_schedule_id:
        scope = "this"
    # Re-check the day is still offerable (Sundays closed / out of the window).
    avail = _job_self_reschedule_availability(db, job)
    day = next((a for a in avail if a["date"] == d.isoformat()), None)
    if not day or window not in {w["key"] for w in day["windows"]}:
        raise HTTPException(status_code=409, detail="That day is no longer available. Please pick another.")
    start, end = SELF_RESCHEDULE_WINDOWS[window]

    old_when = f"{job.scheduled_date}" + (f" {job.start_time}" if job.start_time else "")
    nice_date = d.strftime("%B %d, %Y")
    who = job.client.name if job.client else "The customer"

    # ── Busy slot → hold for owner approval (double-book, don't move yet). ──
    if _slot_busy(db, job, d, start, end):
        job.reschedule_requested_at = datetime.now(timezone.utc)
        job.reschedule_requested_date = d
        job.reschedule_requested_start_time = _to_time(start)
        job.reschedule_requested_end_time = _to_time(end)
        job.reschedule_requested_scope = scope
        job.reschedule_request_message = None
        log_activity(
            db, "job_reschedule_requested", job_id=job.id, client_id=job.client_id,
            actor="client",
            summary=f"Customer requested to move the visit to {nice_date} ({window}) — awaiting approval (busy slot)",
            extra_data={"from": old_when, "to": f"{d.isoformat()} {start}", "window": window, "scope": scope},
            commit=False,
        )
        db.commit()
        lines = [
            f"{who} asked to move an upcoming visit onto a time you're already booked.",
            "", f"Was: {old_when}", f"Requested: {nice_date} ({_win_label(window)})",
            f"Applies to: {'this and all future visits' if scope == 'future' else 'this visit'}",
            "", "Approve or decline it from your dashboard — nothing has moved yet.",
        ]
        _notify_owner_job_event(f"\U0001f4c5 Reschedule needs approval: {job.title}", lines)
        return {"status": "pending_approval", "date": d.isoformat(), "date_label": nice_date,
                "window": window, "scope": scope}

    # ── Open slot → move immediately. ──
    try:
        resulting = _apply_reschedule_move(db, job, d, start, end, scope)
    except HTTPException:
        friendly = ("We couldn't lock that time right now. Please pick another, "
                    "or give us a call and we'll finish rescheduling by hand.")
        raise HTTPException(status_code=400, detail=friendly)

    resulting.customer_confirmed_at = datetime.now(timezone.utc)
    _clear_pending_reschedule(resulting)
    _clear_pending_reschedule(job)
    log_activity(
        db, "job_customer_rescheduled", job_id=resulting.id, client_id=resulting.client_id,
        actor="client",
        summary=f"Customer rescheduled the visit to {nice_date} ({window})"
                + (" and all future visits" if scope == "future" else ""),
        extra_data={"from": old_when, "to": f"{d.isoformat()} {start}", "window": window, "scope": scope},
        commit=False,
    )
    db.commit()

    lines = [
        f"{who} rescheduled an upcoming visit themselves.",
        "", f"Was: {old_when}", f"Now: {nice_date} ({_win_label(window)})",
        f"Applies to: {'this and all future visits' if scope == 'future' else 'this visit'}",
        "", "The job was moved and the calendar updated — reassign a cleaner if needed.",
    ]
    _notify_owner_job_event(f"\U0001f4c5 Visit rescheduled by customer: {job.title}", lines)
    return {"status": "rescheduled", "date": d.isoformat(), "date_label": nice_date,
            "window": window, "scope": scope, "start_time": start, "end_time": end}


def _clear_pending_reschedule(job: Job) -> None:
    job.reschedule_requested_at = None
    job.reschedule_request_message = None
    job.reschedule_requested_date = None
    job.reschedule_requested_start_time = None
    job.reschedule_requested_end_time = None
    job.reschedule_requested_scope = None


def _reschedule_request_dict(job: Job) -> dict:
    """A pending customer reschedule for the owner's approval queue."""
    return {
        "job_id": job.id,
        "title": job.title,
        "client_id": job.client_id,
        "client_name": job.client.name if job.client else None,
        "is_recurring": bool(job.recurring_schedule_id),
        "current_date": str(job.scheduled_date) if job.scheduled_date else None,
        "current_start_time": str(job.start_time) if job.start_time else None,
        "requested_at": job.reschedule_requested_at.isoformat() if job.reschedule_requested_at else None,
        "message": job.reschedule_request_message,
        # Present only for a concrete self-reschedule proposal (busy-slot hold);
        # a plain message request has requested_date == None (needs manual move).
        "requested_date": str(job.reschedule_requested_date) if job.reschedule_requested_date else None,
        "requested_start_time": str(job.reschedule_requested_start_time) if job.reschedule_requested_start_time else None,
        "requested_scope": job.reschedule_requested_scope,
        "needs_approval": job.reschedule_requested_date is not None,
    }


# Literal path — declared before the int `/{job_id}` route so it isn't
# swallowed by the int converter.
@router.get("/reschedule-requests", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_reschedule_requests(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Open customer reschedule requests for the dashboard queue — both concrete
    self-reschedule proposals awaiting approval (busy-slot holds) and plain
    'please move me' message requests."""
    org_id = resolve_org_id(org_id, db)
    rows = (
        db.query(Job).options(joinedload(Job.client))
        .filter(
            Job.reschedule_requested_at.isnot(None),
            Job.status.notin_(["cancelled", "completed"]),
            or_(Job.org_id == org_id, Job.org_id.is_(None)),
        )
        .order_by(Job.reschedule_requested_at.desc())
        .all()
    )
    return {"requests": [_reschedule_request_dict(j) for j in rows]}


@router.get("/recent-confirmations", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_recent_confirmations(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Visits a customer just confirmed (accepted their scheduled time), for the
    dashboard's low-priority 'customer activity' feed — these need no action, so
    they don't belong in 'Needs you now'. Last 7 days, upcoming visits only."""
    org_id = resolve_org_id(org_id, db)
    since = datetime.now(timezone.utc) - timedelta(days=7)
    rows = (
        db.query(Job).options(joinedload(Job.client))
        .filter(
            Job.customer_confirmed_at.isnot(None),
            Job.customer_confirmed_at >= since,
            Job.status.notin_(["cancelled", "completed"]),
            or_(Job.org_id == org_id, Job.org_id.is_(None)),
        )
        .order_by(Job.customer_confirmed_at.desc())
        .limit(12)
        .all()
    )
    return {"confirmations": [{
        "job_id": j.id,
        "title": j.title,
        "client_id": j.client_id,
        "client_name": j.client.name if j.client else None,
        "scheduled_date": str(j.scheduled_date) if j.scheduled_date else None,
        "start_time": str(j.start_time) if j.start_time else None,
        "confirmed_at": j.customer_confirmed_at.isoformat() if j.customer_confirmed_at else None,
    } for j in rows]}


def _get_owned_job(job_id: int, db: Session, org_id: int) -> Job:
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).options(joinedload(Job.client)).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/{job_id}/approve-reschedule", dependencies=[Depends(require_role("admin", "manager"))])
def approve_reschedule(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Owner approves a customer's pending (busy-slot) self-reschedule: apply the
    held date/window (+ Google Calendar) and clear the request."""
    job = _get_owned_job(job_id, db, org_id)
    if not job.reschedule_requested_date:
        raise HTTPException(status_code=409, detail="No pending reschedule to approve for this job.")
    d = job.reschedule_requested_date
    start = job.reschedule_requested_start_time.strftime("%H:%M") if job.reschedule_requested_start_time else "09:00"
    end = job.reschedule_requested_end_time.strftime("%H:%M") if job.reschedule_requested_end_time else "12:00"
    scope = job.reschedule_requested_scope or "this"
    old_when = f"{job.scheduled_date}" + (f" {job.start_time}" if job.start_time else "")
    resulting = _apply_reschedule_move(db, job, d, start, end, scope)
    resulting.customer_confirmed_at = datetime.now(timezone.utc)
    _clear_pending_reschedule(resulting)
    _clear_pending_reschedule(job)
    log_activity(
        db, "job_customer_rescheduled", job_id=resulting.id, client_id=resulting.client_id,
        actor="staff",
        summary=f"Approved customer reschedule to {d.strftime('%B %d, %Y')}"
                + (" (this + all future)" if scope == "future" else ""),
        extra_data={"from": old_when, "to": f"{d.isoformat()} {start}", "scope": scope},
        commit=False,
    )
    db.commit()
    return {"status": "approved", "job_id": resulting.id, "date": d.isoformat()}


@router.post("/{job_id}/decline-reschedule", dependencies=[Depends(require_role("admin", "manager"))])
def decline_reschedule(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Owner declines a pending customer reschedule (or clears a message-only
    request). The visit stays where it is."""
    job = _get_owned_job(job_id, db, org_id)
    if not job.reschedule_requested_at:
        raise HTTPException(status_code=409, detail="No pending reschedule for this job.")
    _clear_pending_reschedule(job)
    log_activity(
        db, "job_reschedule_requested", job_id=job.id, client_id=job.client_id,
        actor="staff", summary="Dismissed a customer reschedule request", commit=False,
    )
    db.commit()
    return {"status": "declined", "job_id": job.id}


@router.get("/{job_id}", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_job(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).options(joinedload(Job.client)).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_to_dict_enriched(db, job)


@router.get("/{job_id}/details", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_job_details(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id),
                    current_user=Depends(get_current_user)):
    """Full job record for the detail page: the job plus its linked records
    (client, opportunity, property, originating quote), related invoices, and
    the job-scoped activity timeline."""
    from database.models import Invoice, Opportunity, Quote, Activity
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).options(
        joinedload(Job.client), joinedload(Job.property), joinedload(Job.opportunity),
    ).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    invoices = db.query(Invoice).filter(
        Invoice.job_id == job.id,
        or_(Invoice.org_id == org_id, Invoice.org_id.is_(None)),
    ).all()

    # Crew accept/decline state (crew app Phase 2): one entry per ASSIGNED
    # cleaner, response=None until they answer. Declining never unassigns
    # (owner decision) — this list is exactly how the office finds out who
    # needs replacing. Names resolved here directly (same pattern as
    # _turnover_line: no cross-importing another module's private helper).
    from database.models import JobResponse as _JobResponse, User as _User
    cids = [str(c) for c in (job.cleaner_ids or [])]
    _resp_rows = {r.cleaner_id: r for r in db.query(_JobResponse).filter(
        _JobResponse.job_id == job.id).all()} if cids else {}
    _name_rows = {u.cleaner_id: (u.full_name or u.email) for u in db.query(_User).filter(
        _User.cleaner_id.in_(cids)).all()} if cids else {}
    crew_responses = [
        {
            "cleaner_id": cid,
            "name": _name_rows.get(cid, cid),
            "response": (_resp_rows[cid].response if cid in _resp_rows else None),
            "reason": (_resp_rows[cid].reason if cid in _resp_rows else None),
            "responded_at": (_resp_rows[cid].updated_at.isoformat()
                             if cid in _resp_rows and _resp_rows[cid].updated_at else None),
        }
        for cid in cids
    ]
    quote = None
    if job.quote_id:
        quote = db.query(Quote).filter(Quote.id == job.quote_id).first()
    timeline = db.query(Activity).filter(
        Activity.job_id == job.id,
    ).order_by(Activity.created_at.desc()).limit(50).all()

    return {
        **_job_to_dict_enriched(db, job),
        # Photos the office Complete modal stored inline on Job.photos (data
        # URLs / pasted links) BEFORE the job_photos table existed. Emitted so
        # the JobDetail gallery can finally show them — they used to be
        # write-only. New photos live in job_photos (GET /api/crew/jobs/{id}/photos).
        "photos_legacy": job.photos or [],
        "crew_responses": crew_responses,
        "property": ({"id": job.property.id, "name": job.property.name,
                      "address": job.property.address,
                      # Access fields surface here so the office can SEE a
                      # missing door code from the job page (owner bug
                      # report: crew cards looked broken when the property
                      # simply had no code on file) — and fill it in place.
                      # BB-SEC-12: for a CLEANER these ride only on their own
                      # assigned jobs — this office endpoint used to hand any
                      # cleaner any org job's door code by id. Office roles
                      # are unchanged; the crew app (/api/crew/*) enforces the
                      # same assigned-only rule for its own payloads.
                      **({"house_code": job.property.house_code,
                          "access_notes": job.property.access_notes}
                         if (getattr(current_user, "role", None) != "cleaner"
                             or str(getattr(current_user, "cleaner_id", "")) in
                                [str(c) for c in (job.cleaner_ids or [])])
                         else {"house_code": None, "access_notes": None})}
                     if job.property else None),
        "opportunity": ({"id": job.opportunity.id, "title": job.opportunity.title, "stage": job.opportunity.stage}
                        if job.opportunity else None),
        # Include items + tax_rate + subtotal/tax so the JobDetail "New invoice"
        # button can seed the invoice with the linked quote's real line items
        # instead of a $0 placeholder — otherwise an invoice created from a
        # $150 quote used to save as $0.00 (audit bug).
        "quote": ({"id": quote.id, "quote_number": quote.quote_number, "status": quote.status,
                   "total": quote.total, "subtotal": quote.subtotal,
                   "tax": quote.tax, "tax_rate": quote.tax_rate,
                   "items": quote.items or []}
                  if quote else None),
        "invoices": [
            {"id": inv.id, "invoice_number": inv.invoice_number, "status": inv.status, "total": inv.total,
             "created_at": inv.created_at.isoformat() if inv.created_at else None}
            for inv in invoices
        ],
        "timeline": [
            {"id": a.id, "activity_type": a.activity_type, "summary": a.summary, "actor": a.actor,
             "created_at": a.created_at.isoformat() if a.created_at else None}
            for a in timeline
        ],
    }


@router.get("/{job_id}/timeline", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_job_timeline(
    job_id: int,
    source: Optional[str] = None,  # "activity" | "integration" | "message" | None (all)
    limit: int = 150,
    offset: int = 0,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Unified, chronological activity timeline for a job — Pillar 3 connective
    tissue. Merges three existing signals into one newest-first feed:

    - **Activity** records (job created/completed, note added, quote/invoice
      milestones) — the human-readable story.
    - **IntegrationEvent** rows (Google Calendar / Connecteam / email / SMS
      sync attempts, ok or failed) — "did it actually go out, and why not?".
    - **Message** records (SMS/email to the client) — the conversation.

    Every entry is normalised to a common shape so the frontend renders them in
    a single stream. ``source`` narrows to one kind; ``limit``/``offset``
    paginate the merged result.
    """
    from database.models import Activity, IntegrationEvent, Message
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    items: list[dict] = []

    if source in (None, "activity"):
        for a in db.query(Activity).filter(Activity.job_id == job_id).all():
            items.append({
                "kind": "activity",
                "id": f"activity-{a.id}",
                "icon_key": a.activity_type,
                "label": a.summary,
                "sub": None,
                "actor": a.actor,
                "status": None,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            })

    if source in (None, "integration"):
        events = db.query(IntegrationEvent).filter(
            IntegrationEvent.entity_type == "job",
            IntegrationEvent.entity_id == job_id,
        ).all()
        for e in events:
            provider = (e.provider or "").lower()
            pretty = {"gcal": "Google Calendar", "connecteam": "Connecteam",
                      "email": "Email", "sms": "SMS"}.get(provider, e.provider or "Sync")
            ok = (e.status or "").lower() == "ok"
            items.append({
                "kind": "integration",
                "id": f"integration-{e.id}",
                "icon_key": provider,
                "label": f"{pretty} {e.action or 'sync'} {'succeeded' if ok else 'failed'}",
                "sub": None if ok else e.error_message,
                "actor": None,
                "status": e.status,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            })

    if source in (None, "message"):
        for m in db.query(Message).filter(Message.job_id == job_id).all():
            snippet = (m.body or "").strip().replace("\n", " ")
            if len(snippet) > 140:
                snippet = snippet[:140] + "…"
            channel = (m.channel or "message").lower()
            direction = (m.direction or "").lower()
            verb = {"inbound": "Received", "outbound": "Sent", "note": "Note"}.get(direction, "")
            items.append({
                "kind": "message",
                "id": f"message-{m.id}",
                "icon_key": channel,
                "label": m.subject or f"{verb} {channel.upper()}".strip(),
                "sub": snippet or None,
                "actor": m.author,
                "status": m.status,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            })

    # Newest first; entries with no timestamp sink to the bottom.
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    total = len(items)
    return {
        "job_id": job_id,
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": items[offset:offset + limit],
    }


@router.post("/{job_id}/notes", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def add_job_note(job_id: int, data: dict, db: Session = Depends(get_db),
                 current_user=Depends(get_current_user), org_id: int = Depends(current_org_id)):
    """Jot an internal note on a job. Recorded as a NOTE_ADDED activity anchored
    to the job (and its client) so it lands in the job's timeline."""
    from database.models import ActivityType
    from modules.activities.router import activity_to_dict
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    body = (data.get("body") or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="Note body is required")

    actor = getattr(current_user, "email", None) or getattr(current_user, "full_name", None) or "staff"
    act = log_activity(
        db, ActivityType.NOTE_ADDED.value,
        client_id=job.client_id, job_id=job.id, actor=actor, summary=body,
        extra_data={"note": True}, commit=False,
    )
    if not act:
        raise HTTPException(status_code=500, detail="Could not record note")
    db.commit()
    db.refresh(act)
    return activity_to_dict(act)


def _get_job_or_404(db: Session, job_id: int, org_id: int) -> Job:
    """Fetch a Job scoped to the caller's org, 404 otherwise.

    Several job-action endpoints (complete/skip/invite-client/auto-assign/
    crew-suggestions) used to do a bare `db.query(Job).filter(Job.id ==
    job_id).first()` with no org filter at all — a cross-tenant IDOR: any
    authenticated user in any org could act on any other org's job by
    guessing/incrementing an id. Matches the `or_(Job.org_id == org_id,
    Job.org_id.is_(None))` convention already used by get_job/update_job
    (Job.org_id is still nullable — MT-4 NOT NULL backfill hasn't shipped).
    404, not 403, so the response doesn't reveal that the id exists at all.
    """
    job = db.query(Job).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# Moved to modules/scheduling/completion.py so the crew router can share it
# without importing a private out of this (shrinking — R6) monolith. The alias
# keeps the two in-file call sites and test_invoice_numbering's import working.
from modules.scheduling.completion import auto_create_draft_invoice as _auto_create_draft_invoice  # noqa: E402


@router.patch("/{job_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_job(job_id: int, data: JobUpdate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).options(joinedload(Job.client)).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    prev_status = job.status
    prev_job_type = job.job_type or "residential"
    prev_scheduled_date = job.scheduled_date
    prev_start_time = job.start_time
    updates = data.model_dump(exclude_none=True)
    allow_conflicts = updates.pop("allow_conflicts", False)
    # Per-move notify override — pull it out before the setattr loop (it's not a
    # Job column). None → use the Settings toggle; True/False → force this move's
    # customer email on/off. Folded into _upd_su below.
    notify_override = updates.pop("notify_customer", None)

    # The edit modal sends EVERY field, so a job whose stored status/type
    # predates the current vocabulary must not become uneditable: the job's
    # own current value always passes (a no-op), only CHANGES are validated.
    if "job_type" in updates and updates["job_type"] not in JOB_TYPES \
            and updates["job_type"] != job.job_type:
        raise HTTPException(status_code=400, detail=f"Unknown job_type '{updates['job_type']}'")
    if "pay_mode" in updates and updates["pay_mode"] not in PAY_MODES \
            and updates["pay_mode"] != job.pay_mode:
        raise HTTPException(status_code=400, detail=f"Unknown pay_mode '{updates['pay_mode']}'")
    if updates.get("pay_rate_bump") is not None and updates["pay_rate_bump"] < 0:
        raise HTTPException(status_code=400, detail="pay_rate_bump cannot be negative")
    if "status" in updates and updates["status"] not in JOB_STATUSES \
            and updates["status"] != job.status:
        raise HTTPException(status_code=400, detail=f"Unknown status '{updates['status']}'")
    if "property_id" in updates:
        prop = db.query(Property).filter(
            Property.id == updates["property_id"],
            or_(Property.org_id == org_id, Property.org_id.is_(None)),  # MT-2 tenant scope
        ).first()
        if not prop:
            raise HTTPException(status_code=404, detail="Property not found")
        # Ownership must stay consistent: re-pointing a job at another
        # client's property would leave invoices/activities/calendar tied to
        # the OLD client (Codex P1 on #271). A job with no client adopts the
        # property's owner instead.
        if job.client_id and prop.client_id and prop.client_id != job.client_id:
            raise HTTPException(
                status_code=400,
                detail="That property belongs to a different client. Pick one of this "
                       "client's properties (or move the job from the other client's profile).",
            )
        if not job.client_id and prop.client_id:
            updates["client_id"] = prop.client_id

    # Validate + conflict-check against the RESULTING values (incoming or
    # existing). Skip both when the edit only cancels the job. is_new=False so
    # editing a past job (e.g. to mark it completed) stays allowed.
    eff_date = updates.get("scheduled_date", job.scheduled_date)
    eff_start = updates.get("start_time", job.start_time)
    eff_end = updates.get("end_time", job.end_time)
    eff_cleaners = updates.get("cleaner_ids", job.cleaner_ids)
    eff_status = updates.get("status", job.status)

    if eff_status != "cancelled":
        _validate_job_timing(eff_date, eff_start, eff_end, is_new=False)
        if not allow_conflicts and ("scheduled_date" in updates or "start_time" in updates
                                    or "end_time" in updates or "cleaner_ids" in updates):
            # org_id was already resolved at the top of update_job.
            conflicts = _find_cleaner_conflicts(
                db, cleaner_ids=eff_cleaners, scheduled_date=eff_date,
                start_time=eff_start, end_time=eff_end, exclude_job_id=job.id,
                org_id=org_id,
            )
            if conflicts:
                raise HTTPException(status_code=409, detail=_conflict_detail(conflicts))
            unavailable = _find_unavailable_cleaners(
                db, cleaner_ids=eff_cleaners, scheduled_date=eff_date,
                org_id=org_id,
            )
            if unavailable:
                raise HTTPException(status_code=409, detail=_unavailable_detail(unavailable))
            over = _find_over_capacity(
                db, cleaner_ids=eff_cleaners, scheduled_date=eff_date, exclude_job_id=job.id,
                org_id=org_id,
            )
            if over:
                who = ", ".join(f"cleaner {cid} ({n} jobs)" for cid, n in over)
                raise HTTPException(
                    status_code=409,
                    detail=f"Over capacity: {who} would exceed the daily limit of "
                           f"{CAPACITY_PER_CLEANER_PER_DAY}. Resubmit with allow_conflicts=true to override.",
                )

    # Store real date/time objects (the columns are Date/Time) instead of the
    # inbound strings — portable across SQLite/Postgres, matches create_job.
    if "scheduled_date" in updates:
        updates["scheduled_date"] = _to_date(updates["scheduled_date"])
    if "start_time" in updates:
        updates["start_time"] = _to_time(updates["start_time"])
    if "end_time" in updates:
        updates["end_time"] = _to_time(updates["end_time"])

    # Auto-promote "unscheduled" to "scheduled" when the operator finally
    # adds a date. This is the transition converted-quote jobs need — they
    # land as "unscheduled" (no date), and setting a date is the signal
    # that they're now actually on the calendar.
    #
    # The Job Edit modal sends the FULL payload on every save (including an
    # unchanged status), so "status" is present in `updates` even when the
    # operator only picked a date. Guard on the value: promote only when
    # the incoming status equals the current status (i.e. wasn't actually
    # changed to something else like "cancelled"). Anything else the
    # operator explicitly picked wins.
    if (
        prev_status == "unscheduled"
        and updates.get("scheduled_date")
        and updates.get("status", prev_status) == prev_status
    ):
        updates["status"] = "scheduled"
    prev_cleaner_ids = [str(c) for c in (job.cleaner_ids or [])]
    # Economy audit H3 / scheduling-invariants R4: capture, BEFORE the edit is
    # applied, exactly the fields the Google Calendar event serializes (the
    # job_dict below plus the client). The edit modal sends the full payload on
    # every save, so without this gate every note edit, cleaner swap, or
    # status flip re-pushed an unchanged event to Google.
    _gcal_sig_before = (
        job.title, job.job_type, job.scheduled_date, job.start_time,
        job.end_time, job.address, job.notes, job.property_id, job.client_id,
    )
    for field, value in updates.items():
        setattr(job, field, value)

    # Assignment changed → drop the accept/decline answers of anyone REMOVED,
    # so a cleaner taken off (after declining, say) and re-added later starts
    # at "no answer yet" instead of wearing a stale response (crew app Phase 3
    # cleanup of the Phase 2 edge). Answers of cleaners still on the job keep.
    if "cleaner_ids" in updates:
        removed = set(prev_cleaner_ids) - {str(c) for c in (job.cleaner_ids or [])}
        if removed:
            from database.models import JobResponse as _JR
            db.query(_JR).filter(_JR.job_id == job.id,
                                 _JR.cleaner_id.in_(removed)).delete(synchronize_session=False)

    # A move to a new day/time invalidates two things the customer's OLD time
    # carried: their confirmation (they agreed to a time that no longer exists)
    # and the "reminder already sent" flag (the new date deserves its own
    # reminder). Reset both so a rescheduled visit isn't shown as "confirmed"
    # for a time the customer never saw, and still gets a 24h reminder. Only
    # when the visit stays active — a cancel isn't a reschedule.
    moved = (job.status != "cancelled" and (
        ("scheduled_date" in updates and job.scheduled_date != prev_scheduled_date)
        or ("start_time" in updates and job.start_time != prev_start_time)))
    if moved:
        if job.customer_confirmed_at is not None:
            job.customer_confirmed_at = None
        if getattr(job, "sms_reminder_sent", False):
            job.sms_reminder_sent = False

    db.commit()
    db.refresh(job)
    # Log status transitions to the unified timeline
    if job.status != prev_status:
        log_job_status_change(db, job, prev_status)
        db.commit()

    # Newly-ADDED cleaners get a "new job for you" push (event-driven at the
    # assignment write, post-commit). Only the added set — an unrelated edit,
    # or a cleaner already on the job, never re-pings the crew. Cancelled jobs
    # don't announce themselves as new work.
    if "cleaner_ids" in updates and job.status != "cancelled":
        added_cleaners = {str(c) for c in (job.cleaner_ids or [])} - set(prev_cleaner_ids)
        if added_cleaners:
            from services.crew_notify import notify_job_assigned
            notify_job_assigned(db, job, sorted(added_cleaners))

    # Auto-create a draft Invoice the first time a job lands on "completed".
    # Shared with complete_job() below — both are real "mark complete" paths
    # (this one via the office-side status dropdown/edit modal, that one via
    # the field checklist flow) and used to only auto-invoice from here,
    # so an operator who completed a job through the field UI never got a
    # draft invoice at all.
    if job.status == "completed" and prev_status != "completed":
        _auto_create_draft_invoice(db, job)
    # (The old Visit-status-sync loop was dropped by migration 039; Job.status
    # is the single source of scheduling-lifecycle truth now.)

    # Google Calendar sync. Cancelling pulls the job off the schedule everywhere
    # (Job.status='cancelled' is now the single truth after migration 039) and
    # removes the Google Calendar event.
    # Google Calendar notification + reminder prefs (Settings → Automation),
    # resolved once for whichever branch below runs. `_gcal_notify` gates
    # whether Google emails the customer; `_gcal_reminders` is the event's
    # reminder block (default: Google's own).
    from modules.settings.router import (
        customer_invites_enabled as _inv_enabled,
        customer_notify_enabled as _notify_enabled,
        customer_notify_on_move_enabled as _notify_on_move_enabled,
        gcal_reminder_overrides as _reminder_overrides,
    )
    _gcal_notify = _notify_enabled(db)
    # Moving/editing an existing event only emails the customer when BOTH the
    # master notify switch AND the move-specific toggle are on. Default: master
    # on, move off → booking invites + cancellations still email, but nudging a
    # job around the calendar updates their copy silently (the wished-for
    # "don't ping them every time we move it"). Create + cancel keep using
    # `_gcal_notify` directly below, so this only affects in-place updates.
    _notify_on_move = _notify_on_move_enabled(db)
    _gcal_reminders = _reminder_overrides(db)
    _cancel_su = "all" if _gcal_notify else "none"

    if job.status == "cancelled":
        if job.gcal_event_id:
            old_event_id = job.gcal_event_id
            try:
                from integrations.google_calendar import delete_event
                # delete_event returns False (doesn't raise) when Google rejects
                # or is unavailable. Only detach the id on success, so a failed
                # delete can be retried next time rather than orphaning the event.
                if delete_event(job.gcal_event_id, prev_job_type,
                                owner_account_id=getattr(job, "gcal_account_id", None),
                                send_updates=_cancel_su):
                    job.gcal_event_id = None
                    _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                                     action="delete", status="ok", external_id=old_event_id, commit=False)
                else:
                    logger.warning(f"GCal delete did not apply for cancelled job {job.id}; keeping event id to retry")
                    _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                                     action="delete", status="failed", external_id=old_event_id,
                                     detail="delete_event returned False (kept id to retry)", commit=False)
            except Exception as e:
                logger.warning(f"GCal delete failed for cancelled job {job.id}: {e}")
                _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                                 action="delete", status="failed", external_id=old_event_id,
                                 detail=str(e), commit=False)
        db.commit()
        db.refresh(job)
    elif not job.gcal_event_id and job.scheduled_date and job.status not in ("cancelled", "unscheduled"):
        # No Google event yet (e.g. a converted-quote job, or one created while
        # Google was disconnected) and it now has a date — create the event
        # inline so a reschedule shows on Google immediately, instead of waiting
        # up to 30 min for the reconcile tick. Best-effort; the reconcile sweep
        # is still the backstop if this no-ops (Google not connected).
        try:
            from integrations.google_calendar import (
                create_event, is_configured, active_account_id as _gcal_acct,
            )
            if is_configured():
                client = db.query(Client).filter(Client.id == job.client_id).first()
                client_dict = {"id": client.id if client else None,
                               "name": client.name if client else "",
                               "email": getattr(client, "email", None)}
                job_dict = {
                    "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                    "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                    "end_time": job.end_time, "address": job.address, "notes": job.notes,
                    "property_id": job.property_id,
                }
                _inv = _inv_enabled(db) and bool(client and client.email)
                new_event_id = create_event(
                    job_dict, client_dict, send_invite=_inv, reminders=_gcal_reminders,
                    send_updates=("all" if (_inv and _gcal_notify) else "none"))
                if new_event_id:
                    job.gcal_event_id = new_event_id
                    job.gcal_account_id = _gcal_acct()
                    log_calendar_event(
                        db, "created", client_id=job.client_id, job_id=job.id,
                        title=job.title, gcal_event_id=new_event_id,
                        scheduled_date=str(job.scheduled_date) if job.scheduled_date else None,
                    )
                    db.commit()
        except Exception as e:
            logger.warning(f"GCal inline create failed for job {job.id}: {e}")
    elif job.gcal_event_id and (
        job.title, job.job_type, job.scheduled_date, job.start_time,
        job.end_time, job.address, job.notes, job.property_id, job.client_id,
    ) != _gcal_sig_before:
        # Only push to Google when a field the event actually carries changed
        # (see _gcal_sig_before above). Unchanged-event edits skip the API
        # call, the timeline row, and the failure logging entirely.
        try:
            from integrations.google_calendar import (
                _calendar_id, create_event, delete_event, update_event,
            )
            client = db.query(Client).filter(Client.id == job.client_id).first()
            client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None)}
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
                "property_id": job.property_id,
            }
            # Keep the customer on the invite through a reschedule. events().update
            # is a full REPLACE, so NOT passing send_invite here silently dropped
            # the customer as an attendee (their invite went stale) and, with
            # sendUpdates="none", they were never told the time moved. Pass the
            # invite + notify/reminder prefs so a reschedule updates their copy
            # and (per Settings) emails them the change.
            _inv = _inv_enabled(db) and bool(client and client.email)
            # A move/edit of an already-synced event: silent unless the operator
            # has explicitly opted into move emails. send_invite stays `_inv`, so
            # the customer remains an attendee and their calendar copy updates —
            # only the *email* is suppressed (sendUpdates="none").
            #
            # Precedence: an explicit per-move `notify_customer` (from the edit
            # form / drag toggle) wins for THIS call; otherwise fall back to the
            # Settings default (master notify AND the "email on move" toggle).
            _move_emails = bool(notify_override) if notify_override is not None else (_gcal_notify and _notify_on_move)
            _upd_su = "all" if (_inv and _move_emails) else "none"
            new_type = job.job_type or "residential"
            if _calendar_id(prev_job_type) != _calendar_id(new_type):
                # The event lives on the OLD type's calendar — updating in
                # place would look it up on the NEW calendar, fail silently,
                # and leave Google stale (Codex P2 on #271). Move it:
                # delete from the old calendar, recreate on the new one.
                if delete_event(job.gcal_event_id, prev_job_type,
                                owner_account_id=getattr(job, "gcal_account_id", None),
                                send_updates=_upd_su):
                    new_event_id = create_event(job_dict, client_dict, send_invite=_inv,
                                                reminders=_gcal_reminders, send_updates=_upd_su)
                    if new_event_id:
                        from integrations.google_calendar import active_account_id as _gcal_acct
                        job.gcal_event_id = new_event_id
                        job.gcal_account_id = _gcal_acct()
                    else:
                        job.gcal_event_id = None  # reconcile flow can re-push
                    db.commit()
                    db.refresh(job)
                else:
                    # Delete didn't apply (Google down / auth) — creating now
                    # would leave DUPLICATE events. Keep the old id so the
                    # move retries on the next edit.
                    logger.warning(f"GCal move skipped for job {job.id}: delete on "
                                   f"'{prev_job_type}' calendar did not apply; will retry")
            else:
                # update_event returns False (doesn't raise) when Google rejects
                # or is unavailable. Capture it so a FAILED sync isn't recorded as
                # a successful "updated" on the timeline (which made DB↔calendar
                # divergence invisible — the DB had the new time, Google the old,
                # and the log claimed success).
                update_ok = update_event(
                    job.gcal_event_id, job_dict, client_dict,
                    send_invite=_inv, reminders=_gcal_reminders, send_updates=_upd_su,
                    owner_account_id=getattr(job, "gcal_account_id", None))
                if not update_ok:
                    logger.warning(f"GCal update did not apply for job {job.id}; DB and "
                                   f"calendar may differ until the next edit")
                    _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                                     action="update", status="failed", external_id=job.gcal_event_id,
                                     detail="update_event returned False", commit=False)
                    db.commit()
                    raise _GcalSyncSkipped()
            # Record the reschedule/edit on the client timeline. Create and
            # cancel were already logged; an in-place move/edit used to be silent,
            # so "why did this job move?" had no answer on the profile.
            if job.gcal_event_id:
                log_calendar_event(
                    db, "updated",
                    client_id=job.client_id, job_id=job.id,
                    title=job.title, gcal_event_id=job.gcal_event_id,
                    scheduled_date=str(job.scheduled_date) if job.scheduled_date else None,
                )
                db.commit()
        except _GcalSyncSkipped:
            pass  # already logged the failure; skip the success timeline entry
        except Exception as e:
            logger.warning(f"GCal update failed for job {job.id}: {e}")

    out = _job_to_dict_enriched(db, job)
    # So the caller (JobDetail.jsx's "Ready to bill?" banner) can tell an
    # invoice was already auto-created by this same request and skip
    # prompting for a second one — the banner used to check stale
    # client-side state that could never see the invoice this call had
    # just created.
    from database.models import Invoice
    out["has_invoice"] = db.query(Invoice).filter(Invoice.job_id == job.id).first() is not None
    return out


class ReminderSettings(BaseModel):
    skip_reminder: bool  # True = suppress the 24h SMS for this job


@router.patch("/{job_id}/reminder-settings", dependencies=[Depends(require_role("admin", "manager"))])
def update_reminder_settings(
    job_id: int,
    data: ReminderSettings,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
    org_id: int = Depends(current_org_id),
):
    """Toggle SMS reminder suppression for a single job (hybrid model).

    Reminders are on by default; setting skip_reminder=true suppresses the 24h
    SMS for this job only, without disabling the system-wide reminder job.
    """
    job = _get_job_or_404(db, job_id, resolve_org_id(org_id, db))

    job.skip_sms_reminder = bool(data.skip_reminder)
    db.commit()
    db.refresh(job)

    actor = getattr(user, "email", None) or getattr(user, "username", None) or "unknown"
    log_activity(
        db,
        "reminder_disabled" if data.skip_reminder else "reminder_enabled",
        job_id=job.id,
        client_id=job.client_id,
        actor=actor,
        summary=("SMS reminder disabled for this job"
                 if data.skip_reminder else "SMS reminder re-enabled for this job"),
        commit=True,
    )
    return {
        "job_id": job.id,
        "skip_sms_reminder": job.skip_sms_reminder,
        "message": f"Reminder {'disabled' if data.skip_reminder else 'enabled'} for this job",
    }


@router.delete("/{job_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_job(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # Log to timeline before delete (FK rows are detached when job goes away,
    # but the activity row's job_id link still survives via the column value).
    log_calendar_event(
        db, "cancelled",
        client_id=job.client_id, job_id=job.id,
        title=job.title, gcal_event_id=job.gcal_event_id,
    )
    # Remove from Google Calendar if event exists. The job row is hard-deleted
    # below regardless, so if the delete doesn't apply the calendar event is
    # ORPHANED (no id left to retry from). Capture the outcome and log a failure
    # to the integration log so an orphan is at least visible/auditable rather
    # than silently stranded on the calendar.
    if job.gcal_event_id:
        old_event_id = job.gcal_event_id
        try:
            from integrations.google_calendar import delete_event
            from modules.settings.router import customer_notify_enabled
            deleted_ok = delete_event(job.gcal_event_id, job.job_type or "residential",
                                      owner_account_id=getattr(job, "gcal_account_id", None),
                                      send_updates=("all" if customer_notify_enabled(db) else "none"))
            if not deleted_ok:
                logger.warning(f"GCal delete did not apply for deleted job {job.id}; "
                               f"event {old_event_id} may be orphaned on the calendar")
                _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                                 action="delete", status="failed", external_id=old_event_id,
                                 detail="delete_event returned False on hard-delete (possible orphan)",
                                 commit=False)
        except Exception as e:
            logger.warning(f"GCal delete failed for job {job.id}: {e}")
            _log_integration(db, entity_type="job", entity_id=job.id, org_id=job.org_id, provider="gcal",
                             action="delete", status="failed", external_id=old_event_id,
                             detail=str(e), commit=False)
    db.delete(job)
    db.commit()


@router.post("/{job_id}/invite-client", dependencies=[Depends(require_role("admin", "manager"))])
def invite_client(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """
    Send the Google Calendar invite to the client for this job.
    Use this when you've finalized the schedule and are ready for the client to see it.
    """
    oid = resolve_org_id(org_id, db)
    job = db.query(Job).options(joinedload(Job.client)).filter(
        Job.id == job_id,
        or_(Job.org_id == oid, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    client = job.client
    if not client or not client.email:
        raise HTTPException(status_code=400, detail="Client has no email address — add one before inviting")

    if not job.gcal_event_id:
        # Job doesn't have a GCal event yet — create one WITH the invite
        try:
            from integrations.google_calendar import create_event
            client_dict = {"id": client.id, "name": client.name, "email": client.email}
            # Ensure a confirm/reschedule token so the customer event can carry a
            # direct link to manage this visit.
            _ensure_job_public_token(job)
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
                "property_id": job.property_id, "public_token": job.public_token,
            }
            event_id = create_event(job_dict, client_dict, send_invite=True)
            if event_id:
                job.gcal_event_id = event_id
                from integrations.google_calendar import active_account_id as _gcal_acct
                job.gcal_account_id = _gcal_acct()
                job.calendar_invite_sent = True
                db.commit()
                return {"invited": True, "message": f"Created GCal event and sent invite to {client.email}"}
            raise HTTPException(status_code=502, detail="Failed to create GCal event")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"GCal error: {e}")

    # Job already has a GCal event — add client as attendee
    try:
        from integrations.google_calendar import invite_client_to_event
        success = invite_client_to_event(
            job.gcal_event_id,
            job.job_type or "residential",
            client.email,
            client.name,
            owner_account_id=getattr(job, "gcal_account_id", None),
        )
        if success:
            job.calendar_invite_sent = True
            db.commit()
            return {"invited": True, "message": f"Invite sent to {client.email}"}
        raise HTTPException(status_code=502, detail="Failed to send invite")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"GCal error: {e}")


@router.post("/admin/rehydrate-job-dates-from-gcal", dependencies=[Depends(require_role("admin", "manager"))])
def rehydrate_job_dates_from_gcal(
    dry_run: bool = False,
    limit: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """
    Admin endpoint that rehydrates nulled date fields on jobs by reading
    authoritative data from Google Calendar.

    Every job with scheduled_date=NULL but gcal_event_id set will be updated
    with the correct dates from the corresponding GCal event.

    Query params:
    - dry_run=true: returns what WOULD change without writing
    - limit=N: test on first N jobs (useful for verification before full run)
    """
    from integrations.google_calendar import _get_service, _calendar_id

    try:
        service = _get_service()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=f"Google Calendar not configured: {e}")

    tz = ZoneInfo("America/New_York")

    # Find all jobs with NULL scheduled_date but valid gcal_event_id
    query = db.query(Job).filter(
        Job.scheduled_date.is_(None),
        Job.gcal_event_id.isnot(None),
    )

    if limit:
        query = query.limit(limit)

    jobs_to_check = query.all()
    total_checked = len(jobs_to_check)

    updated_count = 0
    skipped_already_populated = 0
    skipped_no_gcal_id = 0
    errors = []
    sample_updates = []

    logger.info(f"[Rehydrate] Starting: {total_checked} jobs to check")

    for idx, job in enumerate(jobs_to_check):
        try:
            # Skip if already populated
            if job.scheduled_date is not None:
                skipped_already_populated += 1
                continue

            if not job.gcal_event_id:
                skipped_no_gcal_id += 1
                continue

            # Log progress every 10 jobs
            if (idx + 1) % 10 == 0:
                logger.info(f"[Rehydrate] Progress: {idx + 1}/{total_checked} checked")

            # Fetch the event from GCal
            # Note: gcal_event_id can be a recurring instance ID like "id_20260407T130000Z"
            cal_id = _calendar_id(job.job_type or "residential")
            event = service.events().get(
                calendarId=cal_id,
                eventId=job.gcal_event_id,
            ).execute()

            # Extract date/time information
            start_info = event.get("start", {})
            end_info = event.get("end", {})

            # Determine if it's a timed event or all-day event
            if "dateTime" in start_info:
                # Timed event: parse dateTime (UTC format like "2026-04-07T13:00:00Z")
                start_dt = datetime.fromisoformat(start_info["dateTime"].replace("Z", "+00:00"))
                end_dt = datetime.fromisoformat(end_info["dateTime"].replace("Z", "+00:00"))

                # Convert to local timezone
                start_local = start_dt.astimezone(tz)
                end_local = end_dt.astimezone(tz)

                new_date = start_local.date()
                new_start_time = start_local.time()
                new_end_time = end_local.time()
                source = "gcal_instance"
            else:
                # All-day event: parse date (format like "2026-04-07")
                date_str = start_info.get("date")
                if date_str:
                    new_date = datetime.strptime(date_str, "%Y-%m-%d").date()
                    new_start_time = time(9, 0, 0)  # Default to 9am-5pm
                    new_end_time = time(17, 0, 0)
                    source = "gcal_all_day"
                else:
                    # Fallback: try to parse from event ID if it's a recurring instance
                    if "_" in job.gcal_event_id:
                        try:
                            parts = job.gcal_event_id.split("_")
                            timestamp_str = parts[-1]  # "20260407T130000Z"
                            dt_utc = datetime.strptime(timestamp_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
                            dt_local = dt_utc.astimezone(tz)
                            new_date = dt_local.date()
                            new_start_time = dt_local.time()
                            new_end_time = time(17, 0, 0)  # Assume same-day 5pm end
                            source = "parsed_from_id"
                        except Exception as parse_err:
                            logger.warning(f"[Rehydrate] Could not parse event ID {job.gcal_event_id}: {parse_err}")
                            errors.append({
                                "job_id": job.id,
                                "gcal_event_id": job.gcal_event_id,
                                "error": f"Could not extract date/time: {str(parse_err)}"
                            })
                            continue
                    else:
                        logger.warning(f"[Rehydrate] Event {job.gcal_event_id} has no dateTime or date")
                        errors.append({
                            "job_id": job.id,
                            "gcal_event_id": job.gcal_event_id,
                            "error": "Event has no dateTime or date field"
                        })
                        continue

            # If dry_run, just collect samples
            if dry_run:
                if len(sample_updates) < 5:
                    sample_updates.append({
                        "job_id": job.id,
                        "scheduled_date": str(new_date),
                        "start_time": str(new_start_time),
                        "end_time": str(new_end_time),
                        "source": source,
                    })
                updated_count += 1
            else:
                # Update the job. new_date/new_start_time/new_end_time are already
                # date/time objects — assign them directly to the Date/Time
                # columns (str() here produced strings that only Postgres coerced).
                job.scheduled_date = new_date
                job.start_time = new_start_time
                job.end_time = new_end_time
                db.add(job)
                updated_count += 1

                if len(sample_updates) < 5:
                    sample_updates.append({
                        "job_id": job.id,
                        "scheduled_date": str(new_date),
                        "start_time": str(new_start_time),
                        "end_time": str(new_end_time),
                        "source": source,
                    })

        except Exception as e:
            error_msg = str(e)
            logger.warning(f"[Rehydrate] Job {job.id}: {error_msg}")
            errors.append({
                "job_id": job.id,
                "gcal_event_id": job.gcal_event_id or "unknown",
                "error": error_msg,
            })

    # Commit all updates at once (unless dry_run)
    if not dry_run and updated_count > 0:
        try:
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"[Rehydrate] Commit failed: {e}")
            raise HTTPException(status_code=500, detail=f"Database commit failed: {e}")

    logger.info(f"[Rehydrate] Complete: updated={updated_count}, skipped_already_populated={skipped_already_populated}, skipped_no_gcal_id={skipped_no_gcal_id}, errors={len(errors)}")

    return {
        "total_jobs_checked": total_checked,
        "updated": updated_count,
        "skipped_already_populated": skipped_already_populated,
        "skipped_no_gcal_id": skipped_no_gcal_id,
        "errors": errors,
        "dry_run": dry_run,
        "sample_updates": sample_updates,
    }


# ============================================================================
# Job/Visit unification (PR-A)
#
# These endpoints port the four Visit-only capabilities onto /api/jobs so the
# frontend can migrate off /api/visits (PR-B) before the Visit table itself is
# retired (PR-C). See docs/job-visit-unification.md for the full plan.
# ============================================================================


class JobCompleteRequest(BaseModel):
    """Payload for POST /api/jobs/{id}/complete — one call sets the job as done."""
    completed_by: Optional[int] = None
    completed_at: Optional[datetime] = None
    checklist_results: Optional[dict] = None
    # Photos entries can be a bare URL string (paste-a-link path) OR a dict
    # carrying an inline data URL (field-cleaner uploaded from phone camera).
    # Audit §15: the modal used to be URL-only; the new upload path posts
    # dicts of shape {kind:"upload", data_url:"data:image/jpeg;base64,...",
    # mime, name, size, added_at}. Keeping the column mixed avoids a schema
    # migration for a feature that was already storing whatever JSON came in.
    photos: Optional[List[Union[str, dict]]] = None
    notes: Optional[str] = None


@router.post("/{job_id}/complete", dependencies=[Depends(require_role("admin", "manager"))])
def complete_job(job_id: int, data: JobCompleteRequest = JobCompleteRequest(),
                 db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Mark a job as completed in a single call.

    Sets status='completed' and stamps completed_at / completed_by / checklist /
    photos on the Job row itself — closing the audit gap where the old flow
    updated Visit but never synced Job.status back. Idempotent: calling again
    just refreshes the fields with the latest payload (or defaults).

    Also auto-creates a draft Invoice on the completing transition, same as
    the PATCH /{job_id} status path — this used to be the one "mark complete"
    route that didn't, so a job completed through the field checklist UI
    (the actual completion flow) never got billed automatically.

    Office-only. The "cleaner" role was removed when crew mark-done shipped:
    this endpoint has no assignment check and accepts caller-supplied
    completed_by / notes / photos, so a cleaner token could complete (and
    overwrite notes on) ANY job in the org. Cleaners complete their own jobs
    via POST /api/crew/jobs/{id}/complete, which verifies assignment.
    """
    job = _get_job_or_404(db, job_id, resolve_org_id(org_id, db))

    prev_status = job.status
    job.status = "completed"
    job.completed_at = data.completed_at or datetime.now(timezone.utc)
    if data.completed_by is not None:
        job.completed_by = data.completed_by
    if data.checklist_results is not None:
        job.checklist_results = data.checklist_results
    if data.photos is not None:
        job.photos = data.photos
    if data.notes is not None:
        job.notes = data.notes

    if prev_status != "completed":
        try:
            log_job_status_change(db, job, prev_status=prev_status, actor="admin")
        except Exception:
            logger.exception("log_job_status_change failed on complete_job")

    db.commit()
    db.refresh(job)

    if job.status == "completed" and prev_status != "completed":
        _auto_create_draft_invoice(db, job)

    from database.models import Invoice
    has_invoice = db.query(Invoice).filter(Invoice.job_id == job.id).first() is not None
    return {
        "id": job.id,
        "status": job.status,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "completed_by": job.completed_by,
        "checklist_results": job.checklist_results or {},
        "photos": job.photos or [],
        "has_invoice": has_invoice,
    }


@router.post("/{job_id}/skip", dependencies=[Depends(require_role("admin", "manager"))])
def skip_job(job_id: int, reason: Optional[str] = None,
             db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Cancel a single occurrence without affecting the recurring schedule.

    Mirrors the old POST /api/visits/{id}/skip: mark this job cancelled, keep
    the RecurringSchedule running, and record a RecurrenceException so the skip
    is durable even if the row is later hard-deleted."""
    job = _get_job_or_404(db, job_id, resolve_org_id(org_id, db))

    prev_status = job.status
    job.status = "cancelled"
    if reason:
        job.notes = (job.notes or "") + f"\n[Skipped: {reason}]"

    if job.recurring_schedule_id and job.scheduled_date:
        existing = (
            db.query(RecurrenceException)
            .filter(
                RecurrenceException.recurring_schedule_id == job.recurring_schedule_id,
                RecurrenceException.exception_date == job.scheduled_date,
            )
            .first()
        )
        if existing is None:
            db.add(RecurrenceException(
                recurring_schedule_id=job.recurring_schedule_id,
                exception_date=job.scheduled_date,
                exception_type="skip",
                reason=reason or "Job skipped via /api/jobs/{id}/skip",
            ))

    if prev_status != "cancelled":
        try:
            log_job_status_change(db, job, prev_status=prev_status, actor="admin")
        except Exception:
            logger.exception("log_job_status_change failed on skip_job")

    db.commit()
    db.refresh(job)
    return {
        "id": job.id,
        "status": job.status,
        "message": "Job skipped — recurring schedule unchanged",
    }


@router.get("/{job_id}/crew-suggestions", dependencies=[Depends(require_role("admin", "manager"))])
def get_job_crew_suggestions(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Suggest crew for a job based on recent assignments at the same property.

    Ordered by scheduled_date DESC so "recent" actually means recent — the
    previous version limited to 20 rows but had no ORDER BY, so the DB was
    free to return the *oldest* 20 jobs at that property, which surfaced
    stale cleaners (e.g. someone who cleaned once in 2023 outranking a
    regular from last month). Audit: crew suggestions unreliable.

    Sorted by frequency, top 5.
    """
    oid = resolve_org_id(org_id, db)
    job = _get_job_or_404(db, job_id, oid)
    if not job.property_id:
        return {"job_id": job_id, "property_id": None, "suggestions": []}

    recent_jobs = (
        db.query(Job)
        .filter(
            Job.property_id == job.property_id,
            Job.cleaner_ids.isnot(None),
            or_(Job.org_id == oid, Job.org_id.is_(None)),  # MT-2 tenant scope
        )
        .order_by(Job.scheduled_date.desc().nullslast(), Job.id.desc())
        .limit(20)
        .all()
    )

    crew_freq: dict = {}
    for j in recent_jobs:
        for cleaner_id in (j.cleaner_ids or []):
            crew_freq[cleaner_id] = crew_freq.get(cleaner_id, 0) + 1

    suggestions = sorted(crew_freq.items(), key=lambda x: x[1], reverse=True)
    return {
        "job_id": job_id,
        "property_id": job.property_id,
        "suggestions": [
            {"cleaner_id": cid, "frequency": freq}
            for cid, freq in suggestions[:5]
        ],
    }


@router.post("/{job_id}/auto-assign", dependencies=[Depends(require_role("admin", "manager"))])
def auto_assign_job_crew(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Assign the most-frequent cleaner at this property to the job.

    Mirrors /api/visits/{id}/auto-assign — no history means the job is
    unassigned (cleaner_ids cleared), matching the old semantics."""
    oid = resolve_org_id(org_id, db)
    job = _get_job_or_404(db, job_id, oid)
    if not job.property_id:
        return {"status": "no_property", "message": "Job has no associated property"}

    recent_jobs = db.query(Job).filter(
        Job.property_id == job.property_id,
        Job.cleaner_ids.isnot(None),
        or_(Job.org_id == oid, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).limit(30).all()

    crew_freq: dict = {}
    for j in recent_jobs:
        for cleaner_id in (j.cleaner_ids or []):
            crew_freq[cleaner_id] = crew_freq.get(cleaner_id, 0) + 1

    if not crew_freq:
        job.cleaner_ids = []
        db.commit()
        return {"status": "no_history", "message": "No crew history for this property"}

    top_cleaner = max(crew_freq.items(), key=lambda x: x[1])[0]
    job.cleaner_ids = [top_cleaner]
    db.commit()
    db.refresh(job)
    return {
        "status": "assigned",
        "job_id": job.id,
        "assigned_cleaner_id": top_cleaner,
        "message": f"Auto-assigned based on property history (appeared {crew_freq[top_cleaner]} times)",
    }



# ── Schedule week aggregate ────────────────────────────────────────────────
#
# The /api/schedule/week endpoint used to live in modules.schedule — a
# 72-line shim that called functions here + in properties + in clients
# in-process. The audit flagged the shim as the reason org-scoping
# relied on FastAPI Depends() sentinels leaking into pure-Python calls;
# folded back into this module so those call sites are just internal
# helpers with an explicit org_id passed in. FE URL is unchanged
# (main.py still mounts schedule_router at /api/schedule).

from modules.properties.router import get_properties as _get_properties
from modules.clients.router import get_clients as _get_clients

schedule_router = APIRouter()


def _job_as_visit(job: dict) -> dict:
    """Wrap a Job dict in the pre-migration Visit shape (kept for one release
    so a stale Schedule.jsx bundle still renders while it reloads)."""
    return {
        **job,
        "job_id": job.get("id"),
        "scheduled_date": job.get("scheduled_date"),
        "start_time": job.get("start_time"),
        "end_time": job.get("end_time"),
        "cleaner_ids": job.get("cleaner_ids") or [],
        "status": job.get("status"),
    }


@schedule_router.get("/week", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def schedule_week(
    scheduled_date_from: str,
    scheduled_date_to: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    org_id: int = Depends(current_org_id),
):
    """Everything the Schedule page needs for one week, in a single response.

    Delegates to get_jobs / get_properties / get_clients in-process. Every
    delegate gets org_id explicitly so the FastAPI Query() defaults on those
    functions never leak in as unresolved Depends sentinels.
    """
    # Page through get_jobs instead of taking a single limit=500 call.
    # get_jobs's cap protects an UNBOUNDED query; schedule_week is already
    # bounded by the caller's date range (a week or a month grid), so it's
    # safe — and necessary — to fetch every row in that range rather than
    # silently truncating.
    #
    # A single get_jobs(limit=500) call was exactly this bug: get_jobs
    # orders by scheduled_date ascending, so once an org's requested range
    # held more than 500 jobs, SQL's LIMIT dropped everything past the
    # 500th row — the CHRONOLOGICALLY LATEST jobs in the range. Week
    # view's narrow 7-day window rarely crosses 500 jobs, so it always
    # looked fine; Month view's ~35-42 day grid crossed it for a
    # busy-enough org (lots of STR turnovers), so jobs later in the month
    # (including turnovers 10-20+ days out) silently vanished from the
    # Calendar view while the same jobs still showed correctly on Week.
    PAGE_SIZE = 500
    MAX_PAGES = 20  # 10,000-job ceiling — a runaway-query backstop, not an expected case
    jobs = []
    offset = 0
    for _ in range(MAX_PAGES):
        page = get_jobs(
            date_from=scheduled_date_from,
            date_to=scheduled_date_to,
            limit=PAGE_SIZE, offset=offset, paginated=False,
            db=db, org_id=org_id,
        )
        jobs.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    else:
        logger.warning(
            "[schedule_week] hit the %s-page ceiling fetching %s..%s — "
            "response may still be truncated; investigate job volume for org_id=%s",
            MAX_PAGES, scheduled_date_from, scheduled_date_to, org_id,
        )
    return {
        # Visits are derived from jobs post-unification; the shape mirrors what
        # /api/visits used to emit so the FE fallback keeps rendering unchanged.
        "visits": [_job_as_visit(j) for j in (jobs or [])],
        "jobs": jobs,
        "properties": _get_properties(db=db, org_id=org_id),
        # limit/offset are Query() defaults — pass explicitly. 50 matches the
        # standalone /api/clients default the page used before.
        "clients": _get_clients(limit=50, offset=0, db=db, org_id=org_id),
        # Coverage was "Job without Visit"; that can't happen post-unification.
        "coverage": {
            "total_jobs": len(jobs or []),
            "jobs_without_visits": 0,
            "coverage_percent": 100,
            "healthy": True,
        },
    }
