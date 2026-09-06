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
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from database.models import (
    CleanerAvailability,
    CleanerTimeOff,
    CleanerWeekAvailability,
    Invoice,
    Job,
    LeadIntake,
    Property,
    Quote,
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

    # Crew hours per property used to come from closed time-clock punches, and
    # the effective $/hr from dividing revenue by them. Both are gone with the
    # employee model: a subcontractor is paid for the job, not the hour, so
    # there is no hours figure to divide by and an "$/hr" for a sub would be
    # deriving exactly the number the arrangement must not be priced on.
    pids = set(revenue) | set(visits)
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


# ── Lead → quote funnel ──────────────────────────────────────────────────────

# A quote in any of these statuses has, at minimum, been sent to the customer.
_SENT_PLUS = {"sent", "viewed", "changes_requested", "accepted", "converted", "declined", "expired"}
# …and these mean the customer has seen it (you can't accept/ask-to-change unseen).
_VIEWED_PLUS = {"viewed", "changes_requested", "accepted", "converted"}
_ACCEPTED_PLUS = {"accepted", "converted"}


def _as_naive_utc(dt):
    """Normalize a datetime / ISO-string to naive UTC (or None).

    LeadIntake.created_at is a naive ``DateTime`` column while the Quote
    timestamps are ``DateTime(timezone=True)``; subtracting one from the other
    raises ``TypeError: can't subtract offset-naive and offset-aware`` on
    Postgres. Flattening both to naive UTC first keeps the duration math safe
    (and never raises on a legacy string value)."""
    if dt is None:
        return None
    if isinstance(dt, str):
        try:
            dt = datetime.fromisoformat(dt)
        except ValueError:
            return None
    tz = getattr(dt, "tzinfo", None)
    if tz is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _median(values):
    """Median of a list (or None when empty). More honest than a mean for
    turnaround times, where one stale quote skews the average."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    n = len(vals)
    mid = n // 2
    return vals[mid] if n % 2 else (vals[mid - 1] + vals[mid]) / 2.0


def _quote_stage(quote) -> int:
    """The furthest funnel stage a quote reached: 0 draft, 1 sent, 2 viewed,
    3 accepted, 4 won (converted). Reads timestamps OR status so the funnel
    stays monotonic even when a step's own signal is missing — e.g. an admin
    accepting on the phone never records a `viewed_at`, but an accepted quote
    has plainly been seen."""
    status = (quote.status or "").lower()
    stage = 0
    if quote.sent_at or quote.follow_up_sent_at or status in _SENT_PLUS:
        stage = 1
    if quote.viewed_at or status in _VIEWED_PLUS:
        stage = max(stage, 2)
    if quote.accepted_at or status in _ACCEPTED_PLUS:
        stage = max(stage, 3)
    if quote.converted_at or status == "converted":
        stage = max(stage, 4)
    return stage


def lead_funnel(db: Session, oid, *, days: int = 30) -> dict:
    """Intake→quote conversion funnel over the last ``days`` days.

    Cohort = requests (LeadIntake) created in the window, excluding archived.
    Each request is followed to its linked quote's furthest stage, giving
    cumulative stage counts, step-by-step conversion rates, the current-status
    outcome mix, median time-to-quote / time-to-accept, dollar value at each
    money stage, and a per-source breakdown.

    Lives here, not in the router, because Home's lead-drop-off chart needs the
    same cohort rules — including the subtle one where an ARCHIVED quote must
    not count as \"quoted\". Two copies of that would drift, and the two screens
    would quietly disagree about how the business is doing. The
    /api/dashboard/funnel endpoint is a thin caller; so is board_snapshot."""
    org_scope = lambda model: or_(model.org_id == oid, model.org_id.is_(None))
    now = datetime.utcnow()
    window_start = now - timedelta(days=days)

    intakes = (
        db.query(
            LeadIntake.source,
            LeadIntake.created_at,
            LeadIntake.converted_quote_id,
        )
        .filter(
            org_scope(LeadIntake),
            LeadIntake.created_at >= window_start,
            or_(LeadIntake.status.is_(None), LeadIntake.status != "archived"),
        )
        .all()
    )

    quote_ids = [i.converted_quote_id for i in intakes if i.converted_quote_id]
    quotes = {}
    if quote_ids:
        # org_scope(Quote): ids come from org-scoped intakes, but converted_quote_id
        # isn't validated cross-org at write time — scope the read, don't trust the id.
        for q in db.query(Quote).filter(org_scope(Quote), Quote.id.in_(set(quote_ids))).all():
            quotes[q.id] = q

    counts = {"requests": len(intakes), "quoted": 0, "sent": 0, "viewed": 0, "accepted": 0, "won": 0}
    value = {"quoted": 0.0, "accepted": 0.0, "won": 0.0}
    outcomes = {"open": 0, "changes_requested": 0, "accepted": 0, "won": 0, "declined": 0, "expired": 0}
    ttq_hours, tta_hours = [], []
    by_source: dict = {}

    for i in intakes:
        src = (i.source or "unknown").strip().lower() or "unknown"
        bucket = by_source.setdefault(src, {"source": src, "requests": 0, "quoted": 0, "won": 0})
        bucket["requests"] += 1

        quote = quotes.get(i.converted_quote_id) if i.converted_quote_id else None
        # An archived (soft-deleted) quote is no longer a live quote — delete_quote
        # flips status to "archived" but leaves the intake's converted_quote_id
        # intact. Treat the request as un-quoted so an archived quote never
        # inflates the quoted/stage counts or the outcome mix (it would otherwise
        # fall through to "open" / "in play · awaiting reply").
        if quote is None or (quote.status or "").lower() == "archived":
            continue

        counts["quoted"] += 1
        bucket["quoted"] += 1
        total = float(quote.total or 0)
        value["quoted"] += total

        stage = _quote_stage(quote)
        if stage >= 1:
            counts["sent"] += 1
        if stage >= 2:
            counts["viewed"] += 1
        if stage >= 3:
            counts["accepted"] += 1
            value["accepted"] += total
        if stage >= 4:
            counts["won"] += 1
            bucket["won"] += 1
            value["won"] += total

        # Current-status outcome mix — each quoted request lands in exactly one.
        st = (quote.status or "").lower()
        if st == "converted":
            outcomes["won"] += 1
        elif st == "accepted":
            outcomes["accepted"] += 1
        elif st == "declined":
            outcomes["declined"] += 1
        elif st == "expired":
            outcomes["expired"] += 1
        elif st == "changes_requested":
            outcomes["changes_requested"] += 1
        else:
            outcomes["open"] += 1  # draft / sent / viewed — still in play

        # Turnaround times.
        t_intake = _as_naive_utc(i.created_at)
        t_quote = _as_naive_utc(quote.created_at)
        if t_intake and t_quote:
            h = (t_quote - t_intake).total_seconds() / 3600.0
            if h >= 0:
                ttq_hours.append(h)
        t_accept = _as_naive_utc(quote.accepted_at)
        t_start = _as_naive_utc(quote.sent_at) or t_quote
        if t_accept and t_start:
            h = (t_accept - t_start).total_seconds() / 3600.0
            if h >= 0:
                tta_hours.append(h)

    def pct(numer, denom):
        return round(numer / denom * 100, 1) if denom else None

    funnel = [
        {"key": "requests", "label": "Requests", "count": counts["requests"], "value": None},
        {"key": "quoted", "label": "Quoted", "count": counts["quoted"], "value": round(value["quoted"], 2)},
        {"key": "sent", "label": "Sent", "count": counts["sent"], "value": None},
        {"key": "viewed", "label": "Viewed", "count": counts["viewed"], "value": None},
        {"key": "accepted", "label": "Accepted", "count": counts["accepted"], "value": round(value["accepted"], 2)},
        {"key": "won", "label": "Won", "count": counts["won"], "value": round(value["won"], 2)},
    ]

    by_source_list = sorted(by_source.values(), key=lambda r: (r["requests"], r["won"]), reverse=True)
    for r in by_source_list:
        r["won_pct"] = pct(r["won"], r["requests"])

    ttq = _median(ttq_hours)
    tta = _median(tta_hours)
    return {
        "window_days": days,
        "as_of": business_today().isoformat(),
        "funnel": funnel,
        "conversion": {
            "request_to_quote_pct": pct(counts["quoted"], counts["requests"]),
            "quote_to_sent_pct": pct(counts["sent"], counts["quoted"]),
            "sent_to_viewed_pct": pct(counts["viewed"], counts["sent"]),
            "viewed_to_accepted_pct": pct(counts["accepted"], counts["viewed"]),
            "accepted_to_won_pct": pct(counts["won"], counts["accepted"]),
            "overall_pct": pct(counts["won"], counts["requests"]),
        },
        "outcomes": outcomes,
        "timing": {
            "time_to_quote_hours_median": round(ttq, 1) if ttq is not None else None,
            "time_to_accept_hours_median": round(tta, 1) if tta is not None else None,
            "quoted_sample": len(ttq_hours),
            "accepted_sample": len(tta_hours),
        },
        "value": {k: round(v, 2) for k, v in value.items()},
        "by_source": by_source_list,
    }
