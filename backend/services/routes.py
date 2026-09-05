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
