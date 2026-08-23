"""Home's snapshot boxes — "a full snapshot of all important aspects".

Four widgets that answer "how is the business doing *right now*", each a
single subject:

  money_today   today's money in, money billed, crew hours, visits done
  crew          who's working today, who's off, and what's still unassigned
  feeds         are the Airbnb/VRBO turnover calendars actually feeding us
  recurring     which recurring series have quietly stopped generating

Economy (brightbase-economy rule 3, "one fetch per screen per need"): this is
a sub-payload of ``GET /api/dashboard/board``, not four new endpoints. Home
already makes that one call, so four boxes ride it for free. Everything here
is a small number of indexed reads over one org's rows.

Honesty rule (BB-CODE-04): every number is either exact or absent. No number
in here is derived across mismatched windows — today's hours are not divided
into today's invoices to fake an effective rate, because the visit worked
today is usually billed on a different day. Where a value can't be known
(a cleaner who has never claimed their crew ID), the raw identifier is shown
rather than a guess.

MT-3: every query is org-scoped with the ``org_id == oid OR org_id IS NULL``
pattern used across the board service.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from database.models import (
    CleanerTimeOff, Invoice, Job, PropertyIcal, TimeEntry, User,
)
from utils.dates import business_tz, coerce_date, week_monday

# A feed is "stale" when it hasn't synced in this long. This MUST match
# modules.properties.router._ICAL_STALE_AFTER (and the frontend's
# ICAL_STALE_AFTER_MS, which the property pages, /sync and the Owner
# Dashboard's feed tile all use) — a Home box calling a feed dead while
# /sync calls it healthy is worse than either number being wrong.
# test_board_snapshot.py pins the agreement.
_STALE_FEED_HOURS = 24

# Rows shown per box. These are glance boxes on Home; each deep-links into
# the page that owns the full list.
_CAP = 5

# How far back the money chart looks. Twelve weeks is a quarter — long enough
# to show a trend, short enough that a slow January doesn't hide a bad March.
_TREND_WEEKS = 12

# The lead-drop-off chart's window, matching /api/dashboard/funnel's default so
# Home and that page describe the same cohort.
_FUNNEL_DAYS = 30


# ── tiny local formatters ────────────────────────────────────────────────────
# Deliberately duplicated (not imported from board_service) so the dependency
# stays one-way: board_service imports this module, never the reverse.

def _money(n) -> str:
    try:
        return f"${float(n or 0):,.0f}"
    except (TypeError, ValueError):
        return "$0"


def _hours(h: float) -> str:
    return f"{h:.1f}".rstrip("0").rstrip(".") + "h"


def _day_start_utc(d: date) -> datetime:
    """Naive-UTC start of a business day — matches how timestamps are stored."""
    local = datetime.combine(d, time.min, tzinfo=business_tz())
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def _aware(dt):
    """Stored timestamps arrive naive on some backends and tz-aware on others
    (the writers use `datetime.now(timezone.utc)` into a naive DateTime
    column). Normalize before any arithmetic — mixing the two raises, and in a
    failure-isolated box that would silently blank the widget instead of
    showing the outage it exists to report. Mirrors the same normalization in
    modules/properties/router.py."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _entry_hours(clock_in_at, clock_out_at, break_minutes) -> float:
    """Worked hours for one punch, breaks removed, never negative. Mirrors
    dashboard.analytics._entry_hours and payroll's _native_entry_hours so the
    three surfaces can never disagree about what a punch is worth."""
    secs = (clock_out_at - clock_in_at).total_seconds() - (break_minutes or 0) * 60
    return max(0.0, secs) / 3600.0


def _name_map(db: Session, cleaner_ids) -> dict:
    """crew-ID → display name, one query. Unclaimed IDs stay unmapped; callers
    fall back to the raw ID, which still tells the owner who it is."""
    ids = {str(c) for c in cleaner_ids if c}
    if not ids:
        return {}
    rows = db.query(User.cleaner_id, User.full_name, User.email).filter(
        User.cleaner_id.in_(ids)).all()
    return {r[0]: (r[1] or r[2] or r[0]) for r in rows}


def _local_date(dt):
    """Business-local calendar date for a stored timestamp.

    Maine is UTC-4/-5, so bucketing a payment by its UTC date puts anything
    after 7-8pm into tomorrow — enough to move money across a week boundary and
    make one week look better than it was.
    """
    dt = _aware(dt)
    return dt.astimezone(business_tz()).date() if dt else None


# ── 1. Money & hours today ───────────────────────────────────────────────────

def _money_today(db: Session, oid: int, today: date, collected_today: float) -> dict:
    org = lambda m: or_(m.org_id == oid, m.org_id.is_(None))  # noqa: E731
    start = _day_start_utc(today)

    # Billed today. `draft` is excluded — a draft hasn't been sent to anyone,
    # so it isn't money asked for yet (same rule as dashboard.analytics).
    invoiced = db.query(func.coalesce(func.sum(Invoice.total), 0.0)).filter(
        org(Invoice),
        Invoice.status.in_(("sent", "overdue", "paid")),
        Invoice.created_at >= start,
    ).scalar() or 0.0

    # Today's visits — every status except cancelled, because this box is
    # "how did today actually go", not "what still needs doing".
    rows = db.query(Job.status).filter(
        org(Job), Job.scheduled_date == today, Job.status != "cancelled").all()
    total = len(rows)
    done = sum(1 for (st,) in rows if st == "completed")

    # Crew hours from the native time clock: closed punches contribute their
    # real duration; open punches are counted separately rather than guessed
    # at, so the hours number is never inflated by someone who forgot to
    # clock out.
    punches = db.query(
        TimeEntry.clock_in_at, TimeEntry.clock_out_at, TimeEntry.break_minutes,
    ).filter(org(TimeEntry), TimeEntry.clock_in_at >= start).all()
    hours = sum(_entry_hours(_aware(cin), _aware(cout), brk)
                for cin, cout, brk in punches if cout)
    on_clock = sum(1 for _, cout, _ in punches if not cout)

    return {
        "collected": round(float(collected_today or 0.0), 2),
        "collected_label": _money(collected_today),
        "invoiced": round(float(invoiced), 2),
        "invoiced_label": _money(invoiced),
        "hours": round(hours, 2),
        "hours_label": _hours(hours),
        "on_clock": on_clock,
        "visits_done": done,
        "visits_total": total,
    }


# ── 2. Crew today ────────────────────────────────────────────────────────────

def _crew_today(db: Session, oid: int, today: date) -> dict:
    org = lambda m: or_(m.org_id == oid, m.org_id.is_(None))  # noqa: E731

    jobs = db.query(Job.cleaner_ids, Job.status).filter(
        org(Job), Job.scheduled_date == today, Job.status != "cancelled").all()

    booked: dict = defaultdict(int)
    finished: dict = defaultdict(int)
    unassigned = 0
    for cleaner_ids, status in jobs:
        ids = [str(c) for c in (cleaner_ids or []) if c]
        if not ids:
            unassigned += 1
            continue
        for cid in ids:
            booked[cid] += 1
            if status == "completed":
                finished[cid] += 1

    # Only APPROVED time off means someone is actually off — a crew-submitted
    # request sitting at 'requested' is a decision the owner still owes, and
    # it's surfaced as its own count instead of silently removing them from
    # the day (migration 089).
    off_rows = db.query(CleanerTimeOff).filter(
        org(CleanerTimeOff),
        CleanerTimeOff.status == "approved",
        CleanerTimeOff.start_date <= today,
        CleanerTimeOff.end_date >= today,
    ).all()
    pending = db.query(func.count(CleanerTimeOff.id)).filter(
        org(CleanerTimeOff),
        CleanerTimeOff.status == "requested",
        CleanerTimeOff.end_date >= today,
    ).scalar() or 0

    names = _name_map(db, list(booked) + [r.cleaner_id for r in off_rows])

    working = sorted(
        ({"cleaner_id": cid,
          "name": names.get(cid, cid),
          "jobs": booked[cid],
          "done": finished.get(cid, 0)} for cid in booked),
        key=lambda r: (-r["jobs"], r["name"].lower()),
    )
    off = sorted(
        ({"cleaner_id": r.cleaner_id,
          "name": r.cleaner_name or names.get(r.cleaner_id, r.cleaner_id),
          "reason": (r.reason or "").strip() or "Time off",
          "back": (coerce_date(r.end_date) + timedelta(days=1)).isoformat()
                  if coerce_date(r.end_date) else None}
         for r in off_rows),
        key=lambda r: r["name"].lower(),
    )

    return {
        "working": working[:_CAP],
        "working_total": len(working),
        "off": off[:_CAP],
        "off_total": len(off),
        "pending_requests": int(pending),
        "unassigned_today": unassigned,
    }


# ── 3. Turnover feed health ──────────────────────────────────────────────────

def _feed_state(status, last_synced_at, error, *, now: datetime, cutoff: datetime):
    """One feed's verdict: ('ok'|'failing'|'never'|'stale', human detail).

    Pure so the decision is testable without a database — and so the timestamp
    normalization can't be skipped. `last_synced_at` reaches us naive on one
    backend and tz-aware on another (writers stamp `datetime.now(timezone.utc)`
    into a naive DateTime column), and comparing the two raises; inside a
    failure-isolated box that would blank the widget whose entire job is
    reporting the outage.
    """
    if (status or "").lower() in ("failed", "retrying"):
        return "failing", (error or "Last sync failed").strip()
    last = _aware(last_synced_at)
    if last is None:
        return "never", "Never synced"
    if last < cutoff:
        return "stale", f"Last synced {_ago(last, now)}"
    return "ok", ""


def _feed_health(db: Session, oid: int, now: datetime) -> dict:
    """Are the short-term-rental calendars still feeding us bookings?

    A turnover job only exists because a feed told us about a checkout, so a
    feed that quietly stopped is invisible in every other view — the schedule
    just looks empty, which is indistinguishable from a quiet week. That's the
    failure this box exists to catch.
    """
    org = lambda m: or_(m.org_id == oid, m.org_id.is_(None))  # noqa: E731

    rows = (
        db.query(PropertyIcal)
        .options(joinedload(PropertyIcal.property))
        .filter(org(PropertyIcal), PropertyIcal.active.is_(True))
        .all()
    )
    cutoff = now - timedelta(hours=_STALE_FEED_HOURS)

    problems, ok = [], 0
    for f in rows:
        state, detail = _feed_state(f.last_sync_status, f.last_synced_at, f.last_sync_error,
                                    now=now, cutoff=cutoff)
        if state == "ok":
            ok += 1
            continue
        prop = f.property
        problems.append({
            "id": f.id,
            "property_id": f.property_id,
            "property_name": (prop.name or prop.address) if prop else f"Property {f.property_id}",
            "source": (f.source or "ical").title(),
            "state": state,
            "detail": detail[:160],
        })

    order = {"failing": 0, "never": 1, "stale": 2}
    problems.sort(key=lambda p: (order.get(p["state"], 9), p["property_name"].lower()))
    return {
        "total": len(rows),
        "ok": ok,
        "problems": problems[:_CAP],
        "problem_total": len(problems),
        "stale_hours": _STALE_FEED_HOURS,
    }


def _ago(dt: datetime, now: datetime) -> str:
    mins = max(0, int((now - dt).total_seconds() // 60))
    if mins < 60:
        return f"{mins}m ago"
    if mins < 60 * 48:
        return f"{mins // 60}h ago"
    return f"{mins // 1440}d ago"


# ── 4. Recurring series that stopped generating ──────────────────────────────

def _recurring_health(db: Session, oid: int) -> dict:
    """Reuses the Recurring Doctor scan (services.recurring_guards.audit_series)
    rather than re-deriving "stalled" here — one definition of a sick series,
    one place to fix it. This box surfaces only the codes that mean *work isn't
    happening*: an active series with nothing upcoming, or a series that ended
    but is still presenting itself as live."""
    from services.recurring_guards import audit_series

    audit = audit_series(db, oid)
    watch = {"active_no_upcoming", "ended_but_active"}
    stalled = []
    for issue in audit.get("issues", []):
        hit = next((p for p in issue.get("problems", []) if p["code"] in watch), None)
        if not hit:
            continue
        stalled.append({
            "schedule_id": issue["schedule_id"],
            "title": (issue.get("title") or "").strip() or "Untitled series",
            "client_id": issue.get("client_id"),
            "client_name": issue.get("client_name"),
            "cadence": issue.get("cadence"),
            "code": hit["code"],
            "message": hit["message"],
        })

    return {
        "scanned": int(audit.get("scanned", 0)),
        "healthy": int(audit.get("healthy", 0)),
        # Three, not five: the rows are near-identical sentences, and five of
        # them crowded everything below off the screen.
        "stalled": stalled[:3],
        "stalled_total": len(stalled),
        "other_issues": max(0, len(audit.get("issues", [])) - len(stalled)),
    }


# ── 5. Money over time ───────────────────────────────────────────────────────

def _money_trend(db: Session, oid: int, today: date) -> dict:
    """Collected and billed per week for the last _TREND_WEEKS weeks.

    Two series, one unit (dollars) — so one axis, never two. `collected` is
    cash actually in (Invoice.paid_at); `invoiced` is what was asked for
    (Invoice.created_at, drafts excluded — a draft has been sent to nobody).
    They are deliberately NOT the same invoices in the same week: work billed
    in March is often paid in April, and seeing that lag is the point.
    """
    org = lambda m: or_(m.org_id == oid, m.org_id.is_(None))  # noqa: E731

    first_monday = week_monday(today) - timedelta(weeks=_TREND_WEEKS - 1)
    start = _day_start_utc(first_monday)

    weeks = [first_monday + timedelta(weeks=i) for i in range(_TREND_WEEKS)]
    index = {w: i for i, w in enumerate(weeks)}
    collected = [0.0] * _TREND_WEEKS
    invoiced = [0.0] * _TREND_WEEKS

    def bucket(series, when, amount):
        d = _local_date(when)
        if d is None:
            return
        i = index.get(week_monday(d))
        if i is not None:
            series[i] += float(amount or 0.0)

    for paid_at, total in db.query(Invoice.paid_at, Invoice.total).filter(
            org(Invoice), Invoice.status == "paid",
            Invoice.paid_at.isnot(None), Invoice.paid_at >= start).all():
        bucket(collected, paid_at, total)

    for created_at, total in db.query(Invoice.created_at, Invoice.total).filter(
            org(Invoice), Invoice.status.in_(("sent", "overdue", "paid")),
            Invoice.created_at >= start).all():
        bucket(invoiced, created_at, total)

    points = [
        {"week": w.isoformat(),
         "label": f"{w.strftime('%b')} {w.day}",
         "collected": round(collected[i], 2),
         "invoiced": round(invoiced[i], 2)}
        for i, w in enumerate(weeks)
    ]
    return {
        "weeks": _TREND_WEEKS,
        "points": points,
        "collected_total": round(sum(collected), 2),
        "invoiced_total": round(sum(invoiced), 2),
        # A chart of twelve zeroes is furniture; the widget hides itself.
        "has_data": any(p["collected"] or p["invoiced"] for p in points),
    }


# ── 6. Where leads come from, and where they stop ────────────────────────────

def _lead_funnel(db: Session, oid: int) -> dict:
    """Requests → quoted → accepted → won for the last _FUNNEL_DAYS days.

    Calls modules.dashboard.analytics.lead_funnel — the SAME function behind
    /api/dashboard/funnel — rather than re-deriving the stages here. Those
    rules carry real subtleties (an archived quote must not count as
    \"quoted\"; stage is read from timestamps OR status so it stays monotonic),
    and a second copy would drift until Home and the funnel page disagreed
    about how the business is doing.
    """
    from modules.dashboard.analytics import lead_funnel

    full = lead_funnel(db, oid, days=_FUNNEL_DAYS)
    stages = {s["key"]: s for s in full.get("funnel", [])}
    keep = ("requests", "quoted", "accepted", "won")
    steps = [
        {"key": k, "label": stages[k]["label"], "count": int(stages[k]["count"] or 0)}
        for k in keep if k in stages
    ]
    top = int(steps[0]["count"]) if steps else 0

    return {
        "window_days": _FUNNEL_DAYS,
        "steps": steps,
        # Share of the first stage, so the bars are comparable at a glance.
        "widths": [round((s["count"] / top) * 100) if top else 0 for s in steps],
        "overall_pct": full.get("conversion", {}).get("overall_pct"),
        "by_source": full.get("by_source", [])[:4],
        "has_data": top > 0,
    }


# ── the build ────────────────────────────────────────────────────────────────

def build_snapshot(db: Session, oid: int, *, today: date, collected_today: float) -> dict:
    """Assemble the four snapshot boxes.

    ``collected_today`` is passed in because the board already computed it —
    recomputing would be a second identical query on the hot path for a number
    that must match the "Collected today" stat tile exactly.

    Each box is independent and failure-isolated: a box that raises returns
    None and the widget renders nothing, because a snapshot nicety must never
    take down the attention board underneath it.
    """
    now = datetime.now(timezone.utc)
    out = {}
    builders = (
        ("money_today", lambda: _money_today(db, oid, today, collected_today)),
        ("crew", lambda: _crew_today(db, oid, today)),
        ("feeds", lambda: _feed_health(db, oid, now)),
        ("recurring", lambda: _recurring_health(db, oid)),
        ("money_trend", lambda: _money_trend(db, oid, today)),
        ("lead_funnel", lambda: _lead_funnel(db, oid)),
    )
    for key, fn in builders:
        try:
            out[key] = fn()
        except Exception:  # noqa: BLE001 — a broken box must not break Home
            out[key] = None
    return out
