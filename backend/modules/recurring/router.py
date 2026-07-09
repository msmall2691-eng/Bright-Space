import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel
from typing import Optional, List
from datetime import date, timedelta

logger = logging.getLogger(__name__)

from database.db import get_db
from modules.auth.router import require_role, current_org_id, resolve_org_id
from database.models import RecurringSchedule, Job, RecurrenceException
from utils.activity_logger import log_job_created, log_calendar_event
from utils.dates import business_today

router = APIRouter()


def _get_schedule_or_404(db: Session, schedule_id: int, org_id: int) -> RecurringSchedule:
    """Fetch a RecurringSchedule scoped to the caller's org, 404 otherwise.

    Every endpoint here used to do a bare `.filter(RecurringSchedule.id ==
    schedule_id).first()` with no org check — a cross-tenant IDOR: any
    authenticated user in any org could read/edit/skip/delete any other org's
    recurring schedule by guessing/incrementing an id. Same permissive
    `or_(org_id == X, org_id.is_(None))` convention used across the app
    (org_id is still nullable — MT-4 NOT NULL backfill hasn't shipped)."""
    sched = db.query(RecurringSchedule).filter(
        RecurringSchedule.id == schedule_id,
        or_(RecurringSchedule.org_id == org_id, RecurringSchedule.org_id.is_(None)),
    ).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return sched

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
    # "This visit only" scope (Fix 1): a per-occurrence crew override.
    # RecurrenceException itself has no cleaner_ids column (it's a date/time
    # deviation record), so this is applied directly to the materialized Job
    # rather than stored on the exception row.
    cleaner_ids: Optional[List[str]] = None
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
    # Only populated by /reschedule — the materialized Job id, so the caller
    # can follow up with a PATCH for fields the exception model doesn't cover
    # (title, notes, address, cleaner_ids on an /skip-only flow) without a
    # separate lookup query.
    job_id: Optional[int] = None


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
    # "All visits" scope (Fix 3): when true, re-sync every non-completed,
    # non-exception future Job already generated under this schedule to the
    # edited rule instead of leaving them stale until they age off the
    # calendar. Default false preserves the old (rule-only) PATCH behavior.
    resync: Optional[bool] = False


class ScheduleSplit(BaseModel):
    """Body for POST /api/recurring/{id}/split — Jobber's "this and all
    future" scope. `split_date` is the first date the NEW rule applies from;
    every other field is the same shape as ScheduleUpdate and, when given,
    overrides the old schedule's value on the new one (unset fields carry
    over unchanged)."""
    split_date: date
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
        "series_end_date": s.series_end_date.isoformat() if s.series_end_date else None,
        "series_start_date": s.series_start_date.isoformat() if s.series_start_date else None,
        "notes": s.notes,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _as_date(value):
    """Coerce a value (ISO string, date, or None) to a date | None. Used so the
    recurrence date math works in pure date objects regardless of whether a
    column came back as a date (Postgres) or a string."""
    if value is None or isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _as_time(value):
    """Coerce a value (ISO/HH:MM string, time, or None) to a time | None.

    ScheduleCreate/ScheduleUpdate/ScheduleSplit accept start_time/end_time as
    plain "HH:MM" strings (matching the rest of this module's API), but a
    Time column needs a real time object — Postgres's psycopg2 leniently
    casts a bare string, SQLite's Time type does not (raises TypeError), so
    anything that writes one of these fields must go through this first."""
    from datetime import time as _time
    if value is None or isinstance(value, _time):
        return value
    try:
        return _time.fromisoformat(str(value))
    except (ValueError, TypeError):
        return None


def _validate_timing(start, end) -> None:
    """Reject an inverted/zero-width window. Mirrors scheduling/router.py's
    _validate_job_timing — this module's endpoints (reschedule/split/update)
    write start_time/end_time too but had no equivalent guard, so e.g.
    changing only a visit's start time via the calendar (leaving the old end
    time in place) could silently save start > end."""
    st, et = _as_time(start), _as_time(end)
    if st is not None and et is not None and et <= st:
        raise HTTPException(
            status_code=400,
            detail=f"End time ({end}) must be after start time ({start}).",
        )


def generate_dates(sched: RecurringSchedule, weeks_ahead: int) -> List[date]:
    """Return a sorted list of dates this schedule should run in the next N weeks."""
    today = business_today()
    # series_start_date is the inclusive floor a "this and all future" split
    # sets on the NEW schedule: without it, a changed day-of-week could
    # generate occurrences before the split point, since this function
    # otherwise always expands from today forward with no lower bound.
    series_start = _as_date(getattr(sched, "series_start_date", None))
    if series_start is not None and series_start > today:
        today = series_start
    end = today + timedelta(weeks=weeks_ahead)
    # series_end_date is the exclusive boundary a "this and all future" split
    # sets on the OLD schedule — never generate on/after it, so the new
    # schedule (which owns that date forward) is the sole producer there.
    series_end = _as_date(getattr(sched, "series_end_date", None))
    if series_end is not None and series_end <= end:
        end = series_end - timedelta(days=1)
    result = []

    if sched.frequency == "daily":
        # Every N days (interval_weeks reused as the day step for daily; default
        # 1 = every day). If specific weekdays are chosen, keep only those.
        step = max(1, sched.interval_weeks or 1)
        chosen = set(_effective_days(sched)) if sched.days_of_week else None
        current = today
        while current <= end:
            if chosen is None or current.weekday() in chosen:
                result.append(current)
            current += timedelta(days=step)
    elif sched.frequency == "monthly":
        dom = sched.day_of_month or 1
        current = date(today.year, today.month, 1)
        while current <= end:
            try:
                target = date(current.year, current.month, dom)
                if target >= today:
                    result.append(target)
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
                result.append(current)
                current += timedelta(weeks=weeks_interval)

    return sorted(set(result))


def _apply_exceptions(db: Session, sched: RecurringSchedule, dates: List[date]) -> List[date]:
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
        ex_d = _as_date(ex.exception_date)
        if ex_d:
            skip_dates.add(ex_d)
        if ex.exception_type == "reschedule" and ex.rescheduled_date:
            new_d = _as_date(ex.rescheduled_date)
            if new_d:
                add_dates.add(new_d)

    return sorted((set(dates) - skip_dates) | add_dates)


def generate_jobs(db: Session, sched: RecurringSchedule) -> int:
    """Create Job records for schedule dates that don't already have one.
    Returns count created."""
    from database.models import Client
    from integrations.google_calendar import create_event

    dates = generate_dates(sched, sched.generate_weeks_ahead)
    # Phase 1: subtract skips and apply reschedules from the exception table.
    dates = _apply_exceptions(db, sched, dates)
    created = 0
    new_jobs = []

    # Dates already cancelled at the Job level should NOT regenerate. After
    # the Job/Visit unification (migration 039), Job.status is the durable
    # cancellation record; RecurrenceException also blocks known-skipped dates
    # via _apply_exceptions above.
    cancelled_dates = {
        _as_date(j.scheduled_date)
        for j in db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched.id,
            Job.status == "cancelled",
            Job.scheduled_date.isnot(None),
        )
        .all()
    }

    # Safety-net: rescue any existing Jobs for this schedule whose
    # scheduled_date got nulled (root cause under investigation — see iCal
    # parallel). Map them onto rule-derived dates that have no Job yet so
    # they show on the Schedule again instead of being orphaned.
    orphaned = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date.is_(None),
            Job.status.notin_(("cancelled", "completed")),
        )
        .order_by(Job.id.asc())
        .all()
    )
    if orphaned:
        # Normalize to date objects so membership checks against the (date-typed)
        # rule dates actually match — previously these were raw column values
        # that could be date objects compared against ISO strings, so taken
        # dates were never excluded and duplicate jobs could slip through.
        taken_dates = {
            _as_date(j.scheduled_date) for j in db.query(Job).filter(
                Job.recurring_schedule_id == sched.id,
                Job.scheduled_date.isnot(None),
            ).all()
        }
        available = [d for d in dates if d not in cancelled_dates and d not in taken_dates]
        for j, d in zip(orphaned, available):
            j.scheduled_date = d
            if not j.start_time:
                j.start_time = sched.start_time
            if not j.end_time:
                j.end_time = sched.end_time
            logger.info(f"[recurring] rescued orphan Job {j.id} → scheduled_date={d}")
        db.flush()

    # Self-heal: recurring jobs that kept their date but lost start/end time
    # (residual damage from the now-disabled VARCHAR→DATE boot migration that
    # wiped Job.start_time/end_time — see database/db.py). Re-populate from the
    # schedule so they stop rendering as "– –", without needing the manual
    # backfill tool. Terminal (completed/cancelled) jobs are left as history.
    timeless = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date.isnot(None),
            or_(Job.start_time.is_(None), Job.end_time.is_(None)),
            Job.status.notin_(("cancelled", "completed")),
        )
        .all()
    )
    for j in timeless:
        if not j.start_time:
            j.start_time = sched.start_time
        if not j.end_time:
            j.end_time = sched.end_time
        logger.info(f"[recurring] healed missing time on Job {j.id} → {sched.start_time}–{sched.end_time}")
    if timeless:
        db.flush()

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
            org_id=sched.org_id,  # MT-2: inherit the schedule's tenant
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

    # Log each generated Job to the unified activity timeline so the client
    # profile sees the occurrence. (The old Visit dual-write here was removed
    # by migration 039 — occurrences are Jobs now.)
    for job in new_jobs:
        db.refresh(job)
        log_job_created(db, job, actor="recurring_schedule")
    if new_jobs:
        db.commit()

    # Auto-push new jobs to Google Calendar
    if new_jobs:
        from modules.settings.router import customer_invites_enabled
        client = db.query(Client).filter(Client.id == sched.client_id).first()
        client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None)}
        invite = customer_invites_enabled(db) and bool(client and client.email)
        for job in new_jobs:
            db.refresh(job)
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
            }
            try:
                event_id = create_event(job_dict, client_dict, send_invite=invite)
                if event_id:
                    job.calendar_invite_sent = invite
                    job.gcal_event_id = event_id
                    from integrations.google_calendar import active_account_id as _gcal_acct
                    job.gcal_account_id = _gcal_acct()
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
def get_schedules(client_id: Optional[int] = None, db: Session = Depends(get_db),
                  org_id: int = Depends(current_org_id)):
    oid = resolve_org_id(org_id, db)
    q = db.query(RecurringSchedule).filter(
        or_(RecurringSchedule.org_id == oid, RecurringSchedule.org_id.is_(None)),
    )
    if client_id:
        q = q.filter(RecurringSchedule.client_id == client_id)
    schedules = q.all()

    # Annotate each schedule with the count of upcoming generated jobs so the
    # UI can show "4 upcoming" next to the schedule, instead of leaving the
    # user guessing whether anything actually got generated.
    today = business_today().isoformat()
    out = []
    for s in schedules:
        d = sched_to_dict(s)
        d["upcoming_job_count"] = db.query(Job).filter(
            Job.recurring_schedule_id == s.id,
            Job.status != "cancelled",
            or_(Job.scheduled_date == None, Job.scheduled_date >= today),
        ).count()
        out.append(d)
    return out


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_schedule(data: ScheduleCreate, db: Session = Depends(get_db),
                    org_id: int = Depends(current_org_id)):
    payload = data.model_dump()
    # Normalise: if days_of_week not set, derive from day_of_week
    if not payload.get("days_of_week"):
        payload["days_of_week"] = [payload.get("day_of_week", 0)]
    # Keep day_of_week in sync with first day for legacy compat
    payload["day_of_week"] = payload["days_of_week"][0]
    sched = RecurringSchedule(**payload)
    sched.org_id = resolve_org_id(org_id, db)  # MT-2: stamp the caller's workspace
    db.add(sched)
    db.commit()
    db.refresh(sched)
    # Auto-generate initial jobs
    jobs_created = generate_jobs(db, sched)
    # If this schedule was set up from an accepted quote, convert that quote so
    # it stops showing "Set up schedule" and revenue→schedule traceability is
    # kept (mirrors scheduling.create_job / quoting.convert_quote_to_job).
    if sched.quote_id:
        from database.models import Quote
        from datetime import datetime
        q = db.query(Quote).filter(Quote.id == sched.quote_id).first()
        if q and q.status != "converted":
            q.status = "converted"
            q.converted_at = datetime.now()
            q.updated_at = datetime.now()
            db.commit()
    result = sched_to_dict(sched)
    result["jobs_created"] = jobs_created
    return result


@router.get("/exceptions", response_model=List[RecurrenceExceptionRead])
def list_all_exceptions(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """List recurrence exceptions across ALL schedules, optionally filtered by
    a date range that matches against ``exception_date`` OR ``rescheduled_date``.

    Designed for the calendar view, which fetches Jobs in a date range and
    overlays exceptions to render skipped/rescheduled occurrences.
    """
    oid = resolve_org_id(org_id, db)
    q = db.query(RecurrenceException).filter(
        or_(RecurrenceException.org_id == oid, RecurrenceException.org_id.is_(None)),
    )
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
def get_schedule(schedule_id: int, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id)):
    sched = _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))
    return sched_to_dict(sched)


def _resync_future_jobs(db: Session, sched: RecurringSchedule) -> int:
    """"All visits" scope (Fix 3): push the edited rule onto every Job already
    materialized for this schedule that a rule-only PATCH would otherwise
    leave stale.

    Jobber's #1 surprise: editing a recurring series only affected
    not-yet-generated dates, so the 8 weeks already on the calendar kept
    their old day/time/cleaners. A per-occurrence RecurrenceException means
    the user deliberately deviated that one date from the rule — those are
    left untouched. Completed/cancelled jobs are history, also left alone.
    Everything else is soft-cancelled and detached from the schedule (NOT
    hard-deleted — Activity rows FK to Job.id with no ON DELETE CASCADE, so
    a job with any history at all would 500 on delete) and immediately
    regenerated under the new rule, rather than patched in place, because a
    day-of-week change makes "update in place" nonsensical — a Monday
    occurrence can't become Wednesday by editing its start_time. Detaching
    (not just cancelling) matters too: generate_jobs()'s own cancelled-dates
    guard only excludes cancelled rows still on THIS schedule_id, so leaving
    recurring_schedule_id set would permanently block regeneration at that
    date; clearing it lets the date regenerate while the old row survives as
    an inert historical record.
    """
    today = business_today()
    exception_dates = {
        _as_date(e.exception_date)
        for e in db.query(RecurrenceException)
        .filter(RecurrenceException.recurring_schedule_id == sched.id)
        .all()
    }
    stale = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched.id,
            Job.status.notin_(("completed", "cancelled")),
            Job.scheduled_date.isnot(None),
            Job.scheduled_date >= today,
        )
        .all()
    )
    removed = 0
    for j in stale:
        if _as_date(j.scheduled_date) in exception_dates:
            continue
        j.status = "cancelled"
        j.recurring_schedule_id = None
        j.notes = (j.notes or "") + "\n[Superseded by an updated recurring schedule]"
        removed += 1
    if removed:
        db.flush()
    generate_jobs(db, sched)
    return removed


@router.patch("/{schedule_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_schedule(schedule_id: int, data: ScheduleUpdate, db: Session = Depends(get_db),
                    org_id: int = Depends(current_org_id)):
    sched = _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))
    updates = data.model_dump(exclude_none=True)
    resync = updates.pop("resync", False)
    # Phase 0 fix: an empty days_of_week list would silently collapse a
    # multi-day schedule. Reject it explicitly rather than dropping days.
    if "days_of_week" in updates and not updates["days_of_week"]:
        raise HTTPException(
            status_code=400,
            detail="days_of_week cannot be empty; pass null to leave unchanged or supply at least one day",
        )
    if "start_time" in updates:
        updates["start_time"] = _as_time(updates["start_time"])
    if "end_time" in updates:
        updates["end_time"] = _as_time(updates["end_time"])
    if "start_time" in updates or "end_time" in updates:
        _validate_timing(
            updates.get("start_time", sched.start_time),
            updates.get("end_time", sched.end_time),
        )
    for field, value in updates.items():
        setattr(sched, field, value)
    # Keep day_of_week in sync with first element of days_of_week
    if "days_of_week" in updates and updates["days_of_week"]:
        sched.day_of_week = updates["days_of_week"][0]
    db.commit()
    db.refresh(sched)
    resynced = _resync_future_jobs(db, sched) if resync else 0
    result = sched_to_dict(sched)
    result["resynced_jobs"] = resynced
    return result


@router.post("/generate-all", dependencies=[Depends(require_role("admin", "manager"))])
def generate_all(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Generate jobs for all active recurring schedules in the caller's org."""
    oid = resolve_org_id(org_id, db)
    schedules = db.query(RecurringSchedule).filter(
        RecurringSchedule.active == True,
        or_(RecurringSchedule.org_id == oid, RecurringSchedule.org_id.is_(None)),
    ).all()
    total = sum(generate_jobs(db, s) for s in schedules)
    return {"schedules_processed": len(schedules), "jobs_created": total}


@router.post("/{schedule_id}/generate", dependencies=[Depends(require_role("admin", "manager"))])
def generate(schedule_id: int, db: Session = Depends(get_db),
             org_id: int = Depends(current_org_id)):
    """Manually trigger job generation for a single schedule."""
    sched = _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))
    count = generate_jobs(db, sched)
    return {"schedule_id": schedule_id, "jobs_created": count}


@router.post("/{schedule_id}/split", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def split_schedule(schedule_id: int, data: ScheduleSplit, db: Session = Depends(get_db),
                   org_id: int = Depends(current_org_id)):
    """"This and all future" scope (Fix 2): split the series at split_date.

    The current schedule stops generating on/after split_date
    (series_end_date), and a NEW RecurringSchedule takes over from split_date
    forward with the edited rule — fields omitted from the request carry
    over from the old schedule unchanged. Any of the old schedule's own
    future, non-completed, non-exception Jobs on/after split_date are removed
    so the new schedule (not two schedules racing on overlapping dates) is
    the sole producer there; it immediately regenerates them under the new
    rule rather than leaving a gap until the next daily tick.
    """
    oid = resolve_org_id(org_id, db)
    old = _get_schedule_or_404(db, schedule_id, oid)

    carry_over_fields = (
        "title", "address", "frequency", "interval_weeks", "days_of_week",
        "day_of_week", "day_of_month", "start_time", "end_time",
        "cleaner_ids", "property_id", "generate_weeks_ahead", "notes",
    )
    overrides = data.model_dump(exclude_none=True, exclude={"split_date"})
    new_payload = {
        field: overrides.get(field, getattr(old, field))
        for field in carry_over_fields
    }
    if not new_payload.get("days_of_week"):
        new_payload["days_of_week"] = [new_payload.get("day_of_week", 0)]
    new_payload["day_of_week"] = new_payload["days_of_week"][0]
    new_payload["start_time"] = _as_time(new_payload["start_time"])
    new_payload["end_time"] = _as_time(new_payload["end_time"])
    _validate_timing(new_payload["start_time"], new_payload["end_time"])

    old.series_end_date = data.split_date
    new_sched = RecurringSchedule(
        client_id=old.client_id,
        job_type=old.job_type,
        active=True,
        org_id=old.org_id,
        series_start_date=data.split_date,
        **new_payload,
    )
    db.add(new_sched)
    db.flush()

    # The old schedule's own future occurrences on/after the split are now
    # the new schedule's responsibility. Exceptions are per-schedule, so any
    # deliberate deviation the user made under the OLD rule doesn't carry
    # forward onto a job the new schedule is about to (re)generate anyway.
    # Soft-cancel + detach rather than hard-delete: Activity rows FK to
    # Job.id with no ON DELETE CASCADE, so a job with any history at all
    # would 500 on delete (same reasoning as _resync_future_jobs above).
    old_exception_dates = {
        _as_date(e.exception_date)
        for e in db.query(RecurrenceException)
        .filter(RecurrenceException.recurring_schedule_id == old.id)
        .all()
    }
    stale = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == old.id,
            Job.status.notin_(("completed", "cancelled")),
            Job.scheduled_date.isnot(None),
            Job.scheduled_date >= data.split_date,
        )
        .all()
    )
    for j in stale:
        if _as_date(j.scheduled_date) in old_exception_dates:
            continue
        j.status = "cancelled"
        j.recurring_schedule_id = None
        j.notes = (j.notes or "") + "\n[Superseded by a series split]"
    db.commit()
    db.refresh(new_sched)

    jobs_created = generate_jobs(db, new_sched)
    result = sched_to_dict(new_sched)
    result["jobs_created"] = jobs_created
    result["previous_schedule_id"] = old.id
    return result


@router.delete("/{schedule_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_schedule(schedule_id: int, db: Session = Depends(get_db),
                    org_id: int = Depends(current_org_id)):
    sched = _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))
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


def _cancel_existing_job(db: Session, sched_id: int, target_date: date, reason: Optional[str]) -> None:
    """Mark any Job on (schedule_id, target_date) as cancelled so a
    skip/reschedule exception takes effect immediately without waiting for
    the next /generate-all run.

    Historically this also walked a `Visit` table, but migration 039
    removed the Visit model entirely (Job/Visit unification). The old
    `Visit.job_id` reference here was a stale NameError waiting for the
    first skip/reschedule that landed on an existing Job — audit bug.
    """
    target_date = _as_date(target_date)
    job = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched_id,
            Job.scheduled_date == target_date,
            Job.status != "completed",
        )
        .first()
    )
    if job is None:
        return
    job.status = "cancelled"
    if reason:
        job.notes = (job.notes or "") + f"\n[Skipped via exception: {reason}]"


@router.post("/{schedule_id}/skip", status_code=201, response_model=RecurrenceExceptionRead, dependencies=[Depends(require_role("admin", "manager"))])
def add_skip_exception(schedule_id: int, body: ExceptionCreate, db: Session = Depends(get_db),
                       org_id: int = Depends(current_org_id)):
    """Skip a single occurrence of a recurring schedule.

    Idempotent: if an exception already exists for this date, the existing one
    is updated (reason/type) and returned with HTTP 200 semantics surfaced via
    the response payload's ``existing`` flag.
    """
    sched = _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))

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
            org_id=sched.org_id,  # MT-2: inherit the schedule's tenant
        )
        db.add(ex)

    _cancel_existing_job(db, schedule_id, body.exception_date, body.reason)
    db.commit()
    db.refresh(ex)
    return _ex_to_dict(ex)


@router.post("/{schedule_id}/reschedule", status_code=201, response_model=RecurrenceExceptionRead, dependencies=[Depends(require_role("admin", "manager"))])
def add_reschedule_exception(schedule_id: int, body: ExceptionCreate, db: Session = Depends(get_db),
                             org_id: int = Depends(current_org_id)):
    """Reschedule a single occurrence to a different date (and optionally time).

    The original Job on the original date is cancelled, and the Job for the
    rescheduled date is materialized immediately with the exception's times so
    the calendar reflects the change instantly. Without this, the caller would
    have to wait for the next generate_jobs cycle — and even then, generate_jobs
    would create the Job with the *series* times, not the exception times,
    silently dropping any per-visit time change the user requested.
    """
    if body.rescheduled_date is None:
        raise HTTPException(
            status_code=400,
            detail="rescheduled_date is required for a reschedule exception",
        )

    sched = _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))
    # Coerce once up front — RecurrenceException.rescheduled_start_time/
    # rescheduled_end_time and Job.start_time/end_time are real Time columns;
    # body.rescheduled_start_time arrives as a plain "HH:MM" string (matching
    # this module's API convention), which Postgres's psycopg2 leniently
    # casts but SQLite's Time type rejects outright.
    body_start = _as_time(body.rescheduled_start_time)
    body_end = _as_time(body.rescheduled_end_time)
    # Validate the EFFECTIVE window — a caller changing only the start (or
    # only the end) still falls back to the series' own time for the other
    # side, exactly as the Job that gets materialized below will.
    _validate_timing(body_start or sched.start_time, body_end or sched.end_time)

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
        ex.rescheduled_start_time = body_start
        ex.rescheduled_end_time = body_end
        if body.reason:
            ex.reason = body.reason
    else:
        ex = RecurrenceException(
            recurring_schedule_id=schedule_id,
            exception_date=body.exception_date,
            exception_type="reschedule",
            rescheduled_date=body.rescheduled_date,
            rescheduled_start_time=body_start,
            rescheduled_end_time=body_end,
            reason=body.reason,
            org_id=sched.org_id,  # MT-2: inherit the schedule's tenant
        )
        db.add(ex)

    # A same-date "reschedule" (rescheduled_date == exception_date — a pure
    # time/crew change, no day move) targets the exact same Job row this
    # would otherwise cancel. Skipping the cancel there — instead of
    # cancelling then re-finding it below — matters because this Session
    # runs with autoflush=False (database/db.py): the "find the rescheduled
    # job" query a few lines down would still see the PRE-cancel database
    # row (the pending status='cancelled' isn't flushed yet), match it as
    # "existing", update its times, and then db.commit() at the end would
    # persist both the leftover cancelled status AND the new times —
    # silently cancelling a visit the user just meant to retime.
    if _as_date(body.rescheduled_date) != _as_date(body.exception_date):
        _cancel_existing_job(db, schedule_id, body.exception_date, body.reason)

    # Materialize (or update) the Job for the rescheduled date with the
    # exception times. generate_jobs uses series times only, so without this
    # step a "reschedule to 2pm" would surface as a 9am job on the calendar.
    new_date = _as_date(body.rescheduled_date)
    new_start = body_start or sched.start_time
    new_end = body_end or sched.end_time
    rescheduled_job = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == schedule_id,
            Job.scheduled_date == new_date,
            Job.status != "cancelled",
        )
        .first()
    )
    if rescheduled_job is not None:
        rescheduled_job.start_time = new_start
        rescheduled_job.end_time = new_end
        if body.cleaner_ids is not None:
            rescheduled_job.cleaner_ids = body.cleaner_ids
    else:
        rescheduled_job = Job(
            client_id=sched.client_id,
            recurring_schedule_id=sched.id,
            property_id=sched.property_id,
            job_type=sched.job_type,
            title=sched.title,
            scheduled_date=new_date,
            start_time=new_start,
            end_time=new_end,
            address=sched.address,
            cleaner_ids=(body.cleaner_ids if body.cleaner_ids is not None else (sched.cleaner_ids or [])),
            status="scheduled",
            notes=sched.notes,
            org_id=sched.org_id,  # MT-2: inherit the schedule's tenant
        )
        db.add(rescheduled_job)

    db.commit()
    db.refresh(ex)
    db.refresh(rescheduled_job)
    result = _ex_to_dict(ex)
    # So the caller (JobEditModal's "this visit only" scope) can follow up
    # with a PATCH for fields the exception model doesn't cover (title,
    # notes, address) without a separate lookup query.
    result["job_id"] = rescheduled_job.id
    return result


@router.get("/{schedule_id}/exceptions", response_model=List[RecurrenceExceptionRead])
def list_exceptions(schedule_id: int, db: Session = Depends(get_db),
                    org_id: int = Depends(current_org_id)):
    sched = _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))
    exceptions = (
        db.query(RecurrenceException)
        .filter(RecurrenceException.recurring_schedule_id == schedule_id)
        .order_by(RecurrenceException.exception_date)
        .all()
    )
    return [_ex_to_dict(e) for e in exceptions]


@router.delete("/{schedule_id}/exceptions/{exception_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_exception(schedule_id: int, exception_id: int, db: Session = Depends(get_db),
                     org_id: int = Depends(current_org_id)):
    """Undo a skip or reschedule. The next generate_jobs call will recreate
    the Job for the original date if it falls within generate_weeks_ahead.

    Note: this does NOT automatically un-cancel an already-cancelled Job/Visit
    pair — the next generate run handles that by creating a fresh Job, since
    the cancelled Job from the skip is now an unrelated historical record.
    """
    _get_schedule_or_404(db, schedule_id, resolve_org_id(org_id, db))
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
