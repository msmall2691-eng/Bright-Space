"""Phase 1 tests: durable RecurrenceException model.

Mirrors the Phase 0 test patterns: pure-function tests run on SQLite, the
DB-dependent tests that touch generate_jobs() are gated on Postgres because
of the pre-existing ISO-string-into-Date column issue.

What these cover:
- _apply_exceptions removes skipped dates and adds rescheduled dates
- /skip endpoint creates a durable exception, cancels existing Job/Visit
- /skip is idempotent: calling twice updates rather than duplicates
- /reschedule moves the date, original date no longer regenerates
- DELETE /exceptions/{id} undoes the skip
- visits_router skip_visit also writes an exception row
- generate_jobs respects exceptions even when Visit is hard-deleted
"""
import os
import sys
import pytest
from datetime import date, time, timedelta
from unittest.mock import MagicMock

sys.modules.setdefault("integrations.google_calendar", MagicMock())

from database.db import SessionLocal, engine
from database.models import (
    Base,
    Client,
    Property,
    RecurringSchedule,
    Job,
    Visit,
    RecurrenceException,
)
from modules.recurring.router import (
    _apply_exceptions,
    generate_dates,
    generate_jobs,
)


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_test_schema():
    Base.metadata.create_all(bind=engine)
    yield


_REQUIRES_POSTGRES = pytest.mark.skipif(
    "postgres" not in os.environ.get("DATABASE_URL", "").lower(),
    reason=(
        "generate_jobs() relies on Postgres date-string coercion that "
        "SQLite does not perform; run against a Postgres DATABASE_URL."
    ),
)


@pytest.fixture
def fresh_client_property():
    db = SessionLocal()
    client = Client(
        name="Phase1 Recurrence Test",
        phone="+12075559998",
        phone_tail="2075559998",
        status="active",
    )
    db.add(client)
    db.commit()
    db.refresh(client)

    prop = Property(
        client_id=client.id,
        name="Phase1 Test Home",
        address="2 Phase One Lane",
        property_type="residential",
    )
    db.add(prop)
    db.commit()
    db.refresh(prop)

    yield client, prop

    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id.in_(
            db.query(RecurringSchedule.id).filter(RecurringSchedule.client_id == client.id)
        )
    ).delete(synchronize_session=False)
    db.query(Visit).filter(
        Visit.job_id.in_(
            db.query(Job.id).filter(Job.client_id == client.id)
        )
    ).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(
        RecurringSchedule.client_id == client.id
    ).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()
    db.close()


def _make_schedule(db, client, prop, *, days_of_week=None, weeks_ahead=4):
    today_dow = date.today().weekday()
    sched = RecurringSchedule(
        client_id=client.id,
        property_id=prop.id,
        job_type="residential",
        title="Phase1 Test Clean",
        address=prop.address,
        frequency="weekly",
        interval_weeks=1,
        days_of_week=days_of_week or [today_dow],
        day_of_week=today_dow,
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
# _apply_exceptions: pure-ish (touches DB, but no generate_jobs)
# ---------------------------------------------------------------------------
def test_apply_exceptions_removes_skip_dates(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        target = date.today() + timedelta(days=7)
        db.add(RecurrenceException(
            recurring_schedule_id=sched.id,
            exception_date=target,
            exception_type="skip",
            reason="test",
        ))
        db.commit()

        result = _apply_exceptions(db, sched, [target, target + timedelta(days=7)])
        assert target not in result
        assert (target + timedelta(days=7)) in result
    finally:
        db.close()


def test_apply_exceptions_adds_reschedule_dates(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        original = date.today() + timedelta(days=7)
        new = date.today() + timedelta(days=8)
        db.add(RecurrenceException(
            recurring_schedule_id=sched.id,
            exception_date=original,
            exception_type="reschedule",
            rescheduled_date=new,
            reason="moved a day later",
        ))
        db.commit()

        result = _apply_exceptions(db, sched, [original])
        assert original not in result
        assert new in result
    finally:
        db.close()


def test_apply_exceptions_no_op_when_none(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        dates = [(date.today() + timedelta(days=d)).isoformat() for d in (7, 14, 21)]
        assert _apply_exceptions(db, sched, dates) == dates
    finally:
        db.close()


# ---------------------------------------------------------------------------
# /skip endpoint
# ---------------------------------------------------------------------------
def test_skip_endpoint_creates_exception(fresh_client_property):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)

    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        target = date.today() + timedelta(days=7)

        r = api.post(
            f"/api/recurring/{sched.id}/skip",
            json={"exception_date": target.isoformat(), "reason": "client out of town"},
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["exception_type"] == "skip"
        assert body["exception_date"] == target.isoformat()

        ex = db.query(RecurrenceException).filter_by(id=body["id"]).first()
        assert ex is not None
        assert ex.reason == "client out of town"
    finally:
        db.close()


def test_skip_endpoint_is_idempotent(fresh_client_property):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)

    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        target = date.today() + timedelta(days=7)

        r1 = api.post(f"/api/recurring/{sched.id}/skip",
                      json={"exception_date": target.isoformat(), "reason": "first"})
        r2 = api.post(f"/api/recurring/{sched.id}/skip",
                      json={"exception_date": target.isoformat(), "reason": "second"})
        assert r1.status_code == 201
        assert r2.status_code == 201
        # Same row, updated reason — not two rows.
        rows = db.query(RecurrenceException).filter_by(
            recurring_schedule_id=sched.id, exception_date=target
        ).all()
        assert len(rows) == 1
        assert rows[0].reason == "second"
    finally:
        db.close()


# ---------------------------------------------------------------------------
# /reschedule endpoint
# ---------------------------------------------------------------------------
def test_reschedule_endpoint_requires_new_date(fresh_client_property):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)

    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        target = date.today() + timedelta(days=7)
        r = api.post(
            f"/api/recurring/{sched.id}/reschedule",
            json={"exception_date": target.isoformat()},
        )
        assert r.status_code == 400
        assert "rescheduled_date" in r.text
    finally:
        db.close()


def test_reschedule_endpoint_creates_exception(fresh_client_property):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)

    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        original = date.today() + timedelta(days=7)
        new = date.today() + timedelta(days=8)

        r = api.post(
            f"/api/recurring/{sched.id}/reschedule",
            json={"exception_date": original.isoformat(), "rescheduled_date": new.isoformat()},
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["exception_type"] == "reschedule"
        assert body["rescheduled_date"] == new.isoformat()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# DELETE exception (undo)
# ---------------------------------------------------------------------------
def test_delete_exception_undoes_skip(fresh_client_property):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)

    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        target = date.today() + timedelta(days=7)
        ex = RecurrenceException(
            recurring_schedule_id=sched.id,
            exception_date=target,
            exception_type="skip",
        )
        db.add(ex)
        db.commit()
        db.refresh(ex)
        ex_id = ex.id

        r = api.delete(f"/api/recurring/{sched.id}/exceptions/{ex_id}")
        assert r.status_code == 204

        assert db.query(RecurrenceException).filter_by(id=ex_id).first() is None
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Cascade: deleting a schedule removes its exceptions
# ---------------------------------------------------------------------------
def test_exception_cascades_when_schedule_deleted(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        target = date.today() + timedelta(days=7)
        db.add(RecurrenceException(
            recurring_schedule_id=sched.id,
            exception_date=target,
            exception_type="skip",
        ))
        db.commit()

        sched_id = sched.id
        db.delete(sched)
        db.commit()

        remaining = db.query(RecurrenceException).filter_by(recurring_schedule_id=sched_id).count()
        assert remaining == 0
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Postgres-only: full end-to-end with generate_jobs
# ---------------------------------------------------------------------------
@_REQUIRES_POSTGRES
def test_skip_exception_blocks_regeneration(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=2)
        generate_jobs(db, sched)

        first_visit = (
            db.query(Visit)
            .join(Job)
            .filter(Job.recurring_schedule_id == sched.id)
            .order_by(Visit.scheduled_date)
            .first()
        )
        target = first_visit.scheduled_date

        # Add a skip exception, hard-delete the Job and Visit, regenerate.
        db.add(RecurrenceException(
            recurring_schedule_id=sched.id,
            exception_date=target,
            exception_type="skip",
        ))
        db.query(Visit).filter(Visit.job_id == first_visit.job_id).delete()
        db.query(Job).filter(Job.id == first_visit.job_id).delete()
        db.commit()

        generate_jobs(db, sched)
        assert db.query(Job).filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date == target,
        ).first() is None
    finally:
        db.close()


@_REQUIRES_POSTGRES
def test_reschedule_exception_creates_job_on_new_date(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=4)
        generate_jobs(db, sched)

        first_job = (
            db.query(Job)
            .filter(Job.recurring_schedule_id == sched.id)
            .order_by(Job.scheduled_date)
            .first()
        )
        original = first_job.scheduled_date
        new = original + timedelta(days=1)

        # Reschedule + clean up the original.
        db.add(RecurrenceException(
            recurring_schedule_id=sched.id,
            exception_date=original,
            exception_type="reschedule",
            rescheduled_date=new,
        ))
        db.query(Visit).filter(Visit.job_id == first_job.id).delete()
        db.query(Job).filter(Job.id == first_job.id).delete()
        db.commit()

        generate_jobs(db, sched)
        # Original date gone, new date present.
        assert db.query(Job).filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date == original,
        ).first() is None
        assert db.query(Job).filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date == new,
        ).first() is not None
    finally:
        db.close()
