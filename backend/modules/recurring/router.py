import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel
from typing import Optional, List
from datetime import date, timedelta

logger = logging.getLogger(__name__)

from database.db import get_db
from database.models import RecurringSchedule, Job, Visit, RecurrenceException
from utils.activity_logger import log_job_created, log_calendar_event

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


class ExceptionCreate(BaseModel):
    """Body for POST /api/recurring/{id}/skip and /reschedule."""
    exception_date: date              # the original occurrence to mark
    exception_type: Optional[str] = None  # set automatically by the endpoint
    rescheduled_date: Optional[date] = None
    rescheduled_start_time: Optional[str] = None  # HH:MM
    rescheduled_end_time: Optional[str] = None
    reason: Optional[str] = None


class RecurrenceExceptionRead(BaseModel):
    """Phase 6 step 2: response model for the exception endpoints. Matches
    the dict shape produced by ``_ex_to_dict``."""
    id: int
    recurring_schedule_id: int
    exception_date: Optional[str] = None
    exception_type: str
    rescheduled_date: Optional[str] = None
    rescheduled_start_time: Optional[str] = None
    rescheduled_end_time: Optional[str] = None
    reason: Optional[str] = None
    created_by: Optional[int] = None
    created_at: Optional[str] = None


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
    """Return the list of days-of-week for this schedule (handles legacy single-day).

    Phase 0 hardening: only fall back to the legacy ``day_of_week`` column when
    ``days_of_week`` is *truly* empty. An empty list previously collapsed
    multi-day schedules (Mon/Wed/Fri) to a single day after an update that
    omitted ``days_of_week``.
    """
    if s.days_of_week:
        # Defensive: dedupe + clamp to valid 0-6 range so a corrupted JSON blob
        # (e.g. [0, 0, 9]) does not silently break date generation.
        cleaned = sorted({int(d) for d in s.days_of_week if isinstance(d, (int, float)) and 0 <= int(d) <= 6})
        if cleaned:
            return cleaned
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


def _apply_exceptions(db: Session, sched: RecurringSchedule, dates: List[str]) -> List[str]:
    """Apply RecurrenceException rows to the rule-expanded date list.

    - skip rows REMOVE the original date.
    - reschedule rows REMOVE the original date and ADD the rescheduled_date.

    Returns a new sorted list. Phase 1: this is now the durable cancellation
    mechanism — the cancelled-Visit query in generate_jobs() is kept as a
    belt-and-suspenders safety net for any cancellations not yet migrated.
    """
    exceptions = (
        db.query(RecurrenceException)
        .filter(RecurrenceException.recurring_schedule_id == sched.id)
        .all()
    )
    if not exceptions:
        return dates

    skip_dates = set()
    add_dates = set()
    for ex in exceptions:
        ex_iso = ex.exception_date.isoformat() if hasattr(ex.exception_date, "isoformat") else str(ex.exception_date)
        skip_dates.add(ex_iso)
        if ex.exception_type == "reschedule" and ex.rescheduled_date:
            new_iso = ex.rescheduled_date.isoformat() if hasattr(ex.rescheduled_date, "isoformat") else str(ex.rescheduled_date)
            add_dates.add(new_iso)

    return sorted((set(dates) - skip_dates) | add_dates)


def generate_jobs(db: Session, sched: RecurringSchedule) -> int:
    """Create Job + Visit records for dates that don't already have one. Returns count created."""
    from database.models import Client
    from integrations.google_calendar import create_event

    dates = generate_dates(sched, sched.generate_weeks_ahead)
    # Phase 1: subtract skips and apply reschedules from the exception table.
    dates = _apply_exceptions(db, sched, dates)
    created = 0
    new_jobs = []

    # Dates already cancelled at the Visit level should NOT regenerate even if
    # the parent Job row is later hard-deleted. Visit is the durable cancellation
    # record until Phase 1 introduces a proper RecurrenceException table.
    cancelled_dates = {
        v.scheduled_date.isoformat() if hasattr(v.scheduled_date, "isoformat") else str(v.scheduled_date)
        for v in db.query(Visit)
        .join(Job, Visit.job_id == Job.id)
        .filter(
            Job.recurring_schedule_id == sched.id,
            Visit.status == "cancelled",
        )
        .all()
    }

    for d in dates:
        if d in cancelled_dates:
            # User cancelled this occurrence already; do not resurrect it.
            continue
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
        # Race-safe: if a concurrent /generate-all already inserted this row,
        # the partial unique index added in migration 004 raises IntegrityError;
        # roll back the savepoint and treat as already-exists.
        sp = db.begin_nested()
        try:
            db.add(job)
            db.flush()
            sp.commit()
            new_jobs.append(job)
            created += 1
        except IntegrityError:
            sp.rollback()
            logger.info(
                f"Skipped duplicate job for schedule {sched.id} on {d} "
                "(concurrent generate-all). This is expected and harmless."
            )

    db.commit()

    # Pre-materialize a Visit per new Job + log to unified timeline so the
    # client profile sees each scheduled occurrence.
    for job in new_jobs:
        db.refresh(job)
        visit = Visit(
            job_id=job.id,
            scheduled_date=job.scheduled_date,
            start_time=job.start_time,
            end_time=job.end_time,
            cleaner_ids=job.cleaner_ids or [],
            status="scheduled",
            notes=job.notes,
        )
        db.add(visit)
        log_job_created(db, job, actor="recurring_schedule")
    if new_jobs:
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
                    log_calendar_event(
                        db, "created",
                        client_id=job.client_id, job_id=job.id,
                        title=job.title, gcal_event_id=event_id,
                        scheduled_date=str(job.scheduled_date) if job.scheduled_date else None,
                    )
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


@router.get("/exceptions", response_model=List[RecurrenceExceptionRead])
def list_all_exceptions(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """List recurrence exceptions across ALL schedules, optionally filtered by
    a date range that matches against ``exception_date`` OR ``rescheduled_date``.

    Designed for the calendar view, which fetches Jobs in a date range and
    overlays exceptions to render skipped/rescheduled occurrences.
    """
    q = db.query(RecurrenceException)
    if date_from:
        try:
            d_from = date.fromisoformat(date_from)
        except ValueError:
            raise HTTPException(status_code=400, detail="date_from must be YYYY-MM-DD")
        q = q.filter(
            (RecurrenceException.exception_date >= d_from)
            | (RecurrenceException.rescheduled_date >= d_from)
        )
    if date_to:
        try:
            d_to = date.fromisoformat(date_to)
        except ValueError:
            raise HTTPException(status_code=400, detail="date_to must be YYYY-MM-DD")
        q = q.filter(
            (RecurrenceException.exception_date <= d_to)
            | (RecurrenceException.rescheduled_date <= d_to)
        )
    rows = q.order_by(RecurrenceException.exception_date).all()
    return [_ex_to_dict(e) for e in rows]


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
    # Phase 0 fix: an empty days_of_week list would silently collapse a
    # multi-day schedule. Reject it explicitly rather than dropping days.
    if "days_of_week" in updates and not updates["days_of_week"]:
        raise HTTPException(
            status_code=400,
            detail="days_of_week cannot be empty; pass null to leave unchanged or supply at least one day",
        )
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


# ---------------------------------------------------------------------------
# Phase 1: exception endpoints (skip / reschedule a single occurrence)
# ---------------------------------------------------------------------------

def _ex_to_dict(ex: RecurrenceException) -> dict:
    return {
        "id": ex.id,
        "recurring_schedule_id": ex.recurring_schedule_id,
        "exception_date": ex.exception_date.isoformat() if ex.exception_date else None,
        "exception_type": ex.exception_type,
        "rescheduled_date": ex.rescheduled_date.isoformat() if ex.rescheduled_date else None,
        "rescheduled_start_time": str(ex.rescheduled_start_time) if ex.rescheduled_start_time else None,
        "rescheduled_end_time": str(ex.rescheduled_end_time) if ex.rescheduled_end_time else None,
        "reason": ex.reason,
        "created_by": ex.created_by,
        "created_at": ex.created_at.isoformat() if ex.created_at else None,
    }


def _cancel_existing_job_and_visit(db: Session, sched_id: int, target_date: date, reason: Optional[str]) -> None:
    """Mark any Job + Visit on (schedule_id, target_date) as cancelled. Used
    when a skip/reschedule exception is added so the immediate UI reflects
    the change without waiting for the next /generate-all run."""
    iso = target_date.isoformat() if hasattr(target_date, "isoformat") else str(target_date)
    job = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched_id,
            Job.scheduled_date == iso,
            Job.status != "completed",
        )
        .first()
    )
    if job is None:
        return
    job.status = "cancelled"
    for v in db.query(Visit).filter(Visit.job_id == job.id).all():
        if v.status not in ("completed", "cancelled"):
            v.status = "cancelled"
            if reason:
                v.notes = (v.notes or "") + f"\n[Skipped via exception: {reason}]"


@router.post("/{schedule_id}/skip", status_code=201, response_model=RecurrenceExceptionRead)
def add_skip_exception(schedule_id: int, body: ExceptionCreate, db: Session = Depends(get_db)):
    """Skip a single occurrence of a recurring schedule.

    Idempotent: if an exception already exists for this date, the existing one
    is updated (reason/type) and returned with HTTP 200 semantics surfaced via
    the response payload's ``existing`` flag.
    """
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")

    existing = (
        db.query(RecurrenceException)
        .filter(
            RecurrenceException.recurring_schedule_id == schedule_id,
            RecurrenceException.exception_date == body.exception_date,
        )
        .first()
    )
    if existing:
        existing.exception_type = "skip"
        existing.rescheduled_date = None
        existing.rescheduled_start_time = None
        existing.rescheduled_end_time = None
        if body.reason:
            existing.reason = body.reason
        ex = existing
    else:
        ex = RecurrenceException(
            recurring_schedule_id=schedule_id,
            exception_date=body.exception_date,
            exception_type="skip",
            reason=body.reason,
        )
        db.add(ex)

    _cancel_existing_job_and_visit(db, schedule_id, body.exception_date, body.reason)
    db.commit()
    db.refresh(ex)
    return _ex_to_dict(ex)


@router.post("/{schedule_id}/reschedule", status_code=201, response_model=RecurrenceExceptionRead)
def add_reschedule_exception(schedule_id: int, body: ExceptionCreate, db: Session = Depends(get_db)):
    """Reschedule a single occurrence to a different date (and optionally time).

    The original Job/Visit on the original date is cancelled; the next
    generate_jobs call will create a Job for the new date.
    """
    if body.rescheduled_date is None:
        raise HTTPException(
            status_code=400,
            detail="rescheduled_date is required for a reschedule exception",
        )

    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")

    existing = (
        db.query(RecurrenceException)
        .filter(
            RecurrenceException.recurring_schedule_id == schedule_id,
            RecurrenceException.exception_date == body.exception_date,
        )
        .first()
    )
    if existing:
        ex = existing
        ex.exception_type = "reschedule"
        ex.rescheduled_date = body.rescheduled_date
        ex.rescheduled_start_time = body.rescheduled_start_time
        ex.rescheduled_end_time = body.rescheduled_end_time
        if body.reason:
            ex.reason = body.reason
    else:
        ex = RecurrenceException(
            recurring_schedule_id=schedule_id,
            exception_date=body.exception_date,
            exception_type="reschedule",
            rescheduled_date=body.rescheduled_date,
            rescheduled_start_time=body.rescheduled_start_time,
            rescheduled_end_time=body.rescheduled_end_time,
            reason=body.reason,
        )
        db.add(ex)

    _cancel_existing_job_and_visit(db, schedule_id, body.exception_date, body.reason)
    db.commit()
    db.refresh(ex)
    return _ex_to_dict(ex)


@router.get("/{schedule_id}/exceptions", response_model=List[RecurrenceExceptionRead])
def list_exceptions(schedule_id: int, db: Session = Depends(get_db)):
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    exceptions = (
        db.query(RecurrenceException)
        .filter(RecurrenceException.recurring_schedule_id == schedule_id)
        .order_by(RecurrenceException.exception_date)
        .all()
    )
    return [_ex_to_dict(e) for e in exceptions]


@router.delete("/{schedule_id}/exceptions/{exception_id}", status_code=204)
def delete_exception(schedule_id: int, exception_id: int, db: Session = Depends(get_db)):
    """Undo a skip or reschedule. The next generate_jobs call will recreate
    the Job for the original date if it falls within generate_weeks_ahead.

    Note: this does NOT automatically un-cancel an already-cancelled Job/Visit
    pair — the next generate run handles that by creating a fresh Job, since
    the cancelled Job from the skip is now an unrelated historical record.
    """
    ex = (
        db.query(RecurrenceException)
        .filter(
            RecurrenceException.id == exception_id,
            RecurrenceException.recurring_schedule_id == schedule_id,
        )
        .first()
    )
    if not ex:
        raise HTTPException(status_code=404, detail="Exception not found")
    db.delete(ex)
    db.commit()
