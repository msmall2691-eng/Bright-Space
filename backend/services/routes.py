"""Routes: the rate split, and the rules for offering one.

Lives in a service, not in the router (scheduling-invariants R6: routers
route). Generation calls in here too, so putting the arithmetic anywhere else
would mean two copies of the one calculation that decides what somebody is
paid.

THE SPLIT. `routes.rate` is priced per occurrence of the whole block, because
that is how a sub thinks about it ("$400 for my Tuesday"). Payroll pays a flat
`Job.agreed_rate` once per (job, cleaner) — built and tested for the
marketplace in 097 — so generation distributes the block rate across that
occurrence's jobs and writes each share to `agreed_rate`. The consequence is
deliberate: by the time a route reaches money it is indistinguishable from an
approved marketplace job, and payroll needs no new code.

Two properties the split must have, both load-bearing:

  1. The shares sum EXACTLY to the block rate. A route that pays $399.99 out of
     $400 gets reported as a bug forever, and rightly.
  2. It follows time, not job count. A 90-minute house and a 3-hour house are
     not the same work, and paying them the same is how a route stops being
     worth taking.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from database.models import RecurringSchedule, Route, RouteMember
from utils.dates import coerce_time

logger = logging.getLogger(__name__)

ROUTE_STATUSES = ("draft", "offered", "active", "ended")


def schedule_minutes(sched) -> Optional[int]:
    """Scheduled length of one visit, or None when the series has no window.

    None is a real state, not a defensive nicety: the model says start_time and
    end_time are NOT NULL, production disagrees, and the Recurring health scan
    carries a `no_time_set` finding precisely because rows without times exist.
    A missing window can't be weighed against a real one, so the caller has to
    decide what to do rather than silently treat it as zero — which would pay
    that house nothing, since payroll's flat-rate branch is gated on
    `agreed_rate > 0`.
    """
    start, end = coerce_time(sched.start_time), coerce_time(sched.end_time)
    if start is None or end is None:
        return None
    minutes = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute)
    # An overnight or inverted window isn't a duration we can price against.
    return minutes if minutes > 0 else None


def split_rate(total, weights) -> list:
    """Divide `total` into len(weights) shares, proportional to `weights`.

    Cents, and the remainder goes to the last share so the shares sum exactly
    to the total. Equal weights (or no usable weights at all) degrade to an
    even split rather than raising — the caller has already refused the cases
    where that would be wrong.
    """
    n = len(weights)
    if n == 0:
        return []
    cents = int(round(float(total or 0) * 100))
    usable = [float(w) for w in weights if w and float(w) > 0]
    if len(usable) != n:
        weights = [1.0] * n          # nothing to weigh by: even split
    denom = sum(float(w) for w in weights)
    if denom <= 0:
        weights, denom = [1.0] * n, float(n)

    shares, running = [], 0
    for w in weights[:-1]:
        part = int(cents * float(w) / denom)   # floor each, never round up past the total
        shares.append(part)
        running += part
    shares.append(cents - running)             # the remainder lands here, exactly
    return [round(c / 100.0, 2) for c in shares]


def member_schedules(db: Session, route: Route) -> list:
    """The route's schedules in drive order."""
    rows = (db.query(RouteMember, RecurringSchedule)
            .join(RecurringSchedule, RecurringSchedule.id == RouteMember.recurring_schedule_id)
            .filter(RouteMember.route_id == route.id)
            .order_by(RouteMember.position, RouteMember.id)
            .all())
    return [sched for _m, sched in rows]


def shares_by_schedule(db: Session, route: Route) -> dict:
    """{recurring_schedule_id: dollars} for one occurrence of this route.

    Generation reads this to price the jobs it creates. Returns {} for a route
    with no rate or no members rather than inventing a number.
    """
    scheds = member_schedules(db, route)
    if not scheds or not route.rate:
        return {}
    weights = [schedule_minutes(s) or 0 for s in scheds]
    shares = split_rate(route.rate, weights)
    return {s.id: share for s, share in zip(scheds, shares)}


def validate_offerable(db: Session, route: Route) -> Optional[str]:
    """Why this route can't be offered or accepted, or None if it can.

    Checked at BOTH ends, like the marketplace's no-rate guard: the office can
    change a route between offering it and the sub tapping accept, and the sub
    should not be the one who discovers it.
    """
    if not route.rate or float(route.rate) <= 0:
        return "This route has no rate. Set what the block pays before offering it."
    scheds = member_schedules(db, route)
    if not scheds:
        return "This route has no houses in it yet."
    inactive = [s for s in scheds if not s.active]
    if inactive:
        return (f"{len(inactive)} of the houses on this route "
                f"{'is' if len(inactive) == 1 else 'are'} no longer active. "
                "Remove them or reactivate them first.")
    # Without a window there is no share to compute, and a zero share pays
    # nothing at all (payroll's flat-rate branch needs agreed_rate > 0). The
    # Recurring health scan already flags these as `no_time_set`.
    timeless = [s for s in scheds if schedule_minutes(s) is None]
    if timeless:
        names = ", ".join((s.title or f"#{s.id}") for s in timeless[:3])
        return (f"These have no start/end time, so there's no way to split the "
                f"rate fairly: {names}"
                f"{'…' if len(timeless) > 3 else ''}. Set their times first "
                "(the Recurring health check lists them).")
    return None


# ── Lifecycle ───────────────────────────────────────────────────────────────
#
# draft ──offer──▶ offered ──accept──▶ active ──end──▶ ended
#                     │                   │
#                     └──decline──────────┘
#
# OFFERED, NEVER ASSIGNED. This is the same control point as the marketplace
# claim and it is load-bearing for worker classification: a route a sub can
# decline is work they chose. There is deliberately no office path that puts a
# sub on a route without their acceptance — see `offer`, which sets an
# intended owner and a status, and nothing else.


def route_dict(db: Session, route: Route, *, with_members: bool = False) -> dict:
    """Wire shape. Plain dict, never the ORM object."""
    out = {
        "id": route.id,
        "name": route.name,
        "day_of_week": route.day_of_week,
        "owner_cleaner_id": route.owner_cleaner_id,
        "backup_cleaner_id": route.backup_cleaner_id,
        "rate": round(float(route.rate), 2) if route.rate is not None else None,
        "status": route.status,
        "offered_at": route.offered_at.isoformat() if route.offered_at else None,
        "accepted_at": route.accepted_at.isoformat() if route.accepted_at else None,
        "ended_at": route.ended_at.isoformat() if route.ended_at else None,
    }
    scheds = member_schedules(db, route)
    out["member_count"] = len(scheds)
    if with_members:
        shares = shares_by_schedule(db, route)
        out["members"] = [{
            "recurring_schedule_id": s.id,
            "title": s.title or f"#{s.id}",
            "address": getattr(s, "address", None),
            "start_time": s.start_time.isoformat() if s.start_time else None,
            "end_time": s.end_time.isoformat() if s.end_time else None,
            "minutes": schedule_minutes(s),
            "active": bool(s.active),
            # What this house pays the owner per occurrence. Shown next to the
            # block rate so a route is priced with its parts visible rather
            # than as one number somebody has to trust.
            "share": shares.get(s.id),
        } for s in scheds]
        out["blocker"] = validate_offerable(db, route)
    return out


def set_members(db: Session, route: Route, schedule_ids: list, org_id: int) -> None:
    """Replace a route's houses, in the given order.

    Replace rather than merge: the order IS the drive order, and a merge would
    make reordering a separate operation nobody would remember to do. Refuses a
    schedule that already belongs to another route — the unique constraint
    would refuse it anyway, but a 409 naming the other route is a better answer
    than an IntegrityError.
    """
    wanted = [int(i) for i in (schedule_ids or [])]
    if len(set(wanted)) != len(wanted):
        raise ValueError("The same house is listed twice on this route.")

    if wanted:
        found = (db.query(RecurringSchedule)
                 .filter(RecurringSchedule.id.in_(wanted),
                         _org_scope(RecurringSchedule, org_id))
                 .all())
        if len(found) != len(wanted):
            raise ValueError("One of those recurring series doesn't exist here.")
        taken = (db.query(RouteMember)
                 .filter(RouteMember.recurring_schedule_id.in_(wanted),
                         RouteMember.route_id != route.id)
                 .first())
        if taken is not None:
            other = db.query(Route).filter(Route.id == taken.route_id).first()
            raise ValueError(
                f"One of those houses is already on “{other.name if other else 'another route'}”. "
                "A house on two routes means two people are paid for it.")

    db.query(RouteMember).filter(RouteMember.route_id == route.id).delete(
        synchronize_session=False)
    for position, sched_id in enumerate(wanted):
        db.add(RouteMember(org_id=org_id, route_id=route.id,
                           recurring_schedule_id=sched_id, position=position))
    db.flush()


def recent_billing(db: Session, route: Route, org_id: int, *, occurrences: int = 4) -> dict:
    """What this route's houses actually BILLED, against what it pays.

    The margin, from real invoices rather than a list price — recurring
    schedules carry no price of their own, so the only honest source is what
    was charged for the visits these houses generated.

    Averaged over the last few occurrences and reported per occurrence, so it
    compares like with like against `routes.rate` (which is priced per
    occurrence of the whole block). Returns `billed: None` rather than zero
    when nothing has been invoiced yet: "no data" and "billed nothing" are
    different answers, and showing 100% margin for a route nobody has invoiced
    would be worse than showing nothing.
    """
    from database.models import Invoice, Job
    from utils.dates import business_today

    scheds = member_schedules(db, route)
    if not scheds:
        return {"billed": None, "occurrences": 0, "margin": None, "margin_pct": None}

    today = business_today()
    jobs = (db.query(Job)
            .filter(Job.recurring_schedule_id.in_([s.id for s in scheds]),
                    Job.scheduled_date < today,
                    Job.status == "completed",
                    _org_scope(Job, org_id))
            .order_by(Job.scheduled_date.desc())
            .all())
    # Group by date: one occurrence of the block is one day's worth of houses.
    dates, by_date = [], {}
    for j in jobs:
        d = j.scheduled_date
        if d not in by_date:
            if len(dates) >= occurrences:
                continue
            dates.append(d); by_date[d] = []
        by_date[d].append(j.id)
    job_ids = [jid for d in dates for jid in by_date[d]]
    if not job_ids:
        return {"billed": None, "occurrences": 0, "margin": None, "margin_pct": None}

    rows = (db.query(Invoice)
            .filter(Invoice.job_id.in_(job_ids),
                    Invoice.status != "draft",       # a draft isn't money
                    _org_scope(Invoice, org_id))
            .all())
    if not rows:
        return {"billed": None, "occurrences": len(dates), "margin": None, "margin_pct": None}

    total = sum(float(i.total or 0.0) for i in rows)
    per_occurrence = round(total / len(dates), 2)
    rate = float(route.rate or 0.0)
    margin = round(per_occurrence - rate, 2)
    return {
        "billed": per_occurrence,
        "occurrences": len(dates),
        "margin": margin,
        "margin_pct": round(margin / per_occurrence * 100, 1) if per_occurrence else None,
    }


def upcoming_conflicts(db: Session, route: Route, cleaner_id: str, org_id: int,
                       *, horizon_days: int = 28) -> list:
    """Where this cleaner is already booked against the route's own visits.

    Checked against jobs ALREADY GENERATED from the route's schedules rather
    than against dates predicted here — a second implementation of "when does
    this series happen" is the kind of thing that drifts from the first one and
    then quietly disagrees with the calendar.

    Reuses the scheduling module's conflict finder for the same reason: one
    answer to "is this person double-booked", not two.
    """
    from datetime import timedelta

    from database.models import Job
    from modules.scheduling.router import _find_cleaner_conflicts
    from utils.dates import business_today

    scheds = member_schedules(db, route)
    if not scheds or not cleaner_id:
        return []
    today = business_today()
    jobs = (db.query(Job)
            .filter(Job.recurring_schedule_id.in_([s.id for s in scheds]),
                    Job.scheduled_date >= today,
                    Job.scheduled_date <= today + timedelta(days=horizon_days),
                    Job.status.notin_(["cancelled"]),
                    _org_scope(Job, org_id))
            .order_by(Job.scheduled_date)
            .all())
    out = []
    for j in jobs:
        for _cid, other in _find_cleaner_conflicts(
                db, cleaner_ids=[cleaner_id], scheduled_date=j.scheduled_date,
                start_time=j.start_time, end_time=j.end_time,
                exclude_job_id=j.id, org_id=org_id):
            out.append({
                "date": j.scheduled_date.isoformat() if j.scheduled_date else None,
                "route_job_id": j.id,
                "conflicting_job_id": other.id,
                "conflicting_job": (other.title or f"Job #{other.id}"),
            })
    return out


def _org_scope(model, org_id: int):
    from sqlalchemy import or_
    return or_(model.org_id == org_id, model.org_id.is_(None))
