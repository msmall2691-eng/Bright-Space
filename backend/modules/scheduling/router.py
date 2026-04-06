import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

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


def job_to_dict(j: Job) -> dict:
    return {
        "id": j.id,
        "client_id": j.client_id,
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
    q = db.query(Job)
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


@router.post("/check-conflicts")
def check_job_conflicts(data: JobCreate, db: Session = Depends(get_db)):
    """Check for scheduling conflicts before creating a job."""
    from modules.scheduling.conflicts import check_conflicts
    conflicts = check_conflicts(
        db,
        scheduled_date=data.scheduled_date,
        start_time=data.start_time,
        end_time=data.end_time,
        cleaner_ids=data.cleaner_ids,
        property_id=data.property_id,
    )
    return {"conflicts": conflicts, "has_conflicts": len(conflicts) > 0}


@router.post("", status_code=201)
def create_job(data: JobCreate, db: Session = Depends(get_db)):
    # Check for conflicts and attach warnings
    from modules.scheduling.conflicts import check_conflicts
    conflicts = check_conflicts(
        db,
        scheduled_date=data.scheduled_date,
        start_time=data.start_time,
        end_time=data.end_time,
        cleaner_ids=data.cleaner_ids,
        property_id=data.property_id,
    )

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
    result = job_to_dict(job)
    if conflicts:
        result["conflicts"] = conflicts
    return result


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_dict(job)


@router.patch("/{job_id}")
def update_job(job_id: int, data: JobUpdate, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    updates = data.model_dump(exclude_none=True)
    # Track if scheduling-relevant fields changed (need GCal update)
    gcal_fields = {"title", "scheduled_date", "start_time", "end_time", "address", "notes"}
    needs_gcal_update = any(f in updates for f in gcal_fields)

    for field, value in updates.items():
        setattr(job, field, value)
    db.commit()
    db.refresh(job)

    # Auto-update Google Calendar event if schedule changed
    if needs_gcal_update and job.gcal_event_id:
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

    # Check conflicts after update
    result = job_to_dict(job)
    from modules.scheduling.conflicts import check_conflicts
    conflicts = check_conflicts(
        db,
        scheduled_date=job.scheduled_date,
        start_time=job.start_time,
        end_time=job.end_time,
        cleaner_ids=job.cleaner_ids,
        property_id=job.property_id,
        exclude_job_id=job.id,
    )
    if conflicts:
        result["conflicts"] = conflicts
    return result


@router.delete("/{job_id}", status_code=204)
def delete_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # Auto-delete from Google Calendar
    if job.gcal_event_id:
        try:
            from integrations.google_calendar import delete_event
            delete_event(job.gcal_event_id, job.job_type or "residential")
        except Exception as e:
            logger.warning(f"GCal delete failed for job {job.id}: {e}")
    db.delete(job)
    db.commit()


