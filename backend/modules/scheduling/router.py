import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone, date, time
from zoneinfo import ZoneInfo

from database.db import get_db
from database.models import Job, Client, Visit
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


def job_to_dict(j: Job, client: Client = None) -> dict:
    # Resolve client name if not passed in
    client_name = ""
    if client:
        client_name = client.name or ""
    elif j.client and hasattr(j, "client"):
        client_name = j.client.name if j.client else ""
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
        "scheduled_date": j.scheduled_date,
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
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_jobs(
    client_id: Optional[int] = None,
    status: Optional[str] = None,
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    job_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Job).options(joinedload(Job.client))
    if client_id:
        q = q.filter(Job.client_id == client_id)
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
    return [job_to_dict(j) for j in q.order_by(Job.scheduled_date, Job.start_time).all()]


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


@router.post("/push-to-gcal")
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


@router.post("/sync-gcal")
def sync_from_gcal(db: Session = Depends(get_db)):
    """
    Full two-way sync with Google Calendar.
    Matches events to clients by: extendedProperties → attendee email → address.
    """
    from integrations.gcal_sync import sync_calendar
    result = sync_calendar(db)
    if result.get("error"):
        raise HTTPException(status_code=502, detail=result["error"])
    return result


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


@router.delete("/{job_id}", status_code=204)
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


@router.post("/{job_id}/invite-client")
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


@router.post("/{job_id}/convert-to-invoice", status_code=201)
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
    due_date = (datetime.utcnow() + timedelta(days=14)).strftime("%Y-%m-%d")

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
                            dt_utc = datetime.strptime(timestamp_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=pytz.UTC)
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

