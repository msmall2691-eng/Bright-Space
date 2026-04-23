import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone

from database.db import get_db
from database.models import Visit, Job, Client, Property
from modules.auth.router import get_current_user, require_role

logger = logging.getLogger(__name__)
router = APIRouter()


class VisitCreate(BaseModel):
    job_id: int
    scheduled_date: str       # YYYY-MM-DD
    start_time: str           # HH:MM
    end_time: str             # HH:MM
    cleaner_ids: Optional[List[str]] = []
    status: Optional[str] = "scheduled"
    notes: Optional[str] = None


class VisitUpdate(BaseModel):
    scheduled_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    cleaner_ids: Optional[List[str]] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    completed_at: Optional[str] = None
    completed_by: Optional[str] = None
    checklist_results: Optional[dict] = None
    photos: Optional[List[str]] = None


def visit_to_dict(v: Visit, job: Job = None, client: Client = None, property_obj: Property = None) -> dict:
    """Convert Visit model to dict with enriched data."""
    # Resolve job if not passed in
    if not job and hasattr(v, "job") and v.job:
        job = v.job

    # Resolve client from job
    if not client and job and hasattr(job, "client") and job.client:
        client = job.client

    # Resolve property if not passed in
    if not property_obj and job and hasattr(job, "property") and job.property:
        property_obj = job.property

    job_dict = {
        "id": job.id,
        "client_id": job.client_id,
        "quote_id": job.quote_id,
        "title": job.title,
        "job_type": job.job_type or "residential",
    } if job else {}

    client_dict = {
        "id": client.id,
        "name": client.name or "",
    } if client else {}

    property_dict = {
        "id": property_obj.id,
        "name": property_obj.name or "",
        "address": property_obj.address or "",
        "property_type": property_obj.property_type or "residential",
    } if property_obj else {}

    return {
        "id": v.id,
        "job_id": v.job_id,
        "scheduled_date": str(v.scheduled_date) if v.scheduled_date else None,
        "start_time": str(v.start_time) if v.start_time else None,
        "end_time": str(v.end_time) if v.end_time else None,
        "cleaner_ids": v.cleaner_ids or [],
        "status": v.status,
        "notes": v.notes,
        "ical_source": v.ical_source,
        "ical_uid": v.ical_uid,
        "gcal_event_id": v.gcal_event_id,
        "completed_at": v.completed_at.isoformat() if v.completed_at else None,
        "completed_by": v.completed_by,
        "checklist_results": v.checklist_results or {},
        "photos": v.photos or [],
        "job": job_dict,
        "client": client_dict,
        "property": property_dict,
        "created_at": v.created_at.isoformat() if v.created_at else None,
        "updated_at": v.updated_at.isoformat() if v.updated_at else None,
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_visits(
    scheduled_date_from: Optional[str] = None,
    scheduled_date_to: Optional[str] = None,
    status: Optional[str] = None,
    property_type: Optional[str] = None,
    job_id: Optional[int] = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Get visits with date range and optional filters. Paginated for performance."""
    q = db.query(Visit).options(
        joinedload(Visit.job).joinedload(Job.client),
        joinedload(Visit.job).joinedload(Job.property)
    )

    if scheduled_date_from:
        q = q.filter(Visit.scheduled_date >= scheduled_date_from)
    if scheduled_date_to:
        q = q.filter(Visit.scheduled_date <= scheduled_date_to)
    if status:
        q = q.filter(Visit.status == status)
    if job_id:
        q = q.filter(Visit.job_id == job_id)

    # Filter by property_type if provided
    if property_type and property_type != "all":
        q = q.join(Job).join(Property).filter(Property.property_type == property_type)

    # Apply pagination BEFORE executing the query
    total_count = q.count()
    visits = q.order_by(Visit.scheduled_date, Visit.start_time).limit(limit).offset(offset).all()

    return {
        "items": [
            visit_to_dict(
                v,
                job=v.job if hasattr(v, "job") else None,
                client=v.job.client if hasattr(v, "job") and hasattr(v.job, "client") else None,
                property_obj=v.job.property if hasattr(v, "job") and hasattr(v.job, "property") else None,
            )
            for v in visits
        ],
        "total": total_count,
        "limit": limit,
        "offset": offset,
    }


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_visit(data: VisitCreate, db: Session = Depends(get_db)):
    """Create a new visit."""
    job = db.query(Job).filter(Job.id == data.job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    visit = Visit(
        job_id=data.job_id,
        scheduled_date=data.scheduled_date,
        start_time=data.start_time,
        end_time=data.end_time,
        cleaner_ids=data.cleaner_ids or [],
        status=data.status or "scheduled",
        notes=data.notes,
    )
    db.add(visit)
    db.commit()
    db.refresh(visit)

    client = job.client if hasattr(job, "client") else None
    property_obj = job.property if hasattr(job, "property") else None

    return visit_to_dict(visit, job=job, client=client, property_obj=property_obj)


@router.get("/{visit_id}", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_visit(visit_id: int, db: Session = Depends(get_db)):
    """Get a single visit by ID."""
    visit = db.query(Visit).options(
        joinedload(Visit.job).joinedload(Job.client),
        joinedload(Visit.job).joinedload(Job.property)
    ).filter(Visit.id == visit_id).first()

    if not visit:
        raise HTTPException(status_code=404, detail="Visit not found")

    return visit_to_dict(
        visit,
        job=visit.job if hasattr(visit, "job") else None,
        client=visit.job.client if hasattr(visit, "job") and hasattr(visit.job, "client") else None,
        property_obj=visit.job.property if hasattr(visit, "job") and hasattr(visit.job, "property") else None,
    )


@router.put("/{visit_id}", dependencies=[Depends(require_role("admin", "manager"))])
@router.patch("/{visit_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_visit(visit_id: int, data: VisitUpdate, db: Session = Depends(get_db)):
    """Update a visit."""
    visit = db.query(Visit).options(
        joinedload(Visit.job).joinedload(Job.client),
        joinedload(Visit.job).joinedload(Job.property)
    ).filter(Visit.id == visit_id).first()

    if not visit:
        raise HTTPException(status_code=404, detail="Visit not found")

    # Update fields if provided
    for field in ["scheduled_date", "start_time", "end_time", "status", "notes", "completed_by", "checklist_results"]:
        val = getattr(data, field)
        if val is not None:
            setattr(visit, field, val)

    if data.cleaner_ids is not None:
        visit.cleaner_ids = data.cleaner_ids

    if data.photos is not None:
        visit.photos = data.photos

    # Handle completed_at timestamp
    if data.completed_at is not None:
        visit.completed_at = datetime.fromisoformat(data.completed_at) if isinstance(data.completed_at, str) else data.completed_at

    db.commit()
    db.refresh(visit)

    return visit_to_dict(
        visit,
        job=visit.job if hasattr(visit, "job") else None,
        client=visit.job.client if hasattr(visit, "job") and hasattr(visit.job, "client") else None,
        property_obj=visit.job.property if hasattr(visit, "job") and hasattr(visit.job, "property") else None,
    )


@router.delete("/{visit_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_visit(visit_id: int, db: Session = Depends(get_db)):
    """Delete a visit."""
    visit = db.query(Visit).filter(Visit.id == visit_id).first()
    if not visit:
        raise HTTPException(status_code=404, detail="Visit not found")

    db.delete(visit)
    db.commit()
