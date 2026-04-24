import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional, List, Literal
from datetime import datetime, date, time, timezone

from database.db import get_db
from database.models import Visit, Job, Client, Property
from modules.auth.router import get_current_user, require_role

logger = logging.getLogger(__name__)
router = APIRouter()


class VisitCreate(BaseModel):
    """Request body for POST /api/visits."""
    job_id: int
    sequence: int = 1
    scheduled_date: date
    start_time: time
    end_time: time
    status: Literal['scheduled','dispatched','en_route','in_progress','completed','canceled','no_show'] = 'scheduled'
    cleaner_ids: List[int] = []
    gcal_event_id: Optional[str] = None
    ical_source: Optional[str] = None
    ical_uid: Optional[str] = None
    checklist_template_id: Optional[int] = None
    notes: Optional[str] = None


class VisitUpdate(BaseModel):
    """Request body for PATCH /api/visits/{id}."""
    scheduled_date: Optional[date] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    status: Optional[Literal['scheduled','dispatched','en_route','in_progress','completed','canceled','no_show']] = None
    cleaner_ids: Optional[List[int]] = None
    gcal_event_id: Optional[str] = None
    ical_source: Optional[str] = None
    ical_uid: Optional[str] = None
    checklist_template_id: Optional[int] = None
    completed_at: Optional[str] = None
    completed_by: Optional[int] = None
    checklist_results: Optional[dict] = None
    photos: Optional[List[str]] = None
    notes: Optional[str] = None


class VisitRead(BaseModel):
    """Response model for GET /api/visits and POST/PATCH responses."""
    id: int
    job_id: int
    sequence: int
    scheduled_date: date
    start_time: time
    end_time: time
    status: str
    cleaner_ids: List[int]
    gcal_event_id: Optional[str]
    ical_source: Optional[str]
    ical_uid: Optional[str]
    checklist_template_id: Optional[int]
    completed_at: Optional[datetime]
    completed_by: Optional[int]
    checklist_results: Optional[dict]
    photos: Optional[List[str]]
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


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


@router.get("/admin/coverage-check", dependencies=[Depends(require_role("admin", "manager"))])
def check_visits_coverage(db: Session = Depends(get_db)):
    """Check if all jobs have corresponding visits."""
    from sqlalchemy import func

    total_jobs = db.query(Job).count()
    total_visits = db.query(Visit).count()
    jobs_without_visits = db.query(Job).outerjoin(Visit, Job.id == Visit.job_id).filter(Visit.id.is_(None)).count()

    return {
        "total_jobs": total_jobs,
        "total_visits": total_visits,
        "jobs_without_visits": jobs_without_visits,
        "coverage_percent": int((total_visits / total_jobs * 100) if total_jobs > 0 else 100),
        "healthy": jobs_without_visits == 0
    }


@router.post("/telemetry/drift-check")
def report_drift_check(db: Session = Depends(get_db)):
    """Report visits/jobs drift metrics for monitoring/alerting systems."""
    from datetime import datetime, timezone

    total_jobs = db.query(Job).count()
    total_visits = db.query(Visit).count()
    jobs_without_visits = db.query(Job).outerjoin(Visit, Job.id == Visit.job_id).filter(Visit.id.is_(None)).count()

    coverage_percent = int((total_visits / total_jobs * 100) if total_jobs > 0 else 100)
    healthy = jobs_without_visits == 0

    telemetry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metric_name": "visits_coverage_drift",
        "total_jobs": total_jobs,
        "total_visits": total_visits,
        "jobs_without_visits": jobs_without_visits,
        "coverage_percent": coverage_percent,
        "healthy": healthy,
        "severity": "info" if healthy else ("warning" if jobs_without_visits < total_jobs * 0.1 else "critical"),
    }

    logger.info(f"Drift check: {coverage_percent}% coverage, {jobs_without_visits} jobs missing visits")

    return telemetry


@router.post("/admin/backfill-visits-from-jobs", dependencies=[Depends(require_role("admin", "manager"))])
def backfill_visits_from_jobs(db: Session = Depends(get_db)):
    """Create one Visit per Job, inheriting job's scheduled_date/times/status/cleaner_ids."""
    jobs = db.query(Job).all()
    created_count = 0
    skipped_count = 0
    errors = []

    for job in jobs:
        try:
            existing_visit = db.query(Visit).filter(Visit.job_id == job.id).first()
            if existing_visit:
                skipped_count += 1
                continue

            visit = Visit(
                job_id=job.id,
                sequence=1,
                scheduled_date=job.scheduled_date,
                start_time=job.start_time,
                end_time=job.end_time,
                status=job.status or "scheduled",
                cleaner_ids=job.cleaner_ids or [],
            )
            db.add(visit)
            created_count += 1
        except Exception as e:
            errors.append({
                "job_id": job.id,
                "job_title": job.title,
                "error": str(e)
            })
            logger.error(f"Failed to create visit for job {job.id}: {e}")

    db.commit()

    return {
        "created": created_count,
        "skipped": skipped_count,
        "errors": errors,
        "total_jobs": len(jobs),
        "message": f"Backfill complete: created {created_count} visits, skipped {skipped_count} existing"
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer", "cleaner"))])
def get_visits(
    scheduled_date_from: Optional[str] = None,
    scheduled_date_to: Optional[str] = None,
    status: Optional[str] = None,
    property_type: Optional[str] = None,
    job_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """Get visits with date range and optional filters."""
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

    visits = q.order_by(Visit.scheduled_date, Visit.start_time).all()

    return [
        visit_to_dict(
            v,
            job=v.job if hasattr(v, "job") else None,
            client=v.job.client if hasattr(v, "job") and hasattr(v.job, "client") else None,
            property_obj=v.job.property if hasattr(v, "job") and hasattr(v.job, "property") else None,
        )
        for v in visits
    ]


@router.post("", status_code=201, response_model=VisitRead, dependencies=[Depends(require_role("admin", "manager"))])
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

    return visit


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


@router.put("/{visit_id}", response_model=VisitRead, dependencies=[Depends(require_role("admin", "manager"))])
@router.patch("/{visit_id}", response_model=VisitRead, dependencies=[Depends(require_role("admin", "manager"))])
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

    return visit


@router.delete("/{visit_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_visit(visit_id: int, db: Session = Depends(get_db)):
    """Delete a visit."""
    visit = db.query(Visit).filter(Visit.id == visit_id).first()
    if not visit:
        raise HTTPException(status_code=404, detail="Visit not found")

    db.delete(visit)
    db.commit()
