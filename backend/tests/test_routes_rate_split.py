"""Routes: the block rate reaching the right people, exactly (migration 100).

A route is priced per occurrence of the whole block ("$400 for my Tuesday")
because that is how a sub thinks about it. Payroll pays a flat Job.agreed_rate
once per (job, cleaner), built and tested for the marketplace in 097 — so
generation splits the block rate across that occurrence's jobs. By the time a
route reaches money it is indistinguishable from an approved marketplace job,
which is the point: no payroll change was needed.

Two properties are load-bearing and both are pinned here:

  1. The shares sum EXACTLY to the block rate. $399.99 out of $400 gets
     reported as a bug forever, and rightly.
  2. The split follows TIME, not job count. A 90-minute house and a 3-hour
     house are not the same work.

And one the plan didn't cover: a series with no start/end time has no duration
to weigh, and a zero share pays nothing at all because payroll's flat-rate
branch is gated on `agreed_rate > 0`. Production has such rows — the Recurring
health scan carries a `no_time_set` finding precisely because the model says
NOT NULL and the database disagrees. So a route can't be offered while one of
its houses has no window.
"""
import uuid
from datetime import time

import pytest

from database.db import SessionLocal
from database.models import (
    Client, Job, Property, RecurringSchedule, Route, RouteMember,
)
from services.routes import (
    schedule_minutes, shares_by_schedule, split_rate, validate_offerable,
)


# ── the arithmetic, on its own ───────────────────────────────────────────────

def test_shares_sum_exactly_to_the_block_rate():
    for total, weights in [
        (400, [60, 60, 60, 60]),
        (400, [90, 180, 90, 60]),
        (100, [1, 1, 1]),          # 33.33 / 33.33 / 33.34
        (0.03, [1, 1]),            # smaller than the number of shares
        (399.99, [45, 45, 45]),
    ]:
        shares = split_rate(total, weights)
        assert round(sum(shares), 2) == round(float(total), 2), (total, weights, shares)


def test_the_split_follows_duration_not_job_count():
    # Three houses, one of them twice as long: it earns twice as much.
    assert split_rate(400, [90, 180, 90]) == [100.0, 200.0, 100.0]
    # Same three houses paid evenly would be 133.33 each — the wrong answer.


def test_the_odd_cent_lands_on_the_last_share_not_nowhere():
    shares = split_rate(100, [1, 1, 1])
    assert shares == [33.33, 33.33, 33.34]


def test_equal_weights_when_there_is_nothing_to_weigh_by():
    # Degrades rather than raising — the callers that must not reach this state
    # refuse it earlier, with a message.
    assert split_rate(90, [0, 0, 0]) == [30.0, 30.0, 30.0]
    assert split_rate(400, []) == []


def test_a_window_with_no_length_is_not_a_duration():
    class _S:
        start_time = time(9, 0); end_time = time(10, 30)
    assert schedule_minutes(_S()) == 90
    _S.end_time = _S.start_time
    assert schedule_minutes(_S()) is None      # zero-length
    _S.end_time = time(8, 0)
    assert schedule_minutes(_S()) is None      # inverted
    _S.start_time = None
    assert schedule_minutes(_S()) is None      # the production case


# ── against real rows ────────────────────────────────────────────────────────

@pytest.fixture
def seeded():
    """A route with two houses: 90 minutes and 180 minutes."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Route {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"1 Route Rd {tag}", address=f"1 Route Rd {tag}",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)

    scheds = []
    for i, (start, end) in enumerate([(time(9, 0), time(10, 30)), (time(11, 0), time(14, 0))]):
        s = RecurringSchedule(
            client_id=c.id, property_id=p.id, title=f"House {i} {tag}",
            job_type="residential", frequency="weekly", days_of_week=[1], day_of_week=1,
            start_time=start, end_time=end, active=True, generate_weeks_ahead=4,
            address=f"1 Route Rd {tag}", org_id=1, cleaner_ids=[])
        db.add(s); db.commit(); db.refresh(s)
        scheds.append(s)

    route = Route(name=f"Tuesday {tag}", day_of_week=1, owner_cleaner_id="CT-OWN",
                  backup_cleaner_id="CT-BAK", rate=400.0, status="active", org_id=1)
    db.add(route); db.commit(); db.refresh(route)
    for pos, s in enumerate(scheds):
        db.add(RouteMember(org_id=1, route_id=route.id,
                           recurring_schedule_id=s.id, position=pos))
    db.commit()

    ids = {"client": c.id, "property": p.id, "route": route.id,
           "scheds": [s.id for s in scheds]}
    yield db, route, scheds, ids

    db.query(Job).filter(Job.recurring_schedule_id.in_(ids["scheds"])).delete(synchronize_session=False)
    db.query(RouteMember).filter(RouteMember.route_id == ids["route"]).delete(synchronize_session=False)
    db.query(Route).filter(Route.id == ids["route"]).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id.in_(ids["scheds"])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids["property"]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids["client"]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_shares_follow_the_real_schedule_durations(seeded):
    db, route, scheds, _ = seeded
    shares = shares_by_schedule(db, route)
    # 90 and 180 minutes out of 270, from $400.
    assert shares[scheds[0].id] == 133.33
    assert shares[scheds[1].id] == 266.67
    assert round(sum(shares.values()), 2) == 400.0


def test_generation_assigns_the_owner_prices_the_job_and_never_opens_it(seeded):
    db, route, scheds, _ = seeded
    from modules.recurring.router import generate_jobs
    for s in scheds:
        generate_jobs(db, s)
    db.expire_all()

    jobs = db.query(Job).filter(Job.recurring_schedule_id.in_([s.id for s in scheds])).all()
    assert jobs, "the route's houses should have generated visits"
    for j in jobs:
        assert j.cleaner_ids == ["CT-OWN"], "a route job belongs to the route's owner"
        assert j.open_for_claims is False, "a route job never goes on the open board"
        assert j.agreed_rate in (133.33, 266.67)

    # One occurrence's jobs sum to the block rate — the property that matters
    # to the person being paid.
    by_date = {}
    for j in jobs:
        by_date.setdefault(j.scheduled_date, []).append(j.agreed_rate)
    for date_, rates in by_date.items():
        if len(rates) == len(scheds):
            assert round(sum(rates), 2) == 400.0, f"{date_} paid {sum(rates)}"


def test_a_draft_route_prices_nothing(seeded):
    # Generation ignores anything that isn't active — an unaccepted route must
    # not quietly assign work to the person it was going to be offered to.
    db, route, scheds, _ = seeded
    route.status = "draft"
    db.commit()
    from modules.recurring.router import generate_jobs
    for s in scheds:
        generate_jobs(db, s)
    db.expire_all()
    for j in db.query(Job).filter(Job.recurring_schedule_id.in_([s.id for s in scheds])).all():
        assert j.agreed_rate is None
        assert j.cleaner_ids == []


# ── what stops a route being offered ─────────────────────────────────────────

def test_a_route_with_no_rate_or_no_houses_cannot_be_offered(seeded):
    db, route, scheds, ids = seeded
    assert validate_offerable(db, route) is None      # the seeded route is fine

    route.rate = None
    assert "no rate" in validate_offerable(db, route)
    route.rate = 400.0

    db.query(RouteMember).filter(RouteMember.route_id == ids["route"]).delete(synchronize_session=False)
    db.commit()
    assert "no houses" in validate_offerable(db, route)


def test_a_house_with_no_time_window_blocks_the_offer(seeded, monkeypatch):
    """The gap the plan's duration-proportional split leaves open.

    Such a house has no duration to weigh, so it would take a zero share — and
    a zero agreed_rate pays NOTHING, because payroll's flat-rate branch is
    gated on `> 0`. Somebody would clean that house for free and nothing on any
    screen would say so.

    THE ROW CANNOT BE BUILT HERE, and that is worth stating rather than working
    around quietly. The test database is created from the models, which declare
    start_time/end_time NOT NULL, so SQLite refuses the write. Production's
    schema drifted and does allow it — which is the entire reason the Recurring
    health scan carries a `no_time_set` finding. So the guard is exercised
    through a schedule list that has the production shape, since the only other
    option is a test that can't see the bug class it exists for.
    """
    db, route, scheds, _ = seeded

    class _Timeless:
        id, title, active = scheds[0].id, scheds[0].title, True
        start_time, end_time = None, None

    monkeypatch.setattr("services.routes.member_schedules",
                        lambda _db, _route: [_Timeless(), scheds[1]])

    msg = validate_offerable(db, route)
    assert msg and "no start/end time" in msg
    assert scheds[0].title in msg, "name the houses she has to fix"


def test_an_inactive_house_blocks_the_offer(seeded):
    db, route, scheds, _ = seeded
    scheds[1].active = False
    db.commit()
    assert "no longer active" in validate_offerable(db, route)


def test_route_tables_are_covered_by_row_level_security():
    # Both carry org_id, so they must be in TENANT_TABLES or Postgres enforces
    # nothing on them. 095 exists because two tables sat unprotected for months.
    from database.rls import TENANT_TABLES
    assert "routes" in TENANT_TABLES
    assert "route_members" in TENANT_TABLES
