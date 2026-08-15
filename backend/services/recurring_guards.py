"""Pre-create similarity guard for recurring series.

Data-model review follow-up (guard 1): ``POST /api/recurring`` did no
pre-existence check, so a double-create (or a re-create after a split left the
retired predecessor looking alive) silently produced two live series feeding
the same calendar slot — the "two Sandra Fox, every 4 weeks on Fri" case the
frontend duplicate flag keeps catching after the fact. This service catches it
BEFORE the row exists; the router turns matches into an overridable 409
(``allow_duplicate: true`` resubmit), mirroring scheduling's
``allow_conflicts`` escape hatch.

Lives here rather than in the router per scheduling-invariants R6 (routers
route; business logic goes in a service). Read-only: this module never writes
anything.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database.models import Job, Property, RecurringSchedule
from utils.dates import business_today, coerce_date, coerce_time

_DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _effective_days(days_of_week, day_of_week, frequency: Optional[str] = None) -> Set[int]:
    """Day-of-week set for comparison (mirrors the router's _effective_days:
    legacy single-day fallback, clamped to 0-6). For a DAILY rule an empty
    set means "every day", so it compares as all seven days."""
    if days_of_week:
        cleaned = {
            int(d) for d in days_of_week
            if isinstance(d, (int, float)) and 0 <= int(d) <= 6
        }
        if cleaned:
            return cleaned
    if frequency == "daily":
        return set(range(7))
    return {day_of_week} if day_of_week is not None else {0}


def _cadence_text(sched: RecurringSchedule) -> str:
    """Compact human summary, e.g. 'Biweekly Tue 9:00' — what the confirm
    prompt shows next to the existing series."""
    interval = sched.interval_weeks or 1
    if sched.frequency == "monthly":
        base = f"Monthly on day {sched.day_of_month or 1}"
    elif sched.frequency == "daily":
        base = "Daily" if interval <= 1 else f"Every {interval} days"
    else:
        cadence = ("Weekly" if interval == 1 else
                   "Biweekly" if interval == 2 else f"Every {interval} weeks")
        days = sorted(_effective_days(sched.days_of_week, sched.day_of_week, sched.frequency))
        base = f"{cadence} {'/'.join(_DAY_ABBR[d] for d in days)}"
    st = coerce_time(sched.start_time)
    if st is not None:
        base += f" {st.hour}:{st.minute:02d}"
    return base


def find_similar_series(db: Session, org_id: Optional[int], payload: Dict[str, Any]) -> List[dict]:
    """Live series that look like the one about to be created.

    A match is a series that is active AND not ended (series_end_date IS NULL
    OR > today — a split-retired predecessor with only its end date set must
    NOT trip the guard) with the same client, same property (both-None counts
    as same), same frequency + interval + day_of_month + start_time, and an
    OVERLAPPING day-of-week set: a new Wednesday series matches an existing
    Mon/Wed/Fri one, because both would put a crew there on Wednesdays.

    Returns compact JSON-safe dicts for the 409 payload; empty list = clear
    to create.
    """
    today = business_today()
    frequency = payload.get("frequency")
    new_days = _effective_days(payload.get("days_of_week"), payload.get("day_of_week"), frequency)
    new_start = coerce_time(payload.get("start_time"))
    new_interval = payload.get("interval_weeks") or 1
    new_dom = payload.get("day_of_month")
    # COALESCE(property_id, -1) semantics: a series with no property only
    # matches another with no property.
    new_prop = payload.get("property_id") if payload.get("property_id") is not None else -1

    candidates = db.query(RecurringSchedule).filter(
        RecurringSchedule.client_id == payload.get("client_id"),
        RecurringSchedule.frequency == frequency,
        RecurringSchedule.active == True,  # noqa: E712
        or_(RecurringSchedule.org_id == org_id, RecurringSchedule.org_id.is_(None)),
    ).all()

    matches: List[RecurringSchedule] = []
    for s in candidates:
        end = coerce_date(s.series_end_date)
        if end is not None and end <= today:
            continue  # ended — retired, not a live duplicate
        if (s.property_id if s.property_id is not None else -1) != new_prop:
            continue
        if (s.interval_weeks or 1) != new_interval:
            continue
        if (s.day_of_month or None) != (new_dom or None):
            continue
        if coerce_time(s.start_time) != new_start:
            continue
        if frequency != "monthly":
            if not (_effective_days(s.days_of_week, s.day_of_week, s.frequency) & new_days):
                continue
        matches.append(s)

    if not matches:
        return []

    # Upcoming-visit counts + property names for the matches: two small
    # grouped/IN queries (same shape get_schedules uses), cheap at this size.
    ids = [s.id for s in matches]
    count_rows = (
        db.query(Job.recurring_schedule_id, func.count(Job.id))
        .filter(
            Job.recurring_schedule_id.in_(ids),
            Job.status != "cancelled",
            or_(Job.scheduled_date == None, Job.scheduled_date >= today.isoformat()),  # noqa: E711
        )
        .group_by(Job.recurring_schedule_id)
        .all()
    )
    counts = {sid: c for sid, c in count_rows}
    prop_ids = [s.property_id for s in matches if s.property_id]
    prop_names = {}
    if prop_ids:
        prop_names = dict(
            db.query(Property.id, Property.name).filter(Property.id.in_(prop_ids)).all()
        )

    out = []
    for s in matches:
        st = coerce_time(s.start_time)
        out.append({
            "id": s.id,
            "title": s.title,
            "address": s.address,
            "property_id": s.property_id,
            "property_name": prop_names.get(s.property_id),
            "cadence": _cadence_text(s),
            "start_time": f"{st.hour:02d}:{st.minute:02d}" if st is not None else None,
            "upcoming_job_count": counts.get(s.id, 0),
        })
    return out
