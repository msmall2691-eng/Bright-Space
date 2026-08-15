import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, func
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
from utils.dates import business_today, coerce_date

router = APIRouter()


def _release_sync_links(db: Session, job: Job, *, notify: bool = True) -> None:
    """Delete a job's linked Google Calendar event when cancelling/detaching it
    (audit finding #2, July 2026): every recurring cancellation path below used
    to just set status='cancelled' and clear recurring_schedule_id, leaving the
    old GCal event in place — regeneration then created a NEW event for the
    same slot under the new rule, so the calendar showed both occurrences.
    Best-effort, never raises, so a sync hiccup can't block the cancellation
    itself (the reconcile sweep catches anything left over)."""
    if job.gcal_event_id:
        try:
            from integrations.google_calendar import delete_event
            from modules.settings.router import customer_notify_enabled
            # `notify=False` (an operator MOVE, per the move toggle) deletes the
            # old event SILENTLY so the customer doesn't get a jarring
            # "cancelled" email for a visit that's merely being shifted. Skips
            # and structural schedule edits keep notify=True → cancellation email
            # as before.
            _del_su = "all" if (notify and customer_notify_enabled(db)) else "none"
            if delete_event(job.gcal_event_id, job.job_type or "residential",
                            owner_account_id=getattr(job, "gcal_account_id", None),
                            send_updates=_del_su):
                job.gcal_event_id = None
        except Exception as e:
            logger.warning(f"GCal delete failed for job {job.id}: {e}")


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
    # "Ends" (Google-Calendar-style): 'never' | 'on_date' | 'after_count'.
    # Omitted/None on create means "never" (the historical default — every
    # schedule before this feature ran open-ended). ends_on is the INCLUSIVE
    # last occurrence date (the user-facing convention); the endpoint converts
    # it to series_end_date's exclusive-boundary storage internally.
    ends_mode: Optional[str] = None
    ends_on: Optional[str] = None
    ends_after_count: Optional[int] = None
    # Override the similar-series pre-create guard (services/recurring_guards).
    # Mirrors scheduling's allow_conflicts escape hatch: the default (False)
    # is the SAFE value — a create that matches an existing live series 409s
    # with the matches so the operator confirms before a second series exists.
    allow_duplicate: Optional[bool] = False


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
    # Override the double-booking / time-off conflict guard when rescheduling a
    # single occurrence onto a slot the cleaner is already on (the "Reschedule
    # anyway" escape hatch, mirroring the one-time job PATCH). Defaults to the
    # SAFE value — the interactive reschedule is conflict-checked unless the
    # operator explicitly overrides.
    allow_conflicts: Optional[bool] = False
    # Per-move notification override from the JobEditModal "Notify customer of
    # this change" checkbox (parity with the one-time JobUpdate.notify_customer).
    # None → fall back to the Settings "email on move" default; True/False forces
    # this move's customer email on/off. Ignored by /skip.
    notify_customer: Optional[bool] = None


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
    # "Ends" (see ScheduleCreate) — omitted entirely means "don't touch the
    # existing end setting" (this is a PATCH); the frontend always sends all
    # three together whenever the Ends section is present in the save, so
    # `ends_mode`'s presence is the signal to apply this block at all.
    ends_mode: Optional[str] = None
    ends_on: Optional[str] = None
    ends_after_count: Optional[int] = None
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
        "anchor_date": s.anchor_date.isoformat() if s.anchor_date else None,
        "series_end_occurrences": s.series_end_occurrences,
        # Frontend-friendly "Ends" summary so Recurring.jsx doesn't have to
        # re-derive the exclusive/inclusive date-math itself: ends_on is the
        # INCLUSIVE last occurrence (series_end_date minus a day), and
        # ends_mode tells the edit form which radio to pre-select.
        "ends_on": (s.series_end_date - timedelta(days=1)).isoformat() if s.series_end_date else None,
        "ends_mode": (
            "after_count" if s.series_end_occurrences else
            "on_date" if s.series_end_date else
            "never"
        ),
        "notes": s.notes,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _as_date(value):
    """Coerce a value (ISO string, date, or None) to a date | None, so the
    recurrence date math works in pure date objects regardless of whether a
    column came back as a date (Postgres) or a string.

    Delegates to the shared utils.dates.coerce_date (which also normalizes a
    datetime to a date — a datetime never compares equal to a date, which would
    silently break the rule-date membership checks)."""
    return coerce_date(value)


def _as_time(value):
    """Coerce a value (ISO/HH:MM string, time, or None) to a time | None.

    Delegates to the shared utils.dates.coerce_time so this router parses times
    exactly like the scheduling router — previously this used
    time.fromisoformat, which rejects a non-zero-padded '9:30', so the same
    payload wrote a valid time on the scheduling router but NULL here."""
    from utils.dates import coerce_time
    return coerce_time(value)


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


def _week_monday(d: date) -> date:
    """The Monday that starts d's ISO week — the unit we count cadence in."""
    return d - timedelta(days=d.weekday())


def _phase_anchor(sched: RecurringSchedule, today: date, days: List[int]) -> date:
    """Fixed phase reference for weekly/biweekly/every-N-week expansion.

    The bug this fixes: the old weekly branch started each chosen weekday at the
    first matching day on/after ``today`` and stepped by ``interval_weeks``.
    Because ``today`` moves forward and the daily generation tick re-runs, the
    on-week/off-week phase re-seated itself every day, so a biweekly series kept
    filling in its off-weeks and collapsed to weekly.

    We now count week-parity relative to a stable anchor instead:
      * ``anchor_date`` — the persisted first-occurrence phase (set on create
        and by generate_jobs, backfilled by migration 060); authoritative when
        present.
      * else ``series_start_date`` — a split recorded the intended start.
      * else the series' first upcoming occurrence from ``today`` — correct for
        a brand-new series before its anchor is persisted (generate_jobs pins it
        immediately after, so subsequent ticks use the stored value).
    """
    anchor = _as_date(getattr(sched, "anchor_date", None))
    if anchor is None:
        anchor = _as_date(getattr(sched, "series_start_date", None))
    if anchor is None and days:
        anchor = min(today + timedelta(days=(dow - today.weekday()) % 7) for dow in days)
    return anchor if anchor is not None else today


def _daily_anchor(sched: RecurringSchedule, today: date) -> date:
    """Phase reference for 'every N days' — same drift problem, same fix.
    Falls back to today so 'every day' (step 1) is unaffected."""
    anchor = _as_date(getattr(sched, "anchor_date", None))
    if anchor is None:
        anchor = _as_date(getattr(sched, "series_start_date", None))
    return anchor if anchor is not None else today


def _occurs_on(sched: RecurringSchedule, d: date, today: date) -> bool:
    """THE single source of truth for "does this schedule's rule fall on date d?"

    ``today`` is the reference used ONLY for the phase-anchor fallback — i.e. a
    brand-new series with no persisted anchor_date/series_start_date; when either
    is set it's ignored. Every expansion below (generate_dates,
    _nth_occurrence_date, _is_on_phase) is built on this one predicate, so the
    three can no longer drift — a cadence fix lands once, here. (They were three
    hand-copied branch ladders before; the biweekly-anchor bug had to be patched
    in each.)"""
    if sched.frequency == "monthly":
        # No clamping: a month without day `dom` (e.g. Feb 30) simply has no
        # occurrence, matching the old generator's date()-ValueError skip.
        return d.day == (sched.day_of_month or 1)
    interval = max(1, sched.interval_weeks or 1)
    if sched.frequency == "daily":
        # interval_weeks is reused as the day step; empty days_of_week = every day.
        chosen = set(_effective_days(sched)) if sched.days_of_week else None
        if (d - _daily_anchor(sched, today)).days % interval != 0:
            return False
        return chosen is None or d.weekday() in chosen
    # weekly / biweekly / every-N-week
    days = _effective_days(sched)
    if d.weekday() not in days:
        return False
    ref_monday = _week_monday(_phase_anchor(sched, today, days))
    return ((_week_monday(d) - ref_monday).days // 7) % interval == 0


def _iter_occurrences(sched: RecurringSchedule, start: date, until: date, today: date):
    """Yield each rule occurrence date d with start <= d <= until, ascending.

    A day-by-day walk over the single _occurs_on predicate. The ranges here are
    tiny — a few months for generation, and the Nth-occurrence walk is bounded
    by a count — so the simplicity of one predicate is worth more than a
    per-frequency stride. Ascending + inherently unique (one yield per date)."""
    d = start
    one = timedelta(days=1)
    while d <= until:
        if _occurs_on(sched, d, today):
            yield d
        d += one


def _is_on_phase(sched: RecurringSchedule, d: date) -> bool:
    """Would this schedule's rule produce date ``d``? Classifies a single date
    by cadence phase directly (no date-window), so it stays correct for dates
    beyond generate_weeks_ahead. Used by the off-cadence cleanup to tell a
    biweekly-drift leftover from a legitimate occurrence. Thin wrapper over the
    shared _occurs_on predicate."""
    return _occurs_on(sched, d, business_today())


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
    # One walk over the shared occurrence predicate (see _occurs_on) instead of
    # three hand-copied per-frequency branches. `today` (possibly floored to
    # series_start above) is both the range start and the anchor-fallback ref.
    return list(_iter_occurrences(sched, today, end, today))


def _nth_occurrence_date(sched: RecurringSchedule, n: int) -> Optional[date]:
    """Date of the Nth occurrence (1-indexed) this schedule's rule would
    produce, counting from series_start_date (if set and later) or today —
    the same expansion generate_dates() does, bounded by a COUNT instead of
    a date window. Used to translate the "ends after N occurrences" UI
    choice into series_end_date, the single column generate_dates() actually
    enforces. Returns None if the rule can't produce N occurrences within a
    10-year safety cap (e.g. days_of_week somehow empty).

    The count origin is the series' pinned start — anchor_date (set at first
    materialization) or series_start_date — NOT today. "Ends after N
    occurrences" means the Nth occurrence of the series as a whole, a stable
    date. Counting from a moving `today` recomputed a LATER end date on every
    save (the edit form re-sends the Ends fields each time), silently
    extending a paid, count-limited series well past N visits. Only a
    brand-new series with neither anchor nor start falls back to today."""
    origin = (
        _as_date(getattr(sched, "anchor_date", None))
        or _as_date(getattr(sched, "series_start_date", None))
        or business_today()
    )
    until = origin + timedelta(days=365 * 10)  # safety cap → guarantees termination
    # The SAME shared predicate generate_dates walks, counted from the pinned
    # origin instead of bounded by a date window — so "ends after N" lands on
    # exactly the dates generation will materialize. (origin doubles as the
    # anchor-fallback ref, matching the pre-refactor behavior.)
    count = 0
    for d in _iter_occurrences(sched, origin, until, origin):
        count += 1
        if count == n:
            return d
    return None


def _apply_ends_fields(sched: RecurringSchedule, updates: dict) -> None:
    """Pop ends_mode/ends_on/ends_after_count out of `updates` (they aren't
    real RecurringSchedule columns) and translate them onto
    series_end_date/series_end_occurrences. Call AFTER every other field has
    already been applied to `sched` — an occurrence count must be computed
    against the schedule's (possibly just-edited) frequency/days/interval,
    not stale prior values.

    No-ops when `ends_mode` isn't present at all, so a caller that doesn't
    touch "Ends" (e.g. an update that's just renaming the schedule) leaves
    the existing end setting untouched.
    """
    if "ends_mode" not in updates:
        return
    mode = updates.pop("ends_mode")
    ends_on_raw = updates.pop("ends_on", None)
    ends_count_raw = updates.pop("ends_after_count", None)

    if mode == "never" or mode is None:
        sched.series_end_date = None
        sched.series_end_occurrences = None
    elif mode == "on_date":
        d = _as_date(ends_on_raw)
        if d is None:
            raise HTTPException(status_code=400, detail="ends_on is required when ends_mode='on_date'")
        # series_end_date is an EXCLUSIVE boundary; ends_on is the user-facing
        # INCLUSIVE last occurrence, so the stored value is one day later.
        sched.series_end_date = d + timedelta(days=1)
        sched.series_end_occurrences = None
    elif mode == "after_count":
        try:
            n = int(ends_count_raw)
        except (TypeError, ValueError):
            n = None
        if not n or n < 1:
            raise HTTPException(status_code=400, detail="ends_after_count must be a positive integer when ends_mode='after_count'")
        nth = _nth_occurrence_date(sched, n)
        if nth is None:
            raise HTTPException(status_code=400, detail="Could not compute an end date for that many occurrences — check the schedule's days/frequency")
        sched.series_end_date = nth + timedelta(days=1)
        sched.series_end_occurrences = n
    else:
        raise HTTPException(status_code=400, detail=f"Invalid ends_mode: {mode!r} (expected 'never', 'on_date', or 'after_count')")


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


def _ensure_anchor(db: Session, sched: RecurringSchedule) -> None:
    """Pin the series' cadence phase the first time it materializes jobs, so
    every later daily tick reads a stored anchor instead of re-deriving one from
    the moving ``today`` (the biweekly-drift bug). No-op once anchor_date is set
    (including rows the migration already backfilled). Prefers, in order:
    series_start_date → earliest existing Job → the rule's first upcoming
    occurrence from today. Flushes but does not commit — the caller owns the
    transaction."""
    if _as_date(getattr(sched, "anchor_date", None)) is not None:
        return
    anchor = _as_date(getattr(sched, "series_start_date", None))
    if anchor is None:
        earliest = (
            db.query(func.min(Job.scheduled_date))
            .filter(Job.recurring_schedule_id == sched.id, Job.scheduled_date.isnot(None))
            .scalar()
        )
        anchor = _as_date(earliest)
    if anchor is None:
        today = business_today()
        days = _effective_days(sched)
        if sched.frequency == "monthly":
            anchor = today
        elif days:
            anchor = min(today + timedelta(days=(dow - today.weekday()) % 7) for dow in days)
        else:
            anchor = today
    sched.anchor_date = anchor
    db.flush()


def generate_jobs(db: Session, sched: RecurringSchedule) -> int:
    """Create Job records for schedule dates that don't already have one.
    Returns count created."""
    from database.models import Client
    from integrations.google_calendar import create_event

    # Pin the cadence phase before expanding dates so biweekly stays biweekly.
    _ensure_anchor(db, sched)

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

    # Availability guards — mirror the one-off create path (create_job) so a
    # recurring occurrence never SILENTLY double-books a cleaner, books someone
    # on approved time off, or blows past the daily cap. Reuses the scheduling
    # helpers (one source of truth for "is this cleaner free"), imported at call
    # time to avoid an import cycle between the two routers. Canonical logic —
    # no projection/inbox touched, no new tick (scheduling-invariants R1/R2).
    from modules.scheduling.router import (
        _find_cleaner_conflicts, _find_unavailable_cleaners, _find_over_capacity,
    )

    def _available_cleaners(d):
        """The schedule's crew minus anyone busy / off / over-cap on date d.
        We DROP the conflicting cleaner rather than skip the cleaning (R7: never
        silently lose canonical work) — the occurrence is still created, just
        unassigned/partially-assigned so it surfaces on the board for a human to
        reassign, instead of a hidden conflict pushed to the cleaner's app."""
        crew = [str(c) for c in (sched.cleaner_ids or [])]
        if not crew:
            return []
        blocked = set()
        for cid, _ in _find_cleaner_conflicts(db, cleaner_ids=crew, scheduled_date=d,
                                              start_time=sched.start_time,
                                              end_time=sched.end_time, org_id=sched.org_id):
            blocked.add(str(cid))
        for cid, _ in _find_unavailable_cleaners(db, cleaner_ids=crew,
                                                 scheduled_date=d, org_id=sched.org_id):
            blocked.add(str(cid))
        for cid, _ in _find_over_capacity(db, cleaner_ids=crew,
                                          scheduled_date=d, org_id=sched.org_id):
            blocked.add(str(cid))
        if blocked:
            kept = [c for c in crew if c not in blocked]
            logger.info(
                f"[recurring] schedule {sched.id} on {d}: dropped busy/off/over-cap "
                f"cleaner(s) {sorted(blocked)} → occurrence created "
                f"{'unassigned' if not kept else 'with ' + str(kept)} for reassignment"
            )
            return kept
        return crew

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
            cleaner_ids=_available_cleaners(d),
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
        from modules.settings.router import (
            customer_invites_enabled, customer_notify_enabled, gcal_reminder_overrides,
        )
        client = db.query(Client).filter(Client.id == sched.client_id).first()
        client_dict = {"id": client.id if client else None, "name": client.name if client else "", "email": getattr(client, "email", None)}
        invite = customer_invites_enabled(db) and bool(client and client.email)
        _rec_su = "all" if (invite and customer_notify_enabled(db)) else "none"
        _rec_reminders = gcal_reminder_overrides(db)
        for job in new_jobs:
            db.refresh(job)
            job_dict = {
                "id": job.id, "title": job.title, "job_type": job.job_type or "residential",
                "scheduled_date": job.scheduled_date, "start_time": job.start_time,
                "end_time": job.end_time, "address": job.address, "notes": job.notes,
            }
            try:
                event_id = create_event(job_dict, client_dict, send_invite=invite,
                                        reminders=_rec_reminders, send_updates=_rec_su)
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

    # Connecteam removal (step 3): newly-generated occurrences are no longer
    # dispatched (inline or via the outbox) to Connecteam — the crew sees them
    # on their native My Day schedule as soon as they're assigned. Google
    # Calendar sync for these jobs is untouched.

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
    # user guessing whether anything actually got generated. One grouped query
    # instead of a COUNT per schedule (the old N+1 added a DB round-trip per row
    # — slow enough to time the page out on a cold connection with many series).
    today = business_today().isoformat()
    sched_ids = [s.id for s in schedules]
    counts = {}
    if sched_ids:
        rows = (
            db.query(Job.recurring_schedule_id, func.count(Job.id))
            .filter(
                Job.recurring_schedule_id.in_(sched_ids),
                Job.status != "cancelled",
                or_(Job.scheduled_date == None, Job.scheduled_date >= today),
            )
            .group_by(Job.recurring_schedule_id)
            .all()
        )
        counts = {sid: c for sid, c in rows}
    out = []
    for s in schedules:
        d = sched_to_dict(s)
        d["upcoming_job_count"] = counts.get(s.id, 0)
        out.append(d)
    return out


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_schedule(data: ScheduleCreate, db: Session = Depends(get_db),
                    org_id: int = Depends(current_org_id)):
    payload = data.model_dump()
    # ends_mode/ends_on/ends_after_count aren't real RecurringSchedule
    # columns — pulled out and applied via _apply_ends_fields below, once
    # the schedule (and its frequency/days/interval) actually exists.
    ends_fields = {
        "ends_mode": payload.pop("ends_mode"),
        "ends_on": payload.pop("ends_on"),
        "ends_after_count": payload.pop("ends_after_count"),
    }
    # Request-only guard override (see ScheduleCreate), not a column.
    allow_duplicate = payload.pop("allow_duplicate", False)
    oid = resolve_org_id(org_id, db)
    # Normalise days_of_week. For a DAILY schedule an empty set means "every
    # day" — generate_dates treats a falsy days_of_week as no weekday filter —
    # so leave it empty rather than collapsing it to a single day, which
    # silently turned a "daily, every day" schedule into "Mondays only".
    # Weekly/monthly with no set fall back to the legacy day_of_week column.
    if not payload.get("days_of_week"):
        payload["days_of_week"] = [] if payload.get("frequency") == "daily" \
            else [payload.get("day_of_week", 0)]
    # Keep day_of_week in sync with the first chosen day for legacy compat;
    # leave it as-is for an every-day daily schedule (no weekday filter).
    if payload.get("days_of_week"):
        payload["day_of_week"] = payload["days_of_week"][0]
    # SQLite's Time column rejects raw strings outright (Postgres casts them
    # leniently) — coerce here the same way update_schedule already does.
    payload["start_time"] = _as_time(payload["start_time"])
    payload["end_time"] = _as_time(payload["end_time"])
    # Similar-series pre-create guard (data-model review, guard 1). Runs
    # AFTER the day/time normalization above so it compares what would
    # actually be stored. Overridable: resubmit with allow_duplicate=true
    # (mirrors scheduling's allow_conflicts 409 escape-hatch convention).
    if not allow_duplicate:
        from services.recurring_guards import find_similar_series
        similar = find_similar_series(db, oid, payload)
        if similar:
            raise HTTPException(
                status_code=409,
                detail={"detail": "similar_series_exists", "matches": similar},
            )
    sched = RecurringSchedule(**payload)
    sched.org_id = oid  # MT-2: stamp the caller's workspace
    _apply_ends_fields(sched, ends_fields)
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
        if q:
            # Carry the deal link onto the schedule so a won, recurring deal
            # shows its cadence on the board (P4). Advance the opp to "won" to
            # match quoting.convert_quote_to_job — setting up recurring from an
            # accepted quote is a won deal just like converting it to a one-off.
            if q.opportunity_id and not sched.opportunity_id:
                sched.opportunity_id = q.opportunity_id
                from utils.opportunity_helper import advance_for_quote
                advance_for_quote(db, q, "won")
            if q.status != "converted":
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
    # A per-occurrence exception marks a date the user deliberately deviated
    # from the rule — leave it untouched. That means protecting BOTH the
    # original date (a skip) AND the rescheduled_date (a move): the moved job
    # carries the user's per-visit time/crew override, which regenerating from
    # the rule would silently reset to series defaults. Protecting only
    # exception_date wiped every deliberately-rescheduled visit on resync.
    protected_dates = set()
    for e in (
        db.query(RecurrenceException)
        .filter(RecurrenceException.recurring_schedule_id == sched.id)
        .all()
    ):
        ed = _as_date(e.exception_date)
        if ed:
            protected_dates.add(ed)
        if e.exception_type == "reschedule" and e.rescheduled_date:
            rd = _as_date(e.rescheduled_date)
            if rd:
                protected_dates.add(rd)
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
        if _as_date(j.scheduled_date) in protected_dates:
            continue
        j.status = "cancelled"
        j.recurring_schedule_id = None
        j.notes = (j.notes or "") + "\n[Superseded by an updated recurring schedule]"
        _release_sync_links(db, j)
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
    # ends_mode's presence is the signal the frontend actually touched the
    # "Ends" section this save (see _apply_ends_fields) — pulled out before
    # the generic setattr loop below since these aren't real columns, and
    # applied afterward so an occurrence count reflects any frequency/day
    # changes from the SAME request.
    ends_fields = {}
    if "ends_mode" in updates:
        ends_fields["ends_mode"] = updates.pop("ends_mode")
        ends_fields["ends_on"] = updates.pop("ends_on", None)
        ends_fields["ends_after_count"] = updates.pop("ends_after_count", None)
    # Phase 0 fix: an empty days_of_week list would silently collapse a
    # multi-day WEEKLY schedule. Reject it explicitly rather than dropping
    # days — but for a DAILY schedule an empty set legitimately means "every
    # day", so allow it there (matches create_schedule's normalization).
    eff_frequency = updates.get("frequency", sched.frequency)
    if "days_of_week" in updates and not updates["days_of_week"] and eff_frequency != "daily":
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
    _apply_ends_fields(sched, ends_fields)
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


def _off_phase_future_jobs(db: Session, sched: RecurringSchedule) -> List[Job]:
    """Future, non-terminal Jobs on this series that fell on an OFF cadence week
    (or day) — the leftovers the pre-fix biweekly drift created. Deliberately
    conservative:
      * only frequencies the bug could hit (biweekly/every-N-week, every-N-day);
        weekly and monthly have no off-weeks so are never touched;
      * only future jobs (>= today) — never rewrites history or completed work;
      * only jobs on a legitimately-scheduled weekday that landed on the wrong
        cadence week — anything on an unscheduled day is likely a manual edit
        and is left alone;
      * intentional reschedule targets are always kept.
    """
    interval = max(1, sched.interval_weeks or 1)
    freq = sched.frequency
    if freq == "monthly":
        return []
    if freq != "daily" and interval <= 1:
        return []  # plain weekly — no off-weeks to clean
    if freq == "daily" and interval <= 1:
        return []  # every day — no off-days
    today = business_today()
    resched_targets = {
        _as_date(e.rescheduled_date)
        for e in db.query(RecurrenceException).filter(
            RecurrenceException.recurring_schedule_id == sched.id,
            RecurrenceException.exception_type == "reschedule",
            RecurrenceException.rescheduled_date.isnot(None),
        ).all()
    }
    days = set(_effective_days(sched))
    jobs = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched.id,
            Job.status.notin_(("completed", "cancelled")),
            Job.scheduled_date.isnot(None),
            Job.scheduled_date >= today,
        )
        .order_by(Job.scheduled_date.asc())
        .all()
    )
    out = []
    for j in jobs:
        d = _as_date(j.scheduled_date)
        if d is None or d in resched_targets:
            continue
        # Must be on a slot the rule actually schedules (right weekday/day),
        # just on an off cadence week — that's the drift signature.
        if freq == "daily":
            if sched.days_of_week and d.weekday() not in days:
                continue
        elif d.weekday() not in days:
            continue
        if not _is_on_phase(sched, d):
            out.append(j)
    return out


@router.get("/cleanup/off-phase-preview", dependencies=[Depends(require_role("admin", "manager"))])
def preview_off_phase_cleanup(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Dry-run: list the off-cadence duplicate visits the pre-fix biweekly drift
    left behind, WITHOUT changing anything. Review this before calling apply."""
    oid = resolve_org_id(org_id, db)
    schedules = db.query(RecurringSchedule).filter(
        RecurringSchedule.active == True,
        or_(RecurringSchedule.org_id == oid, RecurringSchedule.org_id.is_(None)),
    ).all()
    candidates = []
    for s in schedules:
        for j in _off_phase_future_jobs(db, s):
            candidates.append({
                "job_id": j.id,
                "schedule_id": s.id,
                "title": s.title,
                "address": s.address,
                "scheduled_date": _as_date(j.scheduled_date).isoformat(),
                "start_time": str(j.start_time) if j.start_time else None,
                "frequency": s.frequency,
                "interval_weeks": s.interval_weeks,
            })
    candidates.sort(key=lambda c: (c["scheduled_date"], c["schedule_id"]))
    return {"count": len(candidates), "candidates": candidates}


class OffPhaseCleanupApply(BaseModel):
    # Explicit allowlist of job ids to cancel; omit/null to cancel every
    # currently-detected off-phase job. Either way the server re-derives the
    # off-phase set and only ever cancels jobs still in it, so a stale or
    # hand-crafted id list can never cancel a legitimate visit.
    job_ids: Optional[List[int]] = None


@router.post("/cleanup/off-phase-apply", dependencies=[Depends(require_role("admin", "manager"))])
def apply_off_phase_cleanup(body: OffPhaseCleanupApply, db: Session = Depends(get_db),
                            org_id: int = Depends(current_org_id)):
    """Cancel the off-cadence duplicate visits. Soft-cancel (status=cancelled)
    matching every other recurring-cancellation path here, releasing the linked
    Google Calendar event + Connecteam shift. Keeps recurring_schedule_id so
    generate_jobs' cancelled-date guard won't recreate them."""
    oid = resolve_org_id(org_id, db)
    schedules = db.query(RecurringSchedule).filter(
        RecurringSchedule.active == True,
        or_(RecurringSchedule.org_id == oid, RecurringSchedule.org_id.is_(None)),
    ).all()
    requested = set(body.job_ids) if body.job_ids is not None else None
    cancelled = []
    for s in schedules:
        for j in _off_phase_future_jobs(db, s):
            if requested is not None and j.id not in requested:
                continue
            j.status = "cancelled"
            j.notes = (j.notes or "") + "\n[Removed off-cadence duplicate — biweekly drift cleanup]"
            _release_sync_links(db, j)
            cancelled.append(j.id)
    if cancelled:
        db.commit()
    return {"cancelled_count": len(cancelled), "cancelled_job_ids": cancelled}


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
        # Lineage (data-model review, guard 4): the successor keeps the
        # predecessor's quote/opportunity links. carry_over_fields omitted
        # them, so every split silently severed deal-board traceability —
        # the won deal's cadence pointed only at the retired series.
        quote_id=old.quote_id,
        opportunity_id=old.opportunity_id,
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
        _release_sync_links(db, j)
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


def _cancel_existing_job(db: Session, sched_id: int, target_date: date, reason: Optional[str],
                         *, notify: bool = True) -> None:
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
    # Detach from the schedule so the cancelled row leaves BOTH generate_jobs'
    # cancelled-dates guard and the uq_jobs_schedule_date unique index (which
    # is partial on `recurring_schedule_id IS NOT NULL` and has no status
    # filter). Without this: undoing a skip could never recreate the visit —
    # the date stayed permanently blocked, contradicting delete_exception's
    # contract — and rescheduling another occurrence onto a previously-skipped
    # date collided with this inert row and 500'd at commit. Matches the
    # detach convention _resync_future_jobs and split_schedule already use.
    job.recurring_schedule_id = None
    _release_sync_links(db, job, notify=notify)


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
    # If we're converting a prior RESCHEDULE into a skip, the moved visit was
    # already materialized on the old rescheduled_date. Capture it before we
    # clear the field so we can cancel that job too — otherwise the "skipped"
    # occurrence stays live on its moved date and a cleaner is still dispatched
    # to a visit the operator believes was skipped.
    prior_moved_date = None
    if existing and existing.exception_type == "reschedule" and existing.rescheduled_date:
        prior_moved_date = _as_date(existing.rescheduled_date)

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
    if prior_moved_date and prior_moved_date != _as_date(body.exception_date):
        _cancel_existing_job(db, schedule_id, prior_moved_date, body.reason)
    db.commit()
    db.refresh(ex)
    return _ex_to_dict(ex)


def _reschedule_occurrence(db: Session, sched: RecurringSchedule, exception_date, rescheduled_date,
                           rescheduled_start_time=None, rescheduled_end_time=None,
                           cleaner_ids=None, reason=None, allow_conflicts=True,
                           notify_customer: bool = True):
    """Core "move this one occurrence" logic — writes/updates the
    RecurrenceException and materializes the Job for the new date, exactly
    as the /{schedule_id}/reschedule endpoint does. Factored out so bulk
    callers (jobs/bulk-reschedule) get the same recurring-aware behavior
    instead of a bare scheduled_date PATCH that generate_jobs would later
    duplicate/resurrect (the same bug class Fix 1 closed for the single-job
    path). Returns (exception, job).
    """
    exception_date = _as_date(exception_date)
    rescheduled_date = _as_date(rescheduled_date)
    body_start = _as_time(rescheduled_start_time)
    body_end = _as_time(rescheduled_end_time)
    _validate_timing(body_start or sched.start_time, body_end or sched.end_time)

    # Conflict guard (Codex P1): dragging a recurring occurrence used to route
    # through here with NO double-booking / time-off check, unlike the one-time
    # job PATCH. Run the SAME check the scheduling router applies, on the new
    # date/time with the occurrence's effective crew — unless the caller
    # explicitly overrides (the "Reschedule anyway" path). Bulk callers keep the
    # permissive default; only the interactive endpoint opts in. Runs BEFORE any
    # mutation so a 409 leaves nothing partially written.
    if not allow_conflicts:
        eff_cleaners = cleaner_ids if cleaner_ids is not None else (sched.cleaner_ids or [])
        if eff_cleaners:
            from modules.scheduling.router import (
                _find_cleaner_conflicts, _conflict_detail,
                _find_unavailable_cleaners, _unavailable_detail,
            )
            chk_start = body_start or sched.start_time
            chk_end = body_end or sched.end_time
            # Exclude this occurrence's own materialized Job (a same-day retime
            # would otherwise conflict with itself).
            self_job = (
                db.query(Job)
                .filter(Job.recurring_schedule_id == sched.id,
                        Job.scheduled_date == rescheduled_date,
                        Job.status != "cancelled")
                .first()
            )
            conflicts = _find_cleaner_conflicts(
                db, cleaner_ids=eff_cleaners, scheduled_date=rescheduled_date,
                start_time=chk_start, end_time=chk_end,
                exclude_job_id=(self_job.id if self_job else None), org_id=sched.org_id,
            )
            if conflicts:
                raise HTTPException(status_code=409, detail=_conflict_detail(conflicts))
            unavailable = _find_unavailable_cleaners(
                db, cleaner_ids=eff_cleaners, scheduled_date=rescheduled_date, org_id=sched.org_id,
            )
            if unavailable:
                raise HTTPException(status_code=409, detail=_unavailable_detail(unavailable))

    existing = (
        db.query(RecurrenceException)
        .filter(
            RecurrenceException.recurring_schedule_id == sched.id,
            RecurrenceException.exception_date == exception_date,
        )
        .first()
    )
    if existing:
        ex = existing
        ex.exception_type = "reschedule"
        ex.rescheduled_date = rescheduled_date
        ex.rescheduled_start_time = body_start
        ex.rescheduled_end_time = body_end
        if reason:
            ex.reason = reason
    else:
        ex = RecurrenceException(
            recurring_schedule_id=sched.id,
            exception_date=exception_date,
            exception_type="reschedule",
            rescheduled_date=rescheduled_date,
            rescheduled_start_time=body_start,
            rescheduled_end_time=body_end,
            reason=reason,
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
    # Capture the customer link off the occurrence we're about to move, so it
    # follows the visit to its new date instead of dying on the cancelled row.
    # (Without this, a recurring reschedule broke the customer's confirm/manage
    # link — it still resolved to the old, now-cancelled Job.)
    old_occurrence = (
        db.query(Job)
        .filter(Job.recurring_schedule_id == sched.id,
                Job.scheduled_date == exception_date,
                Job.status != "cancelled")
        .first()
    )
    carried_token = old_occurrence.public_token if old_occurrence else None
    # Carry the Google Calendar event to the moved occurrence instead of
    # deleting + re-creating it. Reusing the same event id means ONE silent
    # in-place update on the customer's calendar (no "cancelled" email, no
    # re-invite, no orphan window, no reconcile round-trip) — the 100%-silent
    # recurring move. Captured BEFORE the cancel below, which would otherwise
    # delete it.
    carried_event_id = old_occurrence.gcal_event_id if old_occurrence else None
    carried_acct = getattr(old_occurrence, "gcal_account_id", None) if old_occurrence else None

    if rescheduled_date != exception_date:
        if old_occurrence is not None:
            old_occurrence.public_token = None  # freed for the new row below
            # Detach the calendar event from the old row BEFORE the cancel so
            # _release_sync_links doesn't delete it — we re-point it at the moved
            # occurrence and update it in place below (one silent event move,
            # not a delete + re-create). If there's no carried event, this is a
            # no-op and the cancel behaves exactly as before.
            if carried_event_id:
                old_occurrence.gcal_event_id = None
        _cancel_existing_job(db, sched.id, exception_date, reason, notify=notify_customer)

    # Materialize (or update) the Job for the rescheduled date with the
    # exception times. generate_jobs uses series times only, so without this
    # step a "reschedule to 2pm" would surface as a 9am job on the calendar.
    new_start = body_start or sched.start_time
    new_end = body_end or sched.end_time
    rescheduled_job = (
        db.query(Job)
        .filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date == rescheduled_date,
            Job.status != "cancelled",
        )
        .first()
    )
    if rescheduled_job is None:
        # A directly-cancelled occurrence (cancelled via the job path, which
        # keeps recurring_schedule_id) may still hold this (schedule, date)
        # slot in the status-blind uq_jobs_schedule_date unique index. Revive
        # that row instead of inserting a second one that would collide and
        # 500 at commit. (Skip-cancelled rows are detached, so they don't
        # match here and a fresh insert is safe.)
        cancelled_here = (
            db.query(Job)
            .filter(
                Job.recurring_schedule_id == sched.id,
                Job.scheduled_date == rescheduled_date,
                Job.status == "cancelled",
            )
            .first()
        )
        if cancelled_here is not None:
            cancelled_here.status = "scheduled"
            rescheduled_job = cancelled_here
    if rescheduled_job is not None:
        rescheduled_job.start_time = new_start
        rescheduled_job.end_time = new_end
        if cleaner_ids is not None:
            rescheduled_job.cleaner_ids = cleaner_ids
    else:
        rescheduled_job = Job(
            client_id=sched.client_id,
            recurring_schedule_id=sched.id,
            property_id=sched.property_id,
            job_type=sched.job_type,
            title=sched.title,
            scheduled_date=rescheduled_date,
            start_time=new_start,
            end_time=new_end,
            address=sched.address,
            cleaner_ids=(cleaner_ids if cleaner_ids is not None else (sched.cleaner_ids or [])),
            status="scheduled",
            notes=sched.notes,
            org_id=sched.org_id,  # MT-2: inherit the schedule's tenant
        )
        db.add(rescheduled_job)

    # Carry the customer's confirm/manage link onto the moved visit, and reset
    # the flags the old time carried: a moved visit is no longer "confirmed"
    # (they agreed to a different time) and deserves a fresh reminder. For a
    # same-date time change the token already lives on this row.
    if carried_token and not rescheduled_job.public_token:
        rescheduled_job.public_token = carried_token
    rescheduled_job.customer_confirmed_at = None
    if getattr(rescheduled_job, "sms_reminder_sent", False):
        rescheduled_job.sms_reminder_sent = False

    # ── SILENT IN-PLACE CALENDAR MOVE ──
    # Re-point the carried event at the moved occurrence and update it in place,
    # so the visit slides to its new date/time on the customer's calendar with
    # a single API call. send_updates follows notify_customer: an operator move
    # (toggle off) is 100% silent; a customer self-move still confirms. On a
    # same-date time change the row already owns the event, so this also keeps
    # the calendar time accurate without a delete/recreate. Best-effort: any
    # failure drops the (now-stale) link so the reconcile sweep re-creates the
    # event on the new date — DB and calendar never silently diverge.
    if carried_event_id and not rescheduled_job.gcal_event_id:
        rescheduled_job.gcal_event_id = carried_event_id
        rescheduled_job.gcal_account_id = carried_acct
    if rescheduled_job.gcal_event_id:
        try:
            from integrations.google_calendar import update_event, delete_event, is_configured
            from modules.settings.router import customer_invites_enabled, gcal_reminder_overrides
            from database.models import Client
            if is_configured():
                db.flush()  # ensure a freshly-created Job has its id for the event link
                client = db.query(Client).filter(Client.id == sched.client_id).first()
                invite = customer_invites_enabled(db) and bool(client and client.email)
                client_dict = {"id": client.id if client else None,
                               "name": client.name if client else "",
                               "email": getattr(client, "email", None)}
                job_dict = {
                    "id": rescheduled_job.id, "title": rescheduled_job.title,
                    "job_type": rescheduled_job.job_type or "residential",
                    "scheduled_date": rescheduled_date, "start_time": new_start,
                    "end_time": new_end, "address": rescheduled_job.address,
                    "notes": rescheduled_job.notes, "property_id": rescheduled_job.property_id,
                }
                event_id = rescheduled_job.gcal_event_id
                moved_ok = update_event(
                    event_id, job_dict, client_dict, send_invite=invite,
                    reminders=gcal_reminder_overrides(db),
                    send_updates=("all" if notify_customer else "none"),
                    owner_account_id=rescheduled_job.gcal_account_id)
                if not moved_ok:
                    # Update didn't apply (Google down / rejected). Drop the stale
                    # link so reconcile re-creates on the new date, and best-effort
                    # delete the orphan at the old date (silently — no email).
                    try:
                        delete_event(event_id, rescheduled_job.job_type or "residential",
                                     owner_account_id=rescheduled_job.gcal_account_id,
                                     send_updates="none")
                    except Exception:
                        pass
                    rescheduled_job.gcal_event_id = None
        except Exception as e:
            logger.warning(f"GCal in-place move failed for schedule {sched.id}: {e}")
            rescheduled_job.gcal_event_id = None  # reconcile re-creates on the new date

    # Connecteam removal (step 3): a moved occurrence is no longer re-synced to
    # Connecteam — the cleaner's native My Day reads Job state directly, so the
    # move is visible there the instant this transaction commits.
    db.flush()  # assign a freshly-created job its id before the caller's commit

    return ex, rescheduled_job


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
    # Operator move: email the customer only if BOTH the master notify switch
    # and the move-specific toggle are on (default: silent move). Same rule the
    # single-job update_job path uses, so every operator move is consistent.
    from modules.settings.router import (
        customer_notify_enabled as _ne, customer_notify_on_move_enabled as _nom,
    )
    # A per-move override from the request (the JobEditModal "Notify customer"
    # checkbox) wins for THIS move; otherwise fall back to the settings default.
    _notify_move = body.notify_customer if body.notify_customer is not None else (_ne(db) and _nom(db))
    ex, rescheduled_job = _reschedule_occurrence(
        db, sched, body.exception_date, body.rescheduled_date,
        rescheduled_start_time=body.rescheduled_start_time,
        rescheduled_end_time=body.rescheduled_end_time,
        cleaner_ids=body.cleaner_ids,
        reason=body.reason,
        allow_conflicts=bool(body.allow_conflicts),
        notify_customer=_notify_move,
    )

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
