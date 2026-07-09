"""POST /api/jobs/bulk-reschedule — the "weather day" / sick-day move
(Tier 4 roadmap): select a set of jobs, shift them all by N days in one
action instead of dragging each one individually.

Recurring occurrences must go through the same reschedule-exception path
as a single "this visit only" edit (_reschedule_occurrence, factored out of
modules/recurring/router.py's add_reschedule_exception) rather than a bare
scheduled_date PATCH — otherwise the next generate_jobs tick would
regenerate the original date alongside the shifted one.
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Property, Job, RecurringSchedule, RecurrenceException, Activity,
)

api = TestClient(app)
OTHER_ORG = 99999


@pytest.fixture(autouse=True)
def _no_gcal_push():
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


@pytest.fixture
def seeded():
    db = SessionLocal()
    c = Client(name=f"BulkReschedule {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Bulk Home", address="1 Bulk Way",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id.in_(
            db.query(RecurringSchedule.id).filter(RecurringSchedule.client_id == c.id)
        )
    ).delete(synchronize_session=False)
    db.query(Activity).filter(
        Activity.job_id.in_(db.query(Job.id).filter(Job.client_id == c.id))
    ).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _make_job(db, c, p, sched_date, status="scheduled", recurring_schedule_id=None):
    j = Job(client_id=c.id, property_id=p.id, title="Bulk Job", job_type="residential",
            scheduled_date=sched_date, start_time=time(9, 0), end_time=time(11, 0),
            status=status, recurring_schedule_id=recurring_schedule_id)
    db.add(j); db.commit(); db.refresh(j)
    return j


def test_shift_non_recurring_jobs_forward(seeded):
    db, c, p = seeded
    j1 = _make_job(db, c, p, date(2026, 8, 1))
    j2 = _make_job(db, c, p, date(2026, 8, 1))

    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j1.id, j2.id], "shift_days": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["shifted"] == 2
    assert set(body["shifted_ids"]) == {j1.id, j2.id}
    assert body["skipped"] == []

    db.refresh(j1); db.refresh(j2)
    assert j1.scheduled_date == date(2026, 8, 3)
    assert j2.scheduled_date == date(2026, 8, 3)


def test_shift_backward(seeded):
    db, c, p = seeded
    j = _make_job(db, c, p, date(2026, 8, 10))
    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": -3})
    assert r.status_code == 200, r.text
    db.refresh(j)
    assert j.scheduled_date == date(2026, 8, 7)


def test_shift_skips_cancelled_and_completed(seeded):
    db, c, p = seeded
    cancelled = _make_job(db, c, p, date(2026, 8, 1), status="cancelled")
    completed = _make_job(db, c, p, date(2026, 8, 1), status="completed")
    scheduled = _make_job(db, c, p, date(2026, 8, 1))

    r = api.post("/api/jobs/bulk-reschedule",
                 json={"job_ids": [cancelled.id, completed.id, scheduled.id], "shift_days": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["shifted"] == 1
    assert body["shifted_ids"] == [scheduled.id]
    skipped_ids = {s["job_id"] for s in body["skipped"]}
    assert skipped_ids == {cancelled.id, completed.id}

    db.refresh(cancelled); db.refresh(completed)
    assert cancelled.scheduled_date == date(2026, 8, 1)
    assert completed.scheduled_date == date(2026, 8, 1)


def test_shift_recurring_occurrence_writes_exception_not_bare_patch(seeded):
    """A recurring job's date move must go through the exception path — a
    bare scheduled_date PATCH would let the next generate_jobs tick
    regenerate the original date, duplicating the occurrence."""
    db, c, p = seeded
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, job_type="residential", title="Weekly clean",
        address=p.address, frequency="weekly", day_of_week=5, days_of_week=[5],
        start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=[], active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    occurrence_date = date(2026, 8, 1)  # a Saturday
    j = _make_job(db, c, p, occurrence_date, recurring_schedule_id=sched.id)

    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["shifted"] == 1
    assert body["skipped"] == []

    # An exception now exists recording the move.
    ex = db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id == sched.id,
        RecurrenceException.exception_date == occurrence_date,
    ).first()
    assert ex is not None
    assert ex.exception_type == "reschedule"
    assert ex.rescheduled_date == date(2026, 8, 2)

    # The original job is cancelled (not left dangling on the old date), and
    # a new job exists on the shifted date.
    db.refresh(j)
    assert j.status == "cancelled"
    new_job = db.query(Job).filter(
        Job.recurring_schedule_id == sched.id,
        Job.scheduled_date == date(2026, 8, 2),
        Job.status != "cancelled",
    ).first()
    assert new_job is not None
    assert new_job.start_time == time(9, 0)


def test_shift_zero_days_rejected(seeded):
    db, c, p = seeded
    j = _make_job(db, c, p, date(2026, 8, 1))
    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": 0})
    assert r.status_code == 400


def test_shift_empty_job_ids_rejected():
    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [], "shift_days": 1})
    assert r.status_code == 400


def test_shift_cross_org_job_is_not_found(seeded):
    db, c, p = seeded
    other_client = Client(name="Other Org Client", status="active", org_id=OTHER_ORG)
    db.add(other_client); db.commit(); db.refresh(other_client)
    other_prop = Property(client_id=other_client.id, name="Other Prop", address="9 Other Way",
                          property_type="residential", active=True, org_id=OTHER_ORG)
    db.add(other_prop); db.commit(); db.refresh(other_prop)
    other_job = Job(client_id=other_client.id, property_id=other_prop.id, title="Other Org Job",
                    job_type="residential", scheduled_date=date(2026, 8, 1),
                    start_time=time(9, 0), end_time=time(11, 0), status="scheduled",
                    org_id=OTHER_ORG)
    db.add(other_job); db.commit(); db.refresh(other_job)
    try:
        r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [other_job.id], "shift_days": 1})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["shifted"] == 0
        assert body["skipped"][0]["job_id"] == other_job.id
        assert body["skipped"][0]["reason"] == "not found"
        db.refresh(other_job)
        assert other_job.scheduled_date == date(2026, 8, 1)
    finally:
        db.query(Job).filter(Job.id == other_job.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == other_prop.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == other_client.id).delete(synchronize_session=False)
        db.commit()
