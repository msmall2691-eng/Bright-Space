import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, and_, func
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone, date, time
from zoneinfo import ZoneInfo

from database.db import get_db
from database.models import Job, Client, Visit, ICalEvent
from modules.auth.router import get_current_user, require_role
from utils.activity_logger import (
    log_job_created, log_job_status_change, log_calendar_event
)

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
    recurring_schedule_id: Optional[int] = None
    calendar_invite_sent: Optional[bool] = None
    sms_reminder_sent: Optional[bool] = None
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


def job_to_dict(j: Job, client: Client = None, effective_date=None,
                booking_event: ICalEvent = None, next_arrival: ICalEvent = None) -> dict:
    # Resolve client name if not passed in
    client_name = ""
    if client:
        client_name = client.name or ""
    elif j.client and hasattr(j, "client"):
        client_name = j.client.name if j.client else ""
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
        "recurring_schedule_id": j.recurring_schedule_id,
        "calendar_invite_sent": j.calendar_invite_sent,
        "sms_reminder_sent": j.sms_reminder_sent,
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
    db: Session = Depends(get_db),
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

    # Phase 5: build a per-property index of relevant ICalEvent rows so
    # we can attach booking details to str_turnover Jobs that lack a
    # direct ical_event_id (production data is currently mostly unlinked).
    rendered = []
    if rows:
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
                                        next_arrival=next_arrival))
    return rendered


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_job(data: JobCreate, db: Session = Depends(get_db)):
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

    job = Job(**data.model_dump())
    db.add(job)
    db.commit()
    db.refresh(job)

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

    # Push to Google Calendar
    try:
        from integrations.google_calendar import create_event
        client = db.query(Client).filter(Client.id == job.client_id).first()
        client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None)}
        job_dict = {
            "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
            "scheduled_date": job.scheduled_date, "start_time": job.start_time,
            "end_time": job.end_time, "address": job.address, "notes": job.notes,
            "property_id": job.property_id,
        }
        event_id = create_event(job_dict, client_dict)
        if event_id:
            job.calendar_invite_sent = False  # Not invited until user says so
            job.gcal_event_id = event_id
            db.commit()
            db.refresh(job)
            log_calendar_event(
                db, "created",
                client_id=job.client_id, job_id=job.id,
                title=job.title, gcal_event_id=event_id,
                scheduled_date=str(job.scheduled_date) if job.scheduled_date else None,
            )
            db.commit()
    except Exception as e:
        logger.warning(f"GCal push failed for job {job.id}: {e}")
    return job_to_dict(job)


@router.post("/push-to-gcal", dependencies=[Depends(require_role("admin", "manager"))])
def push_to_gcal(db: Session = Depends(get_db)):
    """Push any BrightBase jobs that don't yet have a GCal event."""
    try:
        from integrations.google_calendar import create_event
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"GCal not configured: {e}")

    jobs = db.query(Job).options(joinedload(Job.client)).filter(
        Job.gcal_event_id.is_(None),
        Job.status.in_(["scheduled", "in_progress"]),
        Job.scheduled_date >= datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    ).all()

    if not jobs:
        return {"pushed": 0, "message": "All upcoming jobs already have GCal events"}

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
            event_id = create_event(job_dict, client_dict)
            if event_id:
                job.gcal_event_id = event_id
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


@router.get("/{job_id}", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).options(joinedload(Job.client)).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_dict(job)


@router.patch("/{job_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_job(job_id: int, data: JobUpdate, db: Session = Depends(get_db)):
    job = db.query(Job).options(joinedload(Job.client)).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    prev_status = job.status
    for field, value in data.model_dump(exclude_none=True).items():
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
                quote = db.query(Quote).filter(Quote.id == job.quote_id).first() if job.quote_id else None
                items = (quote.items if (quote and quote.items) else [{
                    "name": job.title or "Cleaning",
                    "qty": 1,
                    "unit_price": 0,
                    "description": "",
                }])
                subtotal = sum(float(i.get("qty", 1)) * float(i.get("unit_price", 0)) for i in items)
                tax_rate = float(quote.tax_rate) if quote else 5.5
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
    # Sync update to Google Calendar if event exists
    if job.gcal_event_id:
        try:
            from integrations.google_calendar import update_event
            client = db.query(Client).filter(Client.id == job.client_id).first()
            client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None)}
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
                "property_id": job.property_id,
            }
            update_event(job.gcal_event_id, job_dict, client_dict)
        except Exception as e:
            logger.warning(f"GCal update failed for job {job.id}: {e}")
    return job_to_dict(job)


@router.delete("/{job_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
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
            delete_event(job.gcal_event_id, job.job_type or "residential")
        except Exception as e:
            logger.warning(f"GCal delete failed for job {job.id}: {e}")
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

    quote = db.query(Quote).filter(Quote.id == job.quote_id).first() if job.quote_id else None

    items = []
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
    tax_rate = float(quote.tax_rate) if quote else 5.5
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
                # Update the job
                job.scheduled_date = str(new_date)
                job.start_time = str(new_start_time)
                job.end_time = str(new_end_time)
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

