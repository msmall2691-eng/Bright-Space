"""Phase 3 endpoint test: cross-schedule exceptions list with date-range filter.

Used by the calendar view to overlay skip/reschedule visuals onto the month
grid. The filter intentionally matches either exception_date OR
rescheduled_date so a reschedule that moves a date INTO the visible range
also surfaces, even if its original date is outside.
"""
import pytest
from datetime import date, time, timedelta

from database.db import SessionLocal, engine
from database.models import (
    Base, Client, Property, RecurringSchedule, RecurrenceException,
)


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_test_schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def two_schedules():
    db = SessionLocal()
    client = Client(name="Phase3 Test", phone="+12075559997", phone_tail="2075559997", status="active")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="Phase3 Home", address="3 P3 Ln", property_type="residential")
    db.add(prop); db.commit(); db.refresh(prop)

    today = date.today()
    a = RecurringSchedule(
        client_id=client.id, property_id=prop.id, job_type="residential",
        title="Sched A", address=prop.address, frequency="weekly",
        interval_weeks=1, day_of_week=today.weekday(),
        days_of_week=[today.weekday()], start_time=time(9, 0), end_time=time(11, 0),
        cleaner_ids=[], generate_weeks_ahead=4, active=True,
    )
    b = RecurringSchedule(
        client_id=client.id, property_id=prop.id, job_type="commercial",
        title="Sched B", address=prop.address, frequency="weekly",
        interval_weeks=2, day_of_week=today.weekday(),
        days_of_week=[today.weekday()], start_time=time(13, 0), end_time=time(15, 0),
        cleaner_ids=[], generate_weeks_ahead=4, active=True,
    )
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)

    yield client, prop, a, b

    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id.in_([a.id, b.id])
    ).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == client.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_list_all_exceptions_filters_by_range(two_schedules):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)

    client, prop, a, b = two_schedules
    db = SessionLocal()
    try:
        today = date.today()
        in_range = today + timedelta(days=10)
        out_of_range = today + timedelta(days=200)
        moved_into_range = today + timedelta(days=15)
        original_far = today + timedelta(days=180)

        db.add_all([
            RecurrenceException(recurring_schedule_id=a.id, exception_date=in_range, exception_type="skip"),
            RecurrenceException(recurring_schedule_id=b.id, exception_date=out_of_range, exception_type="skip"),
            RecurrenceException(
                recurring_schedule_id=a.id,
                exception_date=original_far,
                exception_type="reschedule",
                rescheduled_date=moved_into_range,
            ),
        ])
        db.commit()

        date_from = (today - timedelta(days=1)).isoformat()
        date_to = (today + timedelta(days=30)).isoformat()
        r = api.get(f"/api/recurring/exceptions?date_from={date_from}&date_to={date_to}")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert in_range.isoformat() in [row["exception_date"] for row in rows]
        assert any(row["exception_type"] == "reschedule" for row in rows)
        assert not any(row["exception_date"] == out_of_range.isoformat() for row in rows)
    finally:
        db.close()


def test_list_all_exceptions_no_filter_returns_all(two_schedules):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)

    client, prop, a, b = two_schedules
    db = SessionLocal()
    try:
        db.add_all([
            RecurrenceException(recurring_schedule_id=a.id, exception_date=date.today() + timedelta(days=5), exception_type="skip"),
            RecurrenceException(recurring_schedule_id=b.id, exception_date=date.today() + timedelta(days=10), exception_type="skip"),
        ])
        db.commit()

        r = api.get("/api/recurring/exceptions")
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) >= 2
    finally:
        db.close()


def test_list_all_exceptions_rejects_bad_date(two_schedules):
    from fastapi.testclient import TestClient
    from main import app
    api = TestClient(app)
    r = api.get("/api/recurring/exceptions?date_from=not-a-date")
    assert r.status_code == 400
