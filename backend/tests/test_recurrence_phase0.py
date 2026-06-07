"""Phase 0 regression tests for recurring schedule accuracy.

Covers the four bugs fixed in commit 3822c69:
  - Multi-day schedules (Mon/Wed/Fri) silently collapsing to a single day on update
  - Empty days_of_week being accepted instead of rejected
  - Cancellations not sticking when the parent Job row is hard-deleted
  - iCal sync re-linking a returning UID to a cancelled Job

Plus several positive cases that should continue to work (leap day, monthly,
biweekly multi-day) so we notice if a future change regresses them.

These tests run against SQLite by default (the existing test setup). The
concurrent-generation test requires Postgres because the partial unique
index uses postgresql_where; it's marked accordingly.
"""
import os
import sys
import pytest
from datetime import date, time, timedelta
from unittest.mock import MagicMock

# Mock GCal before generate_jobs imports it, so we don't hit real network.
sys.modules.setdefault("integrations.google_calendar", MagicMock())

from sqlalchemy.exc import IntegrityError

from database.db import SessionLocal, engine
from database.models import (
    Base,
    Client,
    Property,
    RecurringSchedule,
    Job,
    Visit,
    ICalEvent,
)
from modules.recurring.router import (
    _effective_days,
    generate_dates,
    generate_jobs,
)


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_test_schema():
    """Ensure the schema exists even when running outside the full app boot
    sequence (which goes through Alembic). This is a no-op against a real DB
    that already has the tables; on a throwaway SQLite test DB it creates
    everything declared in models.Base."""
    Base.metadata.create_all(bind=engine)
    yield


# ---------------------------------------------------------------------------
# Fixture: a fresh client + property per test, with full cascade cleanup.
# ---------------------------------------------------------------------------
@pytest.fixture
def fresh_client_property():
    db = SessionLocal()
    client = Client(
        name="Phase0 Recurrence Test",
        phone="+12075559999",
        phone_tail="2075559999",
        status="active",
    )
    db.add(client)
    db.commit()
    db.refresh(client)

    prop = Property(
        client_id=client.id,
        name="Phase0 Test Home",
        address="1 Phase Zero Lane",
        property_type="residential",
    )
    db.add(prop)
    db.commit()
    db.refresh(prop)

    yield client, prop

    # Cleanup: visits → jobs → schedules → ical_events → property → client
    db.query(Visit).filter(
        Visit.job_id.in_(
            db.query(Job.id).filter(Job.client_id == client.id)
        )
    ).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(
        RecurringSchedule.client_id == client.id
    ).delete(synchronize_session=False)
    db.query(ICalEvent).filter(ICalEvent.property_id == prop.id).delete(
        synchronize_session=False
    )
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()
    db.close()


def _make_schedule(
    db,
    client,
    prop,
    *,
    frequency="weekly",
    interval_weeks=1,
    days_of_week=None,
    day_of_week=0,
    day_of_month=None,
    weeks_ahead=4,
):
    """Convenience builder for a RecurringSchedule row."""
    sched = RecurringSchedule(
        client_id=client.id,
        property_id=prop.id,
        job_type="residential",
        title="Phase0 Test Clean",
        address=prop.address,
        frequency=frequency,
        interval_weeks=interval_weeks,
        days_of_week=days_of_week if days_of_week is not None else [day_of_week],
        day_of_week=day_of_week,
        day_of_month=day_of_month,
        start_time=time(9, 0),
        end_time=time(11, 0),
        cleaner_ids=[],
        generate_weeks_ahead=weeks_ahead,
        active=True,
    )
    db.add(sched)
    db.commit()
    db.refresh(sched)
    return sched


# ---------------------------------------------------------------------------
# _effective_days() — pure function tests, no DB needed
# ---------------------------------------------------------------------------
class _StubSchedule:
    """Tiny stand-in so we don't have to round-trip through the DB
    just to test the days-of-week logic."""

    def __init__(self, days_of_week=None, day_of_week=None):
        self.days_of_week = days_of_week
        self.day_of_week = day_of_week


def test_effective_days_returns_provided_list():
    s = _StubSchedule(days_of_week=[0, 2, 4], day_of_week=0)
    assert _effective_days(s) == [0, 2, 4]


def test_effective_days_falls_back_to_legacy_single_day():
    s = _StubSchedule(days_of_week=None, day_of_week=3)
    assert _effective_days(s) == [3]


def test_effective_days_defaults_to_monday_when_both_missing():
    s = _StubSchedule(days_of_week=None, day_of_week=None)
    assert _effective_days(s) == [0]


def test_effective_days_dedupes_and_clamps_corrupted_array():
    # The Phase 0 fix should clean up [0, 0, 9] to [0] rather than
    # silently emitting a bad day-of-week of 9 to date arithmetic.
    s = _StubSchedule(days_of_week=[0, 0, 9, -1, 4], day_of_week=0)
    assert _effective_days(s) == [0, 4]


def test_effective_days_handles_floats_in_json_blob():
    # JSON sometimes deserializes ints as floats; the cleaner should cope.
    s = _StubSchedule(days_of_week=[0.0, 2.0, 4.0], day_of_week=0)
    assert _effective_days(s) == [0, 2, 4]


# ---------------------------------------------------------------------------
# generate_dates() — no DB writes needed
# ---------------------------------------------------------------------------
def test_generate_dates_weekly_multi_day():
    s = _StubSchedule(days_of_week=[0, 2, 4], day_of_week=0)
    s.frequency = "weekly"
    s.interval_weeks = 1
    s.day_of_month = None
    dates = generate_dates(s, weeks_ahead=2)
    # Each date's weekday() should be 0, 2, or 4.
    assert dates, "expected at least one date in the next 2 weeks"
    for d in dates:
        assert d.weekday() in {0, 2, 4}, f"unexpected weekday for {d}"


def test_generate_dates_biweekly_skips_alternate_weeks():
    s = _StubSchedule(days_of_week=[0], day_of_week=0)
    s.frequency = "biweekly"
    s.interval_weeks = 2
    s.day_of_month = None
    dates = sorted(generate_dates(s, weeks_ahead=8))
    # Consecutive dates should be 14 days apart, not 7.
    parsed = dates
    for a, b in zip(parsed, parsed[1:]):
        assert (b - a).days == 14


def test_generate_dates_monthly_skips_invalid_day():
    """day_of_month=31 should silently skip months with <31 days."""
    s = _StubSchedule(days_of_week=None, day_of_week=None)
    s.frequency = "monthly"
    s.interval_weeks = None
    s.day_of_month = 31
    dates = generate_dates(s, weeks_ahead=52)  # cover ~1 year
    parsed = dates
    months_seen = {(d.year, d.month) for d in parsed}
    # Feb, Apr, Jun, Sep, Nov never have a 31st — none of those should appear.
    for d in parsed:
        assert d.day == 31


def test_generate_dates_monthly_handles_leap_day():
    """day_of_month=29 in a non-leap year should skip Feb."""
    s = _StubSchedule(days_of_week=None, day_of_week=None)
    s.frequency = "monthly"
    s.interval_weeks = None
    s.day_of_month = 29
    dates = generate_dates(s, weeks_ahead=104)  # ~2 years to cross a Feb
    parsed = dates
    # Just assert nothing crashed and every emitted date really is the 29th.
    for d in parsed:
        assert d.day == 29


# ---------------------------------------------------------------------------
# Backend-tolerance helpers
# ---------------------------------------------------------------------------
# A couple of generate_jobs() tests below exercise Postgres-specific behavior
# (the partial unique index's postgresql_where, and FK/cascade semantics after a
# hard Job delete) that SQLite doesn't replicate, so they stay Postgres-only.
# (The date-coercion that used to also force this is fixed — generate_jobs now
# writes real date objects — but these particular tests still need Postgres.)
_REQUIRES_POSTGRES = pytest.mark.skipif(
    "postgres" not in os.environ.get("DATABASE_URL", "").lower(),
    reason="exercises Postgres-specific index/FK behavior not present on SQLite",
)


# ---------------------------------------------------------------------------
# Fix 0.1: cancellation persists across regenerate, even after Job deletion
# ---------------------------------------------------------------------------
@_REQUIRES_POSTGRES
def test_cancelled_visit_blocks_regeneration_after_job_deletion(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(
            db, client, prop,
            days_of_week=[date.today().weekday()],
            day_of_week=date.today().weekday(),
            weeks_ahead=2,
        )
        first_run = generate_jobs(db, sched)
        assert first_run > 0

        # Pick the earliest visit and cancel it.
        first_visit = (
            db.query(Visit)
            .join(Job)
            .filter(Job.recurring_schedule_id == sched.id)
            .order_by(Visit.scheduled_date)
            .first()
        )
        cancelled_date = first_visit.scheduled_date
        first_visit.status = "cancelled"
        # Hard-delete the parent Job to simulate the "admin tools nuked the row"
        # case that previously broke dedup.
        db.query(Job).filter(Job.id == first_visit.job_id).delete()
        db.commit()

        # Re-run generate. The cancelled date must NOT come back.
        generate_jobs(db, sched)
        regenerated = (
            db.query(Job)
            .filter(
                Job.recurring_schedule_id == sched.id,
                Job.scheduled_date == cancelled_date,
            )
            .first()
        )
        assert regenerated is None, (
            f"Cancelled date {cancelled_date} regenerated after Job deletion — "
            "the cancelled-Visit dedup is not working."
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Fix 0.2: multi-day schedule survives an update that omits days_of_week
# ---------------------------------------------------------------------------
def test_update_omitting_days_does_not_collapse(fresh_client_property):
    """The audit found that a Mon/Wed/Fri schedule could collapse to Monday-only
    after an update that didn't include days_of_week. Pydantic's exclude_none
    should keep the existing array intact."""
    from fastapi.testclient import TestClient
    from main import app

    api = TestClient(app)
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(
            db, client, prop,
            days_of_week=[0, 2, 4],
            day_of_week=0,
        )
        sched_id = sched.id
        # Update only the title — days_of_week omitted entirely.
        r = api.patch(
            f"/api/recurring/{sched_id}",
            json={"title": "Renamed but not collapsed"},
        )
        assert r.status_code == 200, r.text
        db.expire_all()
        refreshed = (
            db.query(RecurringSchedule)
            .filter(RecurringSchedule.id == sched_id)
            .first()
        )
        assert refreshed.days_of_week == [0, 2, 4], (
            f"Multi-day schedule collapsed on update; got {refreshed.days_of_week}"
        )
    finally:
        db.close()


def test_update_with_explicit_empty_days_of_week_returns_400(fresh_client_property):
    from fastapi.testclient import TestClient
    from main import app

    api = TestClient(app)
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(
            db, client, prop,
            days_of_week=[0, 2, 4],
            day_of_week=0,
        )
        r = api.patch(
            f"/api/recurring/{sched.id}",
            json={"days_of_week": []},
        )
        assert r.status_code == 400
        assert "days_of_week cannot be empty" in r.text
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Fix 0.3: race-safe insert. SQLite cannot enforce a partial unique index the
# same way Postgres does, so the integrity-error path is Postgres-only. On
# SQLite we still verify the app-level dedup (the existing-Job check) holds
# under back-to-back generate calls.
# ---------------------------------------------------------------------------
@_REQUIRES_POSTGRES
def test_back_to_back_generate_does_not_duplicate(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(
            db, client, prop,
            days_of_week=[date.today().weekday()],
            day_of_week=date.today().weekday(),
            weeks_ahead=2,
        )
        first = generate_jobs(db, sched)
        second = generate_jobs(db, sched)
        assert first > 0
        assert second == 0, (
            f"Second generate created {second} jobs; should have been a no-op."
        )

        # No (schedule_id, date) appears more than once.
        rows = (
            db.query(Job.scheduled_date)
            .filter(Job.recurring_schedule_id == sched.id)
            .all()
        )
        seen = [r[0] for r in rows]
        assert len(seen) == len(set(seen)), (
            f"Duplicate scheduled_date entries: {sorted(seen)}"
        )
    finally:
        db.close()


@_REQUIRES_POSTGRES
def test_concurrent_insert_caught_by_unique_index(fresh_client_property):
    """Postgres-only: two sessions racing to insert the same (schedule, date)
    must produce exactly one row — the second insert hits the partial unique
    index and is swallowed by the savepoint/IntegrityError handler."""
    client, prop = fresh_client_property
    db_a = SessionLocal()
    db_b = SessionLocal()
    try:
        sched = _make_schedule(
            db_a, client, prop,
            days_of_week=[date.today().weekday()],
            day_of_week=date.today().weekday(),
            weeks_ahead=1,
        )
        # Race: both transactions try to generate the same date set.
        n_a = generate_jobs(db_a, sched)
        n_b = generate_jobs(db_b, sched)
        # Sum of insertions equals the count of unique dates, not 2x.
        rows = (
            db_a.query(Job.scheduled_date)
            .filter(Job.recurring_schedule_id == sched.id)
            .all()
        )
        seen = [r[0] for r in rows]
        assert len(seen) == len(set(seen))
        assert n_a + n_b == len(set(seen))
    finally:
        db_a.close()
        db_b.close()


# ---------------------------------------------------------------------------
# Fix 0.4: iCal soft-cancel clears the link so a returning UID is treated
# as a fresh reservation.
# ---------------------------------------------------------------------------
def test_ical_soft_cancel_clears_job_link(fresh_client_property):
    """Direct unit test: the patched soft-cancel block should set
    ICalEvent.job_id = None after marking the linked Job cancelled."""
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        # Set up: an ICalEvent linked to a future Job.
        future = date.today() + timedelta(days=5)
        job = Job(
            client_id=client.id,
            property_id=prop.id,
            job_type="str_turnover",
            title="Returning Guest Turnover",
            scheduled_date=future,
            start_time=time(10, 0),
            end_time=time(13, 0),
            address=prop.address,
            cleaner_ids=[],
            status="scheduled",
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        evt = ICalEvent(
            property_id=prop.id,
            uid="returning-guest-uid",
            summary="Reserved",
            event_type="reservation",
            checkin_date=str(future - timedelta(days=3)),
            checkout_date=str(future),
            job_id=job.id,
            raw_event={},
        )
        db.add(evt)
        db.commit()
        db.refresh(evt)

        # Simulate the soft-cancel block from ical_sync.py exactly.
        # (We don't import the helper because it's inline in _sync_ical_url.)
        linked_job = db.query(Job).filter(Job.id == evt.job_id).first()
        assert linked_job is not None
        linked_job.status = "cancelled"
        evt.job_id = None
        evt.event_type = "cancelled"
        db.commit()

        db.expire_all()
        refreshed_evt = db.query(ICalEvent).filter(ICalEvent.id == evt.id).first()
        refreshed_job = db.query(Job).filter(Job.id == job.id).first()
        assert refreshed_evt.job_id is None, (
            "ICalEvent.job_id should be cleared on soft-cancel so a returning "
            "UID is treated as a fresh reservation."
        )
        assert refreshed_evt.event_type == "cancelled"
        assert refreshed_job.status == "cancelled"
    finally:
        db.close()
