"""
Owner-analytics aggregations behind /api/dashboard/property-economics and
/api/dashboard/week-capacity (Owner Dashboard widgets).

Kept out of router.py on purpose: these are the two computations with real
math in them (per-property revenue/hours join, availability-vs-booked capacity)
and the router is already 600 lines of other aggregates. Everything here is
read-only, computed on request (no background ticks — R1), and org-scoped with
the same `or_(org_id == X, org_id.is_(None))` pattern the rest of the dashboard
uses; Postgres RLS remains the backstop.

Payload rule: NOTHING here may carry property access details (door codes,
wifi, lockbox notes). Only ids, names and aggregate numbers leave this module.
"""
from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from database.models import (
    CleanerAvailability,
    CleanerTimeOff,
    CleanerWeekAvailability,
    Invoice,
    Job,
    Property,
    TimeEntry,
    User,
)
from utils.dates import business_today, week_monday

# A cleaner-set availability slot is a half day. The crew app's vocabulary is
# AM / PM / Off (per-day), so 4h per slot ≈ 8h for a full day — the same 8h/day
# floor the schedule's utilization panel already assumes
# (frontend useScheduleAnalytics.HOURS_PER_CREW_DAY).
_HOURS_PER_SLOT = 4.0
_HOURS_PER_UNKNOWN_DAY = 8.0  # cleaner with no availability pattern at all

_WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _entry_hours(clock_in_at, clock_out_at, break_minutes) -> float:
    """Worked hours for a closed punch: elapsed minus breaks, never negative.
    Mirrors modules.payroll.router._native_entry_hours so the property view
    and the payroll view can never disagree about what a punch is worth."""
    secs = (clock_out_at - clock_in_at).total_seconds() - (break_minutes or 0) * 60
    return max(0.0, secs) / 3600.0


def property_economics(db: Session, oid, *, window_days: int = 90, limit: int = 8) -> dict:
    """\"Am I making money on this house\" — per-property revenue, visit count,
    crew hours from the native time clock, and the resulting effective $/hr.

    Attribution is via the job: Invoice → Job → Property for revenue,
    TimeEntry → Job → Property for hours. Invoices billed with no job link
    can't be pinned to a property and are simply absent here (the Owner
    Dashboard's revenue tiles still count them); same for punches clocked in
    without a job. Windows: invoices by created_at, punches by clock_in_at,
    completed visits by scheduled_date — \"activity in the last N days\".

    Money is the same Float dollars the Invoice rows store — summed and
    rounded for display, no new money math.
    """
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))  # noqa: E731
    window_start_dt = datetime.utcnow() - timedelta(days=window_days)
    window_start_d = business_today() - timedelta(days=window_days)

    # Revenue per property — one grouped pass. `draft` is excluded: a draft
    # hasn't been sent to anyone, so it isn't "invoiced" yet.
    inv_rows = (
        db.query(
            Job.property_id,
            func.count(Invoice.id),
            func.coalesce(
                func.sum(case((Invoice.status == "paid", Invoice.total), else_=0.0)), 0.0
            ),
            func.coalesce(func.sum(Invoice.total), 0.0),
        )
        .select_from(Invoice)
        .join(Job, Invoice.job_id == Job.id)
        .filter(
            org(Invoice),
            Invoice.status.in_(("sent", "overdue", "paid")),
            Invoice.created_at >= window_start_dt,
        )
        .group_by(Job.property_id)
        .all()
    )
    revenue = {
        pid: {
            "invoice_count": int(count),
            "revenue_paid": float(paid or 0.0),
            "revenue_invoiced": float(total or 0.0),
        }
        for pid, count, paid, total in inv_rows
    }

    # Completed visits per property.
    visit_rows = (
        db.query(Job.property_id, func.count(Job.id))
        .filter(
            org(Job),
            Job.status == "completed",
            Job.scheduled_date >= window_start_d,
        )
        .group_by(Job.property_id)
        .all()
    )
    visits = dict(visit_rows)

    # Crew hours per property from closed native punches. Duration math stays
    # in Python (naive-UTC datetime subtraction) so it's identical on SQLite
    # and Postgres — the volume is one org's punches for a window, small.
    punch_rows = (
        db.query(
            Job.property_id,
            TimeEntry.clock_in_at,
            TimeEntry.clock_out_at,
            TimeEntry.break_minutes,
        )
        .select_from(TimeEntry)
        .join(Job, TimeEntry.job_id == Job.id)
        .filter(
            org(TimeEntry),
            TimeEntry.clock_out_at.isnot(None),
            TimeEntry.clock_in_at >= window_start_dt,
        )
        .all()
    )
    hours: dict = defaultdict(float)
    for pid, cin, cout, brk in punch_rows:
        hours[pid] += _entry_hours(cin, cout, brk)

    # Resolve names for every property that saw activity. org(Property) is the
    # isolation backstop: a cross-org job/invoice link (not validated at write
    # time) must never leak another tenant's property name into this payload.
    pids = set(revenue) | set(visits) | set(hours)
    pids.discard(None)
    props = {}
    if pids:
        props = {
            p.id: p
            for p in db.query(Property).filter(org(Property), Property.id.in_(pids)).all()
        }

    rows = []
    for pid, p in props.items():
        rev = revenue.get(pid, {"invoice_count": 0, "revenue_paid": 0.0, "revenue_invoiced": 0.0})
        h = hours.get(pid, 0.0)
        paid = rev["revenue_paid"]
        rows.append({
            "property_id": pid,
            "property_name": p.name,
            "property_type": p.property_type,
            "client_id": p.client_id,
            "invoice_count": rev["invoice_count"],
            "revenue_paid": round(paid, 2),
            "revenue_invoiced": round(rev["revenue_invoiced"], 2),
            "visits": int(visits.get(pid, 0)),
            "crew_hours": round(h, 1),
            # Paid dollars per crew hour — the pricing-decision number. None
            # when there are no recorded hours (no rate is more honest than a
            # divide-by-almost-zero fantasy rate).
            "effective_hourly": round(paid / h, 2) if h > 0 else None,
        })

    rows.sort(key=lambda r: (r["revenue_paid"], r["revenue_invoiced"]), reverse=True)
    return {
        "as_of": business_today().isoformat(),
        "window_days": window_days,
        "properties_total": len(rows),
        "properties": rows[:limit],
    }


def week_capacity(db: Session, oid) -> dict:
    """Booked job hours vs available crew hours for the week containing today
    (Monday-anchored, matching the crew-availability tables' week_start).

    Booked = every non-cancelled job scheduled this week; hours come from the
    job's own start/end times, falling back to the property's default duration
    (then 3h — the Property column default) when times aren't set, so a
    date-only turnover still counts as real work.

    Available = per cleaner per day from the crew app's availability data,
    resolved exactly like the scheduling guards do: an explicit week row masks
    the weekly template; approved time-off zeroes the day outright; a cleaner
    with no pattern at all is assumed full-time (8h/day — the same floor the
    schedule's utilization bars use) and counted in `crew_without_pattern` so
    the UI can caption the estimate honestly.
    """
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))  # noqa: E731
    today = business_today()
    monday = week_monday(today)
    days = [monday + timedelta(days=i) for i in range(7)]
    sunday = days[-1]

    # ── Booked hours per day ────────────────────────────────────────────────
    job_rows = (
        db.query(Job.scheduled_date, Job.start_time, Job.end_time,
                 Property.default_duration_hours)
        .outerjoin(Property, Job.property_id == Property.id)
        .filter(
            org(Job),
            Job.status != "cancelled",
            Job.scheduled_date >= monday,
            Job.scheduled_date <= sunday,
        )
        .all()
    )
    booked = {d: 0.0 for d in days}
    jobs_count = {d: 0 for d in days}
    for d, st, en, default_h in job_rows:
        if d not in booked:
            continue
        if st is not None and en is not None:
            h = (en.hour + en.minute / 60.0) - (st.hour + st.minute / 60.0)
            if h <= 0:  # crossed midnight / bad data — fall back, don't go negative
                h = float(default_h or 3.0)
        else:
            h = float(default_h or 3.0)
        booked[d] += h
        jobs_count[d] += 1

    # ── Available hours per day ─────────────────────────────────────────────
    # Roster mirrors /api/dispatch/employees: active cleaner-role users with a
    # crew ID (that's who can actually be assigned work).
    roster = [
        u for u in db.query(User).filter(
            User.role == "cleaner",
            User.active.is_(True),
            User.cleaner_id.isnot(None),
            org(User),
        ).all()
        if (u.status or "active") != "disabled" and (u.cleaner_id or "").strip()
    ]

    # Lazy import (same precedent as scheduling/router.py's availability
    # endpoint): crew.router is heavyweight and importing it at module load
    # from dashboard would couple startup order for one clamp helper.
    from modules.crew.router import _normalize_week

    week_rows = {
        str(r.cleaner_id): _normalize_week(r.week)
        for r in db.query(CleanerWeekAvailability).filter(
            CleanerWeekAvailability.week_start == monday, org(CleanerWeekAvailability)
        ).all()
    }
    template_rows = {
        str(r.cleaner_id): _normalize_week(r.week)
        for r in db.query(CleanerAvailability).filter(org(CleanerAvailability)).all()
    }
    off_days = set()  # (cleaner_id, date) pairs covered by APPROVED time off
    for r in db.query(CleanerTimeOff).filter(
        org(CleanerTimeOff),
        CleanerTimeOff.status == "approved",
        CleanerTimeOff.start_date <= sunday,
        CleanerTimeOff.end_date >= monday,
    ).all():
        for d in days:
            if r.start_date <= d <= r.end_date:
                off_days.add((str(r.cleaner_id), d))

    available = {d: 0.0 for d in days}
    crew_without_pattern = 0
    for u in roster:
        cid = str(u.cleaner_id)
        # Explicit week row masks the template in BOTH directions (a volunteer
        # who opened a usually-off day must count) — same rule as scheduling's
        # cleaner-availability endpoint.
        pattern = week_rows.get(cid, template_rows.get(cid))
        if pattern is None:
            crew_without_pattern += 1
        for i, d in enumerate(days):
            if (cid, d) in off_days:
                continue
            if pattern is None:
                available[d] += _HOURS_PER_UNKNOWN_DAY
            else:
                available[d] += _HOURS_PER_SLOT * len(pattern.get(_WEEKDAY_KEYS[i], []))

    total_booked = sum(booked.values())
    total_available = sum(available.values())
    return {
        "as_of": today.isoformat(),
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "booked_hours": round(total_booked, 1),
        "available_hours": round(total_available, 1),
        "utilization_pct": (
            round(total_booked / total_available * 100) if total_available > 0 else None
        ),
        "crew_count": len(roster),
        "crew_without_pattern": crew_without_pattern,
        "days": [
            {
                "date": d.isoformat(),
                "weekday": _WEEKDAY_KEYS[i],
                "jobs": jobs_count[d],
                "booked_hours": round(booked[d], 1),
                "available_hours": round(available[d], 1),
            }
            for i, d in enumerate(days)
        ],
    }
