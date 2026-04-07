import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone

from database.db import get_db
from database.models import Job, Client

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
    property_id: Optional[int] = None
    cleaner_ids: Optional[List[str]] = []
    notes: Optional[str] = None


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
    }


@router.get("")
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


@router.post("", status_code=201)
def create_job(data: JobCreate, db: Session = Depends(get_db)):
    job = Job(**data.model_dump())
    db.add(job)
    db.commit()
    db.refresh(job)
    # Push to Google Calendar
    try:
        from integrations.google_calendar import create_event
        client = db.query(Client).filter(Client.id == job.client_id).first()
        client_dict = {"name": client.name if client else "", "email": getattr(client, "email", None)}
        job_dict = {
            "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
            "scheduled_date": job.scheduled_date, "start_time": job.start_time,
            "end_time": job.end_time, "address": job.address, "notes": job.notes,
        }
        event_id = create_event(job_dict, client_dict)
        if event_id:
            job.calendar_invite_sent = True
            job.gcal_event_id = event_id
            db.commit()
            db.refresh(job)
    except Exception as e:
        logger.warning(f"GCal push failed for job {job.id}: {e}")
    return job_to_dict(job)


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_dict(job)


@router.patch("/{job_id}")
def update_job(job_id: int, data: JobUpdate, db: Session = Depends(get_db)):
    job = db.query(Job).options(joinedload(Job.client)).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(job, field, value)
    db.commit()
    db.refresh(job)
    # Sync update to Google Calendar if event exists
    if job.gcal_event_id:
        try:
            from integrations.google_calendar import update_event
            client = db.query(Client).filter(Client.id == job.client_id).first()
            client_dict = {"name": client.name if client else "", "email": getattr(client, "email", None)}
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
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
    # Remove from Google Calendar if event exists
    if job.gcal_event_id:
        try:
            from integrations.google_calendar import delete_event
            delete_event(job.gcal_event_id, job.job_type or "residential")
        except Exception as e:
            logger.warning(f"GCal delete failed for job {job.id}: {e}")
    db.delete(job)
    db.commit()


@router.post("/push-to-gcal")
def push_to_gcal(db: Session = Depends(get_db)):
    """
    Push BrightBase jobs TO Google Calendar. BrightBase is the source of truth.
    - Jobs without a GCal event get created on GCal.
    - Jobs with a GCal event get updated on GCal.
    """
    try:
        from integrations.google_calendar import create_event, update_event
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"GCal not configured: {e}")

    jobs = db.query(Job).options(joinedload(Job.client)).filter(
        Job.status.in_(["scheduled", "in_progress"]),
        Job.scheduled_date >= datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    ).all()

    if not jobs:
        return {"pushed": 0, "created": 0, "updated": 0, "message": "No upcoming jobs to push"}

    created_count = 0
    updated_count = 0
    errors = []

    for job in jobs:
        client = job.client
        client_dict = {"name": client.name if client else "", "email": getattr(client, "email", None) if client else None}
        job_dict = {
            "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
            "scheduled_date": job.scheduled_date, "start_time": job.start_time,
            "end_time": job.end_time, "address": job.address, "notes": job.notes,
        }
        try:
            if job.gcal_event_id:
                update_event(job.gcal_event_id, job_dict, client_dict)
                updated_count += 1
            else:
                event_id = create_event(job_dict, client_dict)
                if event_id:
                    job.calendar_invite_sent = True
                    job.gcal_event_id = event_id
                    created_count += 1
        except Exception as e:
            errors.append({"job_id": job.id, "error": str(e)})

    db.commit()
    total = created_count + updated_count
    return {
        "pushed": total, "created": created_count, "updated": updated_count,
        "errors": errors, "message": f"Pushed {total} job(s) to Google Calendar"
    }


@router.post("/sync-gcal")
def sync_from_gcal(db: Session = Depends(get_db)):
    """
    DEPRECATED: Use push-to-gcal instead. BrightBase is the source of truth.
    This endpoint is kept for backwards compatibility but now only detects
    GCal events that were deleted externally (unlinks them).
    """
    try:
        from integrations.google_calendar import _get_service, _calendar_id
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"GCal not configured: {e}")

    jobs = db.query(Job).filter(Job.gcal_event_id.isnot(None)).all()
    if not jobs:
        return {"synced": 0, "message": "No jobs with GCal event IDs found"}

    try:
        service = _get_service()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    unlinked = 0
    errors = []

    cal_jobs: dict = {}
    for job in jobs:
        cal_id = _calendar_id(job.job_type or "residential")
        cal_jobs.setdefault(cal_id, []).append(job)

    for cal_id, cal_job_list in cal_jobs.items():
        for job in cal_job_list:
            try:
                service.events().get(calendarId=cal_id, eventId=job.gcal_event_id).execute()
            except Exception as e:
                if "404" in str(e) or "410" in str(e):
                    job.gcal_event_id = None
                    job.calendar_invite_sent = False
                    unlinked += 1
                else:
                    errors.append({"job_id": job.id, "error": str(e)})

    db.commit()
    return {
        "unlinked": unlinked, "errors": errors,
        "message": f"Checked GCal links — unlinked {unlinked} deleted event(s). BrightBase is the source of truth."
    }
