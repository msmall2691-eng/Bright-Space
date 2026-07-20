"""Codex P1: dragging a recurring occurrence used to route through
/api/recurring/{id}/reschedule with NO double-booking check — unlike the
one-time job PATCH — so a recurring drag could silently double-book a cleaner.
The interactive reschedule now runs the same conflict guard, overridable with
allow_conflicts (the "Reschedule anyway" path). Bulk callers keep the
permissive default.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal, engine
from database.models import Base, Client, Property, RecurringSchedule, Job

api = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def _schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def sched_with_cleaner():
    db = SessionLocal()
    c = Client(name=f"ReschedConf {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Home", address="9 Conflict Rd",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, job_type="residential",
        title="Weekly clean", address=p.address, frequency="weekly", interval_weeks=1,
        days_of_week=[0], day_of_week=0, start_time=time(9, 0), end_time=time(11, 0),
        cleaner_ids=["c1"], generate_weeks_ahead=8, active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    yield db, c, p, sched
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    from database.models import RecurrenceException
    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id == sched.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id == sched.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _blocker(db, client, prop, target, cleaner="c1"):
    """A separate job that books `cleaner` 9–11 on the target date."""
    j = Job(client_id=client.id, property_id=prop.id, job_type="residential",
            title="Existing booking", scheduled_date=target,
            start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=[cleaner], status="scheduled")
    db.add(j); db.commit(); db.refresh(j)
    return j


def test_recurring_reschedule_409s_on_cleaner_conflict(sched_with_cleaner):
    db, c, p, sched = sched_with_cleaner
    source = date.today() + timedelta(days=7)
    target = date.today() + timedelta(days=10)
    _blocker(db, c, p, target)  # c1 already booked 9–11 on target

    r = api.post(f"/api/recurring/{sched.id}/reschedule", json={
        "exception_date": source.isoformat(),
        "rescheduled_date": target.isoformat(),
    })
    assert r.status_code == 409, r.text
    assert "conflict" in r.text.lower()


def test_allow_conflicts_overrides_the_guard(sched_with_cleaner):
    db, c, p, sched = sched_with_cleaner
    source = date.today() + timedelta(days=7)
    target = date.today() + timedelta(days=10)
    _blocker(db, c, p, target)

    r = api.post(f"/api/recurring/{sched.id}/reschedule", json={
        "exception_date": source.isoformat(),
        "rescheduled_date": target.isoformat(),
        "allow_conflicts": True,
    })
    assert r.status_code == 201, r.text


def test_no_conflict_when_cleaner_is_free(sched_with_cleaner):
    db, c, p, sched = sched_with_cleaner
    source = date.today() + timedelta(days=7)
    target = date.today() + timedelta(days=10)
    _blocker(db, c, p, target, cleaner="someone_else")  # different cleaner → no clash

    r = api.post(f"/api/recurring/{sched.id}/reschedule", json={
        "exception_date": source.isoformat(),
        "rescheduled_date": target.isoformat(),
    })
    assert r.status_code == 201, r.text
