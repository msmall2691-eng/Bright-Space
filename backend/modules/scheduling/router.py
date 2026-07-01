import logging
import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, and_, func
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone, date, time, timedelta
from zoneinfo import ZoneInfo

from database.db import get_db
from database.models import (
    Job, Client, Visit, ICalEvent, CleanerTimeOff, Property, RecurrenceException,
)
from modules.auth.router import get_current_user, require_role, current_org_id, resolve_org_id
from utils.activity_logger import (
    log_job_created, log_job_status_change, log_calendar_event, log_activity
)
from utils.integration_log import log_integration_event as _log_integration

logger = logging.getLogger(__name__)
router = APIRouter()


class JobCreate(BaseModel):
    client_id: int
    title: str
    job_type: Optional[str] = "residential"  # "residential" | "commercial" | "str_turnover"
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
    property_id: Optional[int] = None
    allow_conflicts: Optional[bool] = False

JOB_TYPES = {"residential", "commercial", "str_turnover", "one_time"}
JOB_STATUSES = {"scheduled", "in_progress", "completed", "cancelled"}


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
    # Denormalized property.name so WeekView / Dashboard / PropertyDetail can
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
    connecteam_shift_ids: List[str] = []
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    booking: Optional[BookingInfo] = None
    next_arrival: Optional[BookingInfo] = None
    is_immediate_turnover: bool = False


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
    """Parse a 'YYYY-MM-DD' string (or pass through a date) → date | None."""
    if value is None or isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _to_time(value):
    """Parse a 'HH:MM[:SS]' string (or pass through a time) → time | None."""
    if value is None or isinstance(value, time):
        return value
    try:
        parts = str(value).split(":")
        return time(int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)
    except (ValueError, TypeError, IndexError):
        return None


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
    if is_new and d is not None and d < date.today():
        raise HTTPException(
            status_code=400,
            detail=f"Cannot schedule a job in the past ({d.isoformat()}).",
        )


def _find_cleaner_conflicts(db: Session, *, cleaner_ids, scheduled_date,
                            start_time, end_time, exclude_job_id=None):
    """Return [(cleaner_id, conflicting Job)] where a cleaner is already booked
    on an overlapping job the same day. Two intervals overlap iff
    start < other_end and end > other_start. Cancelled jobs don't count."""
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


def _find_unavailable_cleaners(db: Session, *, cleaner_ids, scheduled_date):
    """Return [(cleaner_id, CleanerTimeOff)] for any assigned cleaner who has
    approved time off covering scheduled_date (inclusive range)."""
    d = _to_date(scheduled_date)
    if not cleaner_ids or d is None:
        return []
    ids = {str(c) for c in cleaner_ids}
    rows = (
        db.query(CleanerTimeOff)
        .filter(
            CleanerTimeOff.cleaner_id.in_(ids),
            CleanerTimeOff.start_date <= d,
            CleanerTimeOff.end_date >= d,
        )
        .all()
    )
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


def _find_over_capacity(db: Session, *, cleaner_ids, scheduled_date, exclude_job_id=None):
    """If MAX_JOBS_PER_CLEANER_PER_DAY > 0, return [(cleaner_id, count)] for any
    assigned cleaner who would exceed that many non-cancelled jobs on the day.
    Disabled (returns []) when the cap is 0/unset."""
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
    if exclude_job_id is not None:
        q = q.filter(Job.id != exclude_job_id)
    counts = {cid: 0 for cid in ids}
    for other in q.all():
        for cid in ids.intersection({str(c) for c in (other.cleaner_ids or [])}):
            counts[cid] += 1
    # +1 for the job being created/updated.
    return [(cid, counts[cid] + 1) for cid in ids if counts[cid] + 1 > CAPACITY_PER_CLEANER_PER_DAY]


def _cleaner_roster(db: Session) -> list:
    """The pool of candidate cleaners: every distinct cleaner_id that appears on
    a non-cancelled job. Derived from real assignments so it needs no external
    roster call (Connecteam) and reflects who actually works turnovers."""
    seen = []
    rows = db.query(Job).filter(
        Job.status.notin_(["cancelled"]),
        Job.cleaner_ids.isnot(None),
    ).all()
    for j in rows:
        for cid in (j.cleaner_ids or []):
            cid = str(cid)
            if cid and cid not in seen:
                seen.append(cid)
    return seen


def _day_load(db: Session, cleaner_id: str, d) -> int:
    """How many non-cancelled jobs the cleaner already has on day d."""
    n = 0
    for j in db.query(Job).filter(
        Job.scheduled_date == d,
        Job.status.notin_(["cancelled"]),
        Job.cleaner_ids.isnot(None),
    ).all():
        if str(cleaner_id) in {str(c) for c in (j.cleaner_ids or [])}:
            n += 1
    return n


def auto_assign_unassigned_turnovers(db: Session, *, dry_run: bool = False,
                                     limit: int = 100) -> dict:
    """Assign an available cleaner to upcoming, unassigned str_turnover jobs.

    For each such job, a candidate is eligible when — by the same rules the
    create/update guard enforces — they have no time-off covering the date, no
    overlapping job, and aren't over the daily cap. Among eligible candidates
    the least-loaded that day is chosen (simple load balancing). Jobs with no
    eligible candidate are left unassigned and reported.

    dry_run=True computes the picks without writing them (for a preview)."""
    today = date.today()
    roster = _cleaner_roster(db)
    jobs = (
        db.query(Job)
        .filter(
            Job.job_type == "str_turnover",
            Job.scheduled_date >= today,
            Job.status.notin_(["cancelled", "completed"]),
        )
        .order_by(Job.scheduled_date, Job.start_time)
        .all()
    )
    jobs = [j for j in jobs if not (j.cleaner_ids or [])][:limit]

    assigned, unassignable = [], []
    for job in jobs:
        d = _to_date(job.scheduled_date)
        best, best_load = None, None
        for cid in roster:
            # Reuse the create/update guard rules for eligibility.
            if _find_unavailable_cleaners(db, cleaner_ids=[cid], scheduled_date=d):
                continue
            if _find_cleaner_conflicts(db, cleaner_ids=[cid], scheduled_date=d,
                                       start_time=job.start_time, end_time=job.end_time,
                                       exclude_job_id=job.id):
                continue
            if _find_over_capacity(db, cleaner_ids=[cid], scheduled_date=d,
                                   exclude_job_id=job.id):
                continue
            load = _day_load(db, cid, d)
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
    return {
        "dry_run": dry_run,
        "candidates": len(roster),
        "considered": len(jobs),
        "assigned": assigned,
        "unassignable": unassignable,
    }


def job_to_dict(j: Job, client: Client = None, effective_date=None,
                booking_event: ICalEvent = None, next_arrival: ICalEvent = None,
                property_name: Optional[str] = None) -> dict:
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
    # Phase 3 calendar fix: prefer the COALESCE(Job.scheduled_date,
    # earliest Visit.scheduled_date) computed by get_jobs() so consumers
    # like CalendarView can bucket by date even when the Job column is
    # NULL (some startup tasks null it out at boot; Visit is the durable
    # source of truth).
    sched = effective_date if effective_date is not None else j.scheduled_date
    return {
        "id": j.id,
        "client_id": j.client_id,
        "client_name": client_name,
        "quote_id": j.quote_id,
        "opportunity_id": j.opportunity_id,
        "job_type": j.job_type or "residential",
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
        "custom_fields": j.custom_fields or {},
        "dispatched": bool(j.dispatched),
        "gcal_event_id": j.gcal_event_id,
        "connecteam_shift_ids": j.connecteam_shift_ids or [],
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "updated_at": j.updated_at.isoformat() if j.updated_at else None,
        # Phase 5: booking enrichment for STR turnovers. Lazy-matched in
        # get_jobs() if the Job has no direct ical_event_id link.
        "booking": _booking_dict(booking_event) if booking_event else None,
        "next_arrival": _booking_dict(next_arrival) if next_arrival else None,
        "is_immediate_turnover": (
            booking_event is not None
            and next_arrival is not None
            and next_arrival.checkin_date == booking_event.checkout_date
        ),
    }


@router.get("", response_model=List[JobResponse], dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_jobs(
    client_id: Optional[int] = None,
    property_id: Optional[int] = None,
    status: Optional[str] = None,
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    job_type: Optional[str] = None,
    unassigned: Optional[bool] = None,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    # Per-job earliest visit date. Used both for filtering AND for the
    # serialized response so that consumers (e.g. CalendarView) bucket by
    # the right date when Job.scheduled_date is NULL — the durable date
    # lives on the Visit row.
    visit_min = (
        db.query(Visit.job_id, func.min(Visit.scheduled_date).label("min_date"))
          .group_by(Visit.job_id)
          .subquery()
    )
    effective_date = func.coalesce(Job.scheduled_date, visit_min.c.min_date).label("effective_date")
    q = (
        db.query(Job, effective_date)
          .options(joinedload(Job.client))
          .outerjoin(visit_min, visit_min.c.job_id == Job.id)
    )

    # MT-2: scope to the caller's workspace; tolerate legacy NULL-org rows
    # (jobs created by internal paths — recurring, gcal sync — before backfill).
    org_id = resolve_org_id(org_id, db)
    q = q.filter(or_(Job.org_id == org_id, Job.org_id.is_(None)))

    if client_id:
        q = q.filter(Job.client_id == client_id)
    if property_id:
        q = q.filter(Job.property_id == property_id)
    if status:
        q = q.filter(Job.status == status)
    if date:
        q = q.filter(or_(
            Job.scheduled_date == date,
            and_(Job.scheduled_date.is_(None), visit_min.c.min_date == date),
        ))
    if date_from:
        q = q.filter(or_(
            Job.scheduled_date >= date_from,
            and_(Job.scheduled_date.is_(None), visit_min.c.min_date >= date_from),
        ))
    if date_to:
        q = q.filter(or_(
            Job.scheduled_date <= date_to,
            and_(Job.scheduled_date.is_(None), visit_min.c.min_date <= date_to),
        ))
    if job_type:
        q = q.filter(Job.job_type == job_type)

    rows = q.order_by(effective_date, Job.start_time).all()

    # Unassigned filter: cleaner_ids is JSON, so filter in Python (cross-dialect
    # safe). A job "needs assignment" when it has no cleaners and isn't done/
    # cancelled — that's the actionable queue the Schedule page surfaces.
    if unassigned is not None:
        def _is_unassigned(j):
            return (not (j.cleaner_ids or [])) and j.status in ("scheduled", "in_progress")
        rows = [(j, eff) for j, eff in rows if _is_unassigned(j) == unassigned]

    # Phase 5: build a per-property index of relevant ICalEvent rows so
    # we can attach booking details to str_turnover Jobs that lack a
    # direct ical_event_id (production data is currently mostly unlinked).
    rendered = []
    if rows:
        # Bulk-fetch property names for the property_name field on JobResponse
        # (needed by WeekView / Dashboard after the Job/Visit unification).
        all_prop_ids = {j.property_id for j, _ in rows if j.property_id}
        prop_names = (
            {p.id: p.name for p in
             db.query(Property.id, Property.name).filter(Property.id.in_(all_prop_ids)).all()}
            if all_prop_ids else {}
        )
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
                                        property_name=prop_names.get(j.property_id)))
    return rendered


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_job(data: JobCreate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
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
        source_quote = db.query(Quote).filter(Quote.id == data.quote_id).first()
        if source_quote and source_quote.status == "converted":
            existing = (db.query(Job).filter(Job.quote_id == source_quote.id)
                        .order_by(Job.id.asc()).first())
            if existing:
                return job_to_dict(existing)

    # ── TIMING VALIDATION ── reject past dates / inverted windows up front.
    _validate_job_timing(data.scheduled_date, data.start_time, data.end_time, is_new=True)

    # ── CONFLICT / DUPLICATE CHECK ──
    # Prevent creating duplicate jobs for the same property + date + time
    if data.property_id and data.job_type == "str_turnover":
        existing = db.query(Job).filter(
            Job.property_id == data.property_id,
            Job.scheduled_date == data.scheduled_date,
            Job.job_type == "str_turnover",
            Job.status.notin_(["cancelled"]),
        ).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"A turnover job already exists for this property on {data.scheduled_date} (Job #{existing.id}: {existing.title}). Edit the existing job or cancel it first."
            )

    # ── CLEANER GUARDS ── double-booking, time-off, capacity. All overridable
    # via allow_conflicts so an operator can intentionally force an assignment.
    if not data.allow_conflicts:
        conflicts = _find_cleaner_conflicts(
            db, cleaner_ids=data.cleaner_ids, scheduled_date=data.scheduled_date,
            start_time=data.start_time, end_time=data.end_time,
        )
        if conflicts:
            raise HTTPException(status_code=409, detail=_conflict_detail(conflicts))
        unavailable = _find_unavailable_cleaners(
            db, cleaner_ids=data.cleaner_ids, scheduled_date=data.scheduled_date,
        )
        if unavailable:
            raise HTTPException(status_code=409, detail=_unavailable_detail(unavailable))
        over = _find_over_capacity(
            db, cleaner_ids=data.cleaner_ids, scheduled_date=data.scheduled_date,
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
    if not resolved_property_id:
        existing_prop = (db.query(Property)
                         .filter(Property.client_id == data.client_id)
                         .order_by(Property.id.asc()).first())
        if existing_prop:
            resolved_property_id = existing_prop.id
        else:
            client = db.query(Client).filter(Client.id == data.client_id).first()
            ptype = "str" if data.job_type == "str_turnover" else (
                data.job_type if data.job_type in ("residential", "commercial") else "residential")
            new_prop = Property(
                client_id=data.client_id,
                name=f"{client.name} — Main" if client and client.name else "Main location",
                address=data.address or (getattr(client, "address", None) if client else "") or "",
                property_type=ptype,
            )
            if hasattr(new_prop, "org_id"):
                new_prop.org_id = resolve_org_id(org_id, db)
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
    job.org_id = resolve_org_id(org_id, db)  # MT-2: stamp the caller's workspace (robust to in-process calls)
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
    db.commit()

    # Create primary Visit for this job (dual-write pattern)
    try:
        visit = Visit(
            job_id=job.id,
            scheduled_date=job.scheduled_date,
            start_time=job.start_time,
            end_time=job.end_time,
            status=job.status or "scheduled",
            cleaner_ids=job.cleaner_ids or [],
            gcal_event_id=job.gcal_event_id,
            notes=job.notes,
        )
        db.add(visit)
        db.commit()
    except Exception as e:
        logger.error(f"Failed to create primary Visit for job {job.id}: {e}")

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
            from modules.settings.router import customer_invites_enabled
            invite = customer_invites_enabled(db) and bool(client and client.email)
            event_id = create_event(job_dict, client_dict, send_invite=invite)
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
                _log_integration(db, entity_type="job", entity_id=job.id, provider="gcal",
                                 action="create", status="ok", external_id=event_id)
            else:
                gcal_status["reason"] = "error"
                _log_integration(db, entity_type="job", entity_id=job.id, provider="gcal",
                                 action="create", status="failed", detail="create_event returned no id")
    except Exception as e:
        logger.warning(f"GCal push failed for job {job.id}: {e}")
        gcal_status["reason"] = "error"
        _log_integration(db, entity_type="job", entity_id=job.id, provider="gcal",
                         action="create", status="failed", detail=str(e))

    # ── PUSH TO CONNECTEAM (auto-dispatch) ──
    # If cleaners are already assigned, scheduling the job sends their shifts to
    # Connecteam now — no separate "Dispatch" click. No-ops cleanly when
    # Connecteam isn't configured or no one's assigned yet.
    ct_status = {"dispatched": False, "reason": None}
    try:
        from integrations.connecteam_auto import auto_dispatch_job
        ct_status = auto_dispatch_job(db, job)
    except Exception as e:
        logger.warning(f"Connecteam auto-dispatch failed for job {job.id}: {e}")
        ct_status = {"dispatched": False, "reason": "error"}

    result = job_to_dict(job)
    result["gcal"] = gcal_status
    result["connecteam"] = ct_status
    return result


@router.get("/client/{client_id}/gcal-events")
def client_gcal_events(client_id: int, days_back: int = 90, days_ahead: int = 180, db: Session = Depends(get_db)):
    """Live Google Calendar events linked to this client (Twenty-style timeline).

    Matches events by the client's email (attendee) or our brightbase_client_id
    tag, across every configured calendar. Returns {connected, events} so the
    profile can show the real linked timeline, or a connect prompt when Google
    isn't linked yet."""
    client = db.query(Client).filter(Client.id == client_id).first()
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
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    unsynced = db.query(Job).filter(
        Job.gcal_event_id.is_(None),
        Job.status.in_(["scheduled", "in_progress"]),
        Job.scheduled_date >= today,
    ).count()
    return {"unsynced_count": unsynced, "configured": configured}


@router.post("/push-to-gcal", dependencies=[Depends(require_role("admin", "manager"))])
def push_to_gcal(db: Session = Depends(get_db)):
    """Push any BrightBase jobs that don't yet have a GCal event."""
    try:
        from integrations.google_calendar import create_event
    except ImportError as e:
        logger.warning(f"push_to_gcal import failed: {e}")
        raise HTTPException(status_code=500, detail="Google Calendar integration unavailable.")

    jobs = db.query(Job).options(joinedload(Job.client)).filter(
        Job.gcal_event_id.is_(None),
        Job.status.in_(["scheduled", "in_progress"]),
        Job.scheduled_date >= datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    ).all()

    if not jobs:
        return {"pushed": 0, "message": "All upcoming jobs already have GCal events"}

    from modules.settings.router import customer_invites_enabled
    invites_on = customer_invites_enabled(db)
    created_count = 0
    errors = []

    for job in jobs:
        client = job.client
        client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None) if client else None}
        job_dict = {
            "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
            "scheduled_date": job.scheduled_date, "start_time": job.start_time,
            "end_time": job.end_time, "address": job.address, "notes": job.notes,
            "property_id": job.property_id,
        }
        try:
            invite = invites_on and bool(client and client.email)
            event_id = create_event(job_dict, client_dict, send_invite=invite)
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


@router.post("/sync-gcal-cancellations", dependencies=[Depends(require_role("admin", "manager"))])
def sync_gcal_cancellations_endpoint(db: Session = Depends(get_db)):
    """Manual trigger for the GCal-cancellation reverse linkage check.
    Useful for testing without waiting for the scheduler tick."""
    from integrations.gcal_sync import sync_gcal_cancellations
    return sync_gcal_cancellations(db)


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
    }


@router.get("/time-off", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def list_time_off(
    cleaner_id: Optional[str] = None,
    upcoming_only: bool = True,
    db: Session = Depends(get_db),
):
    """List cleaner time-off entries. Defaults to current + future ranges."""
    q = db.query(CleanerTimeOff)
    if cleaner_id:
        q = q.filter(CleanerTimeOff.cleaner_id == str(cleaner_id))
    if upcoming_only:
        q = q.filter(CleanerTimeOff.end_date >= date.today())
    rows = q.order_by(CleanerTimeOff.start_date).all()
    return [_timeoff_to_dict(t) for t in rows]


@router.post("/time-off", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_time_off(data: TimeOffCreate, db: Session = Depends(get_db)):
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
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _timeoff_to_dict(row)


@router.delete("/time-off/{time_off_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_time_off(time_off_id: int, db: Session = Depends(get_db)):
    """Remove a time-off entry."""
    row = db.query(CleanerTimeOff).filter(CleanerTimeOff.id == time_off_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Time-off entry not found")
    db.delete(row)
    db.commit()


# Registered before /{job_id} so the literal path isn't swallowed by the int route.
@router.post("/auto-assign-turnovers", dependencies=[Depends(require_role("admin", "manager"))])
def auto_assign_turnovers(dry_run: bool = False, db: Session = Depends(get_db)):
    """Assign available cleaners to upcoming unassigned STR turnover jobs.
    Pass ?dry_run=true to preview the picks without writing them."""
    return auto_assign_unassigned_turnovers(db, dry_run=dry_run)


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
def diagnose_missing_times(db: Session = Depends(get_db)):
    """Diagnostic: list jobs with no start_time — the records that render as
    '– –' on the schedule. Visits can't be null (DB constraint), so a blank time
    always traces to a Job with start_time IS NULL shown via the job→visit
    fallback. Each row is tagged with the likely source so we can fix the
    actual producer rather than guess. Read-only; writes nothing."""
    today = date.today()
    missing = (
        db.query(Job)
        .filter(Job.start_time.is_(None), Job.status.notin_(["cancelled"]))
        .order_by(Job.scheduled_date.desc())
        .limit(200)
        .all()
    )
    prop_names = {p.id: p.name for p in db.query(Property.id, Property.name).all()} \
        if missing else {}

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
            "note": ("Visit.start_time is NOT NULL at the DB level, so blank times "
                     "come from Jobs with start_time IS NULL rendered via the "
                     "job→visit fallback. Fix the source(s) listed in by_source."),
        },
        "jobs": rows,
    }


# Registered before /{job_id} so the literal path isn't swallowed by the int route.
@router.post("/backfill-missing-times", dependencies=[Depends(require_role("admin", "manager"))])
def backfill_missing_times(dry_run: bool = False, db: Session = Depends(get_db)):
    """Fill a sensible time on every non-cancelled job that has no start_time
    (the records that render as '– –'). Uses the same rule iCal sync uses:
    turnovers get the property's check-out time (fallback 10:00), other jobs
    get 09:00; end = start + the property's default duration (fallback 3h).
    Pass ?dry_run=true to preview without writing. Review-first; mirrors the
    new time onto the job's visits too so the Schedule reflects it."""
    from integrations.ical_sync import _make_end_time
    missing = (
        db.query(Job)
        .filter(Job.start_time.is_(None), Job.status.notin_(["cancelled"]))
        .order_by(Job.scheduled_date.desc())
        .limit(500)
        .all()
    )
    prop_map = {p.id: p for p in db.query(Property).all()} if missing else {}

    changes = []
    for j in missing:
        prop = prop_map.get(j.property_id)
        visits = db.query(Visit).filter(Visit.job_id == j.id).all()

        # If a terminal (completed/cancelled) visit exists, it IS the historical
        # record — use its real window as the source of truth for the whole job
        # rather than a generated default. This keeps Job.start_time (read by
        # /api/jobs + client past-visit views) consistent with /api/visits and
        # preserves that history everywhere. Otherwise fall back to the property
        # check-out time (turnovers) / 09:00, + the property default duration.
        terminal = next((v for v in visits
                         if v.status in ("completed", "cancelled") and v.start_time is not None), None)
        if terminal is not None:
            st, et = terminal.start_time, terminal.end_time
            new_start, new_end = str(terminal.start_time)[:5], str(terminal.end_time or "")[:5]
            time_source = "completed/cancelled visit"
        else:
            if j.job_type == "str_turnover":
                start_str = (prop.check_out_time if prop and prop.check_out_time else None) or "10:00"
            else:
                start_str = "09:00"
            dur = (prop.default_duration_hours if prop and prop.default_duration_hours else None) or 3.0
            end_str = _make_end_time(start_str, dur)
            st, et = _to_time(start_str), _to_time(end_str)
            new_start, new_end = start_str, end_str
            time_source = "default"

        changes.append({
            "job_id": j.id, "title": j.title, "job_type": j.job_type,
            "scheduled_date": str(j.scheduled_date) if j.scheduled_date else None,
            "property_name": prop.name if prop else None,
            "source": _job_source(j),
            "time_source": time_source,
            "new_start": new_start, "new_end": new_end,
        })
        if not dry_run:
            j.start_time = st
            j.end_time = et
            # Mirror onto active visits so the board reflects it; terminal visits
            # are the immutable historical record and are left untouched (and now
            # already agree with the job when they were the source).
            for v in visits:
                if v.status in ("completed", "cancelled"):
                    continue
                v.start_time = st
                v.end_time = et
    if not dry_run and changes:
        db.commit()
    return {"dry_run": dry_run, "count": len(changes), "jobs": changes}


@router.get("/{job_id}", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_job(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    org_id = resolve_org_id(org_id, db)
    job = db.query(Job).options(joinedload(Job.client)).filter(
        Job.id == job_id,
        or_(Job.org_id == org_id, Job.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_dict(job)


@router.get("/{job_id}/details", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_job_details(job_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
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
    quote = None
    if job.quote_id:
        quote = db.query(Quote).filter(Quote.id == job.quote_id).first()
    timeline = db.query(Activity).filter(
        Activity.job_id == job.id,
    ).order_by(Activity.created_at.desc()).limit(50).all()

    return {
        **job_to_dict(job),
        "property": ({"id": job.property.id, "name": job.property.name, "address": job.property.address}
                     if job.property else None),
        "opportunity": ({"id": job.opportunity.id, "title": job.opportunity.title, "stage": job.opportunity.stage}
                        if job.opportunity else None),
        "quote": ({"id": quote.id, "quote_number": quote.quote_number, "status": quote.status, "total": quote.total}
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
                "sub": None if ok else (e.error_message or e.error_code),
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
    # Signature of the shift-relevant fields BEFORE the edit. The edit modal
    # sends every field, so we compare actual values (not "was it in the body")
    # to decide whether Connecteam shifts need re-syncing.
    prev_ct_sig = (job.scheduled_date, job.start_time, job.end_time,
                   tuple(str(c) for c in (job.cleaner_ids or [])))

    updates = data.model_dump(exclude_none=True)
    allow_conflicts = updates.pop("allow_conflicts", False)

    # The edit modal sends EVERY field, so a job whose stored status/type
    # predates the current vocabulary must not become uneditable: the job's
    # own current value always passes (a no-op), only CHANGES are validated.
    if "job_type" in updates and updates["job_type"] not in JOB_TYPES \
            and updates["job_type"] != job.job_type:
        raise HTTPException(status_code=400, detail=f"Unknown job_type '{updates['job_type']}'")
    if "status" in updates and updates["status"] not in JOB_STATUSES \
            and updates["status"] != job.status:
        raise HTTPException(status_code=400, detail=f"Unknown status '{updates['status']}'")
    if "property_id" in updates:
        prop = db.query(Property).filter(Property.id == updates["property_id"]).first()
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
            conflicts = _find_cleaner_conflicts(
                db, cleaner_ids=eff_cleaners, scheduled_date=eff_date,
                start_time=eff_start, end_time=eff_end, exclude_job_id=job.id,
            )
            if conflicts:
                raise HTTPException(status_code=409, detail=_conflict_detail(conflicts))
            unavailable = _find_unavailable_cleaners(
                db, cleaner_ids=eff_cleaners, scheduled_date=eff_date,
            )
            if unavailable:
                raise HTTPException(status_code=409, detail=_unavailable_detail(unavailable))
            over = _find_over_capacity(
                db, cleaner_ids=eff_cleaners, scheduled_date=eff_date, exclude_job_id=job.id,
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
    for field, value in updates.items():
        setattr(job, field, value)
    db.commit()
    db.refresh(job)
    # Log status transitions to the unified timeline
    if job.status != prev_status:
        log_job_status_change(db, job, prev_status)
        db.commit()

    # Auto-create a draft Invoice the first time a job lands on "completed".
    # Idempotent: skip if an Invoice already exists for this Job. Uses the
    # source Quote's items when available; otherwise emits a placeholder line.
    if job.status == "completed" and prev_status != "completed":
        try:
            from database.models import Invoice, Quote
            from datetime import datetime, timedelta
            existing_inv = db.query(Invoice).filter(Invoice.job_id == job.id).first()
            if not existing_inv:
                # Pull line items + tax from the originating quote when the job
                # came from one (quotes are now integer-keyed, matching
                # Job.quote_id); otherwise build a default single-line invoice.
                quote = db.query(Quote).filter(Quote.id == job.quote_id).first() if job.quote_id else None
                items = (quote.items if (quote and quote.items) else [{
                    "name": job.title or "Cleaning",
                    "qty": 1,
                    "unit_price": 0,
                    "description": "",
                }])
                subtotal = sum(float(i.get("qty", 1)) * float(i.get("unit_price", 0)) for i in items)
                tax_rate = float(quote.tax_rate) if (quote and quote.tax_rate) else 5.5
                tax = round(subtotal * (tax_rate / 100), 2)
                total = round(subtotal + tax, 2)
                due_date = (datetime.now(timezone.utc) + timedelta(days=14)).strftime("%Y-%m-%d")
                invoice = Invoice(
                    client_id=job.client_id,
                    job_id=job.id,
                    opportunity_id=job.opportunity_id,
                    items=items,
                    subtotal=round(subtotal, 2),
                    tax_rate=tax_rate,
                    tax=tax,
                    total=total,
                    status="draft",
                    due_date=due_date,
                    notes=job.notes or "",
                )
                db.add(invoice)
                db.commit()
                logger.info(f"[auto-invoice] created draft Invoice id={invoice.id} from completed Job {job.id}")
        except Exception as e:
            logger.warning(f"[auto-invoice] failed for job {job.id}: {e}")
    # Visit lifecycle follows editable status changes: the schedule and its
    # action controls read Visit.status, so a job completed via the edit modal
    # must not keep its visits looking scheduled and actionable (Codex P1 on
    # #271). Cancellation already had this sync below.
    if job.status != prev_status and job.status in ("completed", "in_progress"):
        active = ("scheduled", "dispatched", "en_route") if job.status == "in_progress" \
            else ("scheduled", "dispatched", "en_route", "in_progress")
        for v in getattr(job, "visits", []) or []:
            if v.status in active:
                v.status = job.status
        db.commit()
        db.refresh(job)

    # Google Calendar + visits sync.
    if job.status == "cancelled":
        # Cancelling pulls the job off the schedule everywhere: cancel its active
        # visits (so the agenda/list views drop it too) and remove the Google
        # Calendar event entirely instead of re-pushing it.
        for v in getattr(job, "visits", []) or []:
            if v.status not in ("cancelled", "completed"):
                v.status = "cancelled"
        if job.gcal_event_id:
            old_event_id = job.gcal_event_id
            try:
                from integrations.google_calendar import delete_event
                # delete_event returns False (doesn't raise) when Google rejects
                # or is unavailable. Only detach the id on success, so a failed
                # delete can be retried next time rather than orphaning the event.
                if delete_event(job.gcal_event_id, prev_job_type,
                                owner_account_id=getattr(job, "gcal_account_id", None)):
                    job.gcal_event_id = None
                    _log_integration(db, entity_type="job", entity_id=job.id, provider="gcal",
                                     action="delete", status="ok", external_id=old_event_id, commit=False)
                else:
                    logger.warning(f"GCal delete did not apply for cancelled job {job.id}; keeping event id to retry")
                    _log_integration(db, entity_type="job", entity_id=job.id, provider="gcal",
                                     action="delete", status="failed", external_id=old_event_id,
                                     detail="delete_event returned False (kept id to retry)", commit=False)
            except Exception as e:
                logger.warning(f"GCal delete failed for cancelled job {job.id}: {e}")
                _log_integration(db, entity_type="job", entity_id=job.id, provider="gcal",
                                 action="delete", status="failed", external_id=old_event_id,
                                 detail=str(e), commit=False)
        db.commit()
        db.refresh(job)
    elif job.gcal_event_id:
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
            new_type = job.job_type or "residential"
            if _calendar_id(prev_job_type) != _calendar_id(new_type):
                # The event lives on the OLD type's calendar — updating in
                # place would look it up on the NEW calendar, fail silently,
                # and leave Google stale (Codex P2 on #271). Move it:
                # delete from the old calendar, recreate on the new one.
                if delete_event(job.gcal_event_id, prev_job_type,
                                owner_account_id=getattr(job, "gcal_account_id", None)):
                    new_event_id = create_event(job_dict, client_dict)
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
                update_event(job.gcal_event_id, job_dict, client_dict,
                             owner_account_id=getattr(job, "gcal_account_id", None))
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
        except Exception as e:
            logger.warning(f"GCal update failed for job {job.id}: {e}")

    # ── CONNECTEAM SHIFT SYNC (independent of GCal) ──
    # Cancelled → pull shifts. Active → push if newly assigned, or re-sync when
    # the time/cleaners actually changed (delete old shifts, create fresh ones).
    try:
        from integrations.connecteam_auto import (
            auto_dispatch_job, remove_job_from_connecteam, resync_job,
        )
        if job.status == "cancelled":
            remove_job_from_connecteam(db, job)
        else:
            new_ct_sig = (job.scheduled_date, job.start_time, job.end_time,
                          tuple(str(c) for c in (job.cleaner_ids or [])))
            if job.connecteam_shift_ids:
                if new_ct_sig != prev_ct_sig:
                    resync_job(db, job)
            elif job.cleaner_ids:
                auto_dispatch_job(db, job)
    except Exception as e:
        logger.warning(f"Connecteam sync failed for job {job.id}: {e}")
    return job_to_dict(job)


class ReminderSettings(BaseModel):
    skip_reminder: bool  # True = suppress the 24h SMS for this job


@router.patch("/{job_id}/reminder-settings", dependencies=[Depends(require_role("admin", "manager"))])
def update_reminder_settings(
    job_id: int,
    data: ReminderSettings,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Toggle SMS reminder suppression for a single job (hybrid model).

    Reminders are on by default; setting skip_reminder=true suppresses the 24h
    SMS for this job only, without disabling the system-wide reminder job.
    """
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

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
    # Remove from Google Calendar if event exists
    if job.gcal_event_id:
        try:
            from integrations.google_calendar import delete_event
            delete_event(job.gcal_event_id, job.job_type or "residential",
                         owner_account_id=getattr(job, "gcal_account_id", None))
        except Exception as e:
            logger.warning(f"GCal delete failed for job {job.id}: {e}")
    # Remove any Connecteam shifts so deleting a job doesn't leave cleaners with
    # orphaned shifts on their schedule.
    if job.connecteam_shift_ids:
        try:
            from integrations.connecteam_auto import remove_job_from_connecteam
            remove_job_from_connecteam(db, job, commit=False)
        except Exception as e:
            logger.warning(f"Connecteam delete failed for job {job.id}: {e}")
    db.delete(job)
    db.commit()


@router.post("/{job_id}/invite-client", dependencies=[Depends(require_role("admin", "manager"))])
def invite_client(job_id: int, db: Session = Depends(get_db)):
    """
    Send the Google Calendar invite to the client for this job.
    Use this when you've finalized the schedule and are ready for the client to see it.
    """
    job = db.query(Job).options(joinedload(Job.client)).filter(Job.id == job_id).first()
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
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
                "property_id": job.property_id,
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


@router.post("/{job_id}/convert-to-invoice", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def convert_job_to_invoice(job_id: int, db: Session = Depends(get_db)):
    """Convert a completed job to an invoice."""
    from database.models import Invoice, Quote
    from datetime import datetime, timedelta

    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status != "completed":
        raise HTTPException(status_code=409, detail="Only completed jobs can be converted to invoices")

    # Pull line items + tax from the originating quote when the job came from
    # one (quotes are now integer-keyed, matching Job.quote_id); otherwise build
    # a default single-line invoice from the job.
    quote = db.query(Quote).filter(Quote.id == job.quote_id).first() if job.quote_id else None
    if quote and quote.items:
        items = quote.items
    else:
        items = [{
            "name": job.title,
            "qty": 1,
            "unit_price": 0,
            "description": ""
        }]

    subtotal = sum(float(i.get("qty", 1)) * float(i.get("unit_price", 0)) for i in items)
    tax_rate = float(quote.tax_rate) if (quote and quote.tax_rate) else 5.5
    tax = round(subtotal * (tax_rate / 100), 2)
    total = round(subtotal + tax, 2)
    due_date = (datetime.now(timezone.utc) + timedelta(days=14)).strftime("%Y-%m-%d")

    invoice = Invoice(
        client_id=job.client_id,
        job_id=job.id,
        opportunity_id=job.opportunity_id,
        items=items,
        subtotal=round(subtotal, 2),
        tax_rate=tax_rate,
        tax=tax,
        total=total,
        status="draft",
        due_date=due_date,
        notes=job.notes or "",
    )
    db.add(invoice)
    db.commit()
    db.refresh(invoice)

    from modules.invoicing.router import invoice_to_dict
    return invoice_to_dict(invoice)


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
    photos: Optional[List[dict]] = None
    notes: Optional[str] = None


@router.post("/{job_id}/complete", dependencies=[Depends(require_role("admin", "manager", "cleaner"))])
def complete_job(job_id: int, data: JobCompleteRequest = JobCompleteRequest(),
                 db: Session = Depends(get_db)):
    """Mark a job as completed in a single call.

    Sets status='completed' and stamps completed_at / completed_by / checklist /
    photos on the Job row itself — closing the audit gap where the old flow
    updated Visit but never synced Job.status back. Idempotent: calling again
    just refreshes the fields with the latest payload (or defaults).
    """
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

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
    return {
        "id": job.id,
        "status": job.status,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "completed_by": job.completed_by,
        "checklist_results": job.checklist_results or {},
        "photos": job.photos or [],
    }


@router.post("/{job_id}/skip", dependencies=[Depends(require_role("admin", "manager"))])
def skip_job(job_id: int, reason: Optional[str] = None, db: Session = Depends(get_db)):
    """Cancel a single occurrence without affecting the recurring schedule.

    Mirrors the old POST /api/visits/{id}/skip: mark this job cancelled, keep
    the RecurringSchedule running, and record a RecurrenceException so the skip
    is durable even if the row is later hard-deleted."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

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
def get_job_crew_suggestions(job_id: int, db: Session = Depends(get_db)):
    """Suggest crew for a job based on recent assignments at the same property.

    Mirrors /api/visits/{id}/crew-suggestions — sorted by frequency, top 5."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.property_id:
        return {"job_id": job_id, "property_id": None, "suggestions": []}

    recent_jobs = db.query(Job).filter(
        Job.property_id == job.property_id,
        Job.cleaner_ids.isnot(None),
    ).limit(20).all()

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
def auto_assign_job_crew(job_id: int, db: Session = Depends(get_db)):
    """Assign the most-frequent cleaner at this property to the job.

    Mirrors /api/visits/{id}/auto-assign — no history means the job is
    unassigned (cleaner_ids cleared), matching the old semantics."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.property_id:
        return {"status": "no_property", "message": "Job has no associated property"}

    recent_jobs = db.query(Job).filter(
        Job.property_id == job.property_id,
        Job.cleaner_ids.isnot(None),
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

