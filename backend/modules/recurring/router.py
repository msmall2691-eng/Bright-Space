import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import date, timedelta

logger = logging.getLogger(__name__)

from database.db import get_db
from database.models import RecurringSchedule, Job

router = APIRouter()

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
FREQ_INTERVALS = {"weekly": 1, "biweekly": 2, "monthly": None}


class ScheduleCreate(BaseModel):
    client_id: int
    job_type: str                  # "residential" | "commercial"
    title: str
    address: str
    frequency: str                 # "weekly" | "biweekly" | "monthly"
    interval_weeks: Optional[int] = 1  # 1 for weekly, 2 for biweekly, 3+ for custom
    days_of_week: Optional[List[int]] = []  # [0,2,4] for Mon/Wed/Fri
    day_of_week: Optional[int] = 0          # kept for compat; used if days_of_week empty
    day_of_month: Optional[int] = None
    start_time: str                # HH:MM
    end_time: str                  # HH:MM
    cleaner_ids: Optional[List[str]] = []
    quote_id: Optional[int] = None
    property_id: Optional[int] = None
    generate_weeks_ahead: Optional[int] = 8
    notes: Optional[str] = None


class ScheduleUpdate(BaseModel):
    title: Optional[str] = None
    address: Optional[str] = None
    frequency: Optional[str] = None
    interval_weeks: Optional[int] = None
    days_of_week: Optional[List[int]] = None
    day_of_week: Optional[int] = None
    day_of_month: Optional[int] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    cleaner_ids: Optional[List[str]] = None
    active: Optional[bool] = None
    property_id: Optional[int] = None
    generate_weeks_ahead: Optional[int] = None
    notes: Optional[str] = None


def _effective_days(s: RecurringSchedule) -> List[int]:
    """Return the list of days-of-week for this schedule (handles legacy single-day)."""
    if s.days_of_week:
        return s.days_of_week
    return [s.day_of_week] if s.day_of_week is not None else [0]


def sched_to_dict(s: RecurringSchedule) -> dict:
    days = _effective_days(s)
    return {
        "id": s.id,
        "client_id": s.client_id,
        "property_id": s.property_id,
        "job_type": s.job_type,
        "title": s.title,
        "address": s.address,
        "frequency": s.frequency,
        "interval_weeks": s.interval_weeks,
        "days_of_week": days,
        "day_of_week": days[0] if days else 0,
        "day_of_week_name": DAY_NAMES[days[0]] if days else "",
        "day_of_month": s.day_of_month,
        "start_time": s.start_time,
        "end_time": s.end_time,
        "cleaner_ids": s.cleaner_ids or [],
        "quote_id": s.quote_id,
        "active": s.active,
        "generate_weeks_ahead": s.generate_weeks_ahead,
        "notes": s.notes,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def generate_dates(sched: RecurringSchedule, weeks_ahead: int) -> List[str]:
    """Return sorted list of YYYY-MM-DD dates this schedule should run in the next N weeks."""
    today = date.today()
    end = today + timedelta(weeks=weeks_ahead)
    result = []

    if sched.frequency == "monthly":
        dom = sched.day_of_month or 1
        current = date(today.year, today.month, 1)
        while current <= end:
            try:
                target = date(current.year, current.month, dom)
                if target >= today:
                    result.append(target.isoformat())
            except ValueError:
                pass  # invalid day for this month (e.g., Feb 30)
            if current.month == 12:
                current = date(current.year + 1, 1, 1)
            else:
                current = date(current.year, current.month + 1, 1)
    else:
        weeks_interval = sched.interval_weeks
        days = _effective_days(sched)
        for dow in days:
            days_ahead = (dow - today.weekday()) % 7
            current = today + timedelta(days=days_ahead)
            while current <= end:
                result.append(current.isoformat())
                current += timedelta(weeks=weeks_interval)

    return sorted(set(result))


def generate_jobs(db: Session, sched: RecurringSchedule) -> int:
    """Create Job records for dates that don't already have one. Returns count created."""
    from database.models import Client
    from integrations.google_calendar import create_event

    dates = generate_dates(sched, sched.generate_weeks_ahead)
    created = 0
    new_jobs = []

    for d in dates:
        exists = db.query(Job).filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date == d,
        ).first()
        if exists:
            continue
        job = Job(
            client_id=sched.client_id,
            recurring_schedule_id=sched.id,
            property_id=sched.property_id,
            job_type=sched.job_type,
            title=sched.title,
            scheduled_date=d,
            start_time=sched.start_time,
            end_time=sched.end_time,
            address=sched.address,
            cleaner_ids=sched.cleaner_ids or [],
            status="scheduled",
            notes=sched.notes,
        )
        db.add(job)
        new_jobs.append(job)
        created += 1

    db.commit()

    # Auto-push new jobs to Google Calendar
    if new_jobs:
        client = db.query(Client).filter(Client.id == sched.client_id).first()
        client_dict = {"name": client.name if client else "", "email": getattr(client, "email", None)}
        for job in new_jobs:
            db.refresh(job)
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
            }
            try:
                event_id = create_event(job_dict, client_dict)
                if event_id:
                    job.calendar_invite_sent = True
                    job.gcal_event_id = event_id
            except Exception as e:
                logger.warning(f"GCal push failed for job {job.id} (schedule {sched.id}): {e}")
        db.commit()

    return created


@router.get("")
def get_schedules(client_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(RecurringSchedule)
    if client_id:
        q = q.filter(RecurringSchedule.client_id == client_id)
    schedules = q.all()

    # Annotate each schedule with the count of upcoming generated jobs so the
    # UI can show "4 upcoming" next to the schedule, instead of leaving the
    # user guessing whether anything actually got generated.
    today = date.today().isoformat()
    out = []
    for s in schedules:
        d = sched_to_dict(s)
        d["upcoming_job_count"] = db.query(Job).filter(
            Job.recurring_schedule_id == s.id,
            Job.scheduled_date >= today,
            Job.status != "cancelled",
        ).count()
        out.append(d)
    return out


@router.post("", status_code=201)
def create_schedule(data: ScheduleCreate, db: Session = Depends(get_db)):
    payload = data.model_dump()
    # Normalise: if days_of_week not set, derive from day_of_week
    if not payload.get("days_of_week"):
        payload["days_of_week"] = [payload.get("day_of_week", 0)]
    # Keep day_of_week in sync with first day for legacy compat
    payload["day_of_week"] = payload["days_of_week"][0]
    sched = RecurringSchedule(**payload)
    db.add(sched)
    db.commit()
    db.refresh(sched)
    # Auto-generate initial jobs
    jobs_created = generate_jobs(db, sched)
    result = sched_to_dict(sched)
    result["jobs_created"] = jobs_created
    return result


@router.get("/{schedule_id}")
def get_schedule(schedule_id: int, db: Session = Depends(get_db)):
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return sched_to_dict(sched)


@router.patch("/{schedule_id}")
def update_schedule(schedule_id: int, data: ScheduleUpdate, db: Session = Depends(get_db)):
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    updates = data.model_dump(exclude_none=True)
    for field, value in updates.items():
        setattr(sched, field, value)
    # Keep day_of_week in sync with first element of days_of_week
    if "days_of_week" in updates and updates["days_of_week"]:
        sched.day_of_week = updates["days_of_week"][0]
    db.commit()
    db.refresh(sched)
    return sched_to_dict(sched)


@router.post("/generate-all")
def generate_all(db: Session = Depends(get_db)):
    """Generate jobs for all active recurring schedules."""
    schedules = db.query(RecurringSchedule).filter(RecurringSchedule.active == True).all()
    total = sum(generate_jobs(db, s) for s in schedules)
    return {"schedules_processed": len(schedules), "jobs_created": total}


@router.post("/{schedule_id}/generate")
def generate(schedule_id: int, db: Session = Depends(get_db)):
    """Manually trigger job generation for a single schedule."""
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    count = generate_jobs(db, sched)
    return {"schedule_id": schedule_id, "jobs_created": count}


@router.delete("/{schedule_id}", status_code=204)
def delete_schedule(schedule_id: int, db: Session = Depends(get_db)):
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    sched.active = False
    db.commit()
