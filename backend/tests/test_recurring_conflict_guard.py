"""Cleaner conflict/capacity guard on recurring-series creation
(modules/recurring/router.py's create_schedule).

Before this, POST /api/recurring never checked whether an assigned cleaner
was already double-booked, on approved time off, or over capacity — that
logic existed for one-off jobs (scheduling.create_job) but a recurring
series would just silently drop the conflicting cleaner from whichever
occurrence collided, days later, at generate_jobs() time, with nothing but
a server log to explain the gap. This mirrors the one-off job's guard:
checked against the nearest date the requested cadence would actually land
on, 409s with the same detail shape, overridable with allow_conflicts=true
(matching allow_duplicate's existing escape-hatch convention on this same
endpoint).
"""
import uuid
from datetime import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, RecurringSchedule
from utils.dates import business_today

api = TestClient(app)


@pytest.fixture(autouse=True)
def _no_gcal_push():
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


@pytest.fixture
def seeded():
    db = SessionLocal()
    c = Client(name=f"ConflictGuard {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Conflict Home", address="22 Birch Ln",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    cleaner_id = f"CT-{uuid.uuid4().hex[:6]}"
    today = business_today()
    # Existing booking for this cleaner on the date the test payload below
    # will compute as its "next likely occurrence" (days_of_week=[today's
    # weekday] makes that date deterministically today).
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title="Existing booking", scheduled_date=today,
            start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=[cleaner_id], status="scheduled",
            # _find_cleaner_conflicts scopes strictly by org_id (int) when the
            # caller resolves one — the TestClient's synthetic admin resolves
            # to org 1, so this needs to match or the guard can't see the job.
            org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    yield db, c, p, cleaner_id, today
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _payload(client, prop, cleaner_id, today, **overrides):
    payload = {
        "client_id": client.id, "job_type": "residential", "title": "New Series",
        "address": prop.address, "frequency": "weekly", "interval_weeks": 1,
        "days_of_week": [today.weekday()],
        "start_time": "10:00", "end_time": "12:00",  # overlaps the 09:00-11:00 booking
        "cleaner_ids": [cleaner_id], "property_id": prop.id, "generate_weeks_ahead": 4,
    }
    payload.update(overrides)
    return payload


def test_double_booked_cleaner_409s(seeded):
    db, c, p, cleaner_id, today = seeded
    r = api.post("/api/recurring", json=_payload(c, p, cleaner_id, today))
    assert r.status_code == 409, r.text
    assert "conflict" in r.json()["detail"].lower()
    assert db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).count() == 0


def test_allow_conflicts_overrides_the_guard(seeded):
    db, c, p, cleaner_id, today = seeded
    r = api.post("/api/recurring", json=_payload(c, p, cleaner_id, today, allow_conflicts=True))
    assert r.status_code == 201, r.text
    assert db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).count() == 1


def test_non_overlapping_time_passes(seeded):
    """Same day, same cleaner, but the time windows don't actually overlap —
    no conflict, no override needed."""
    db, c, p, cleaner_id, today = seeded
    r = api.post("/api/recurring", json=_payload(
        c, p, cleaner_id, today, start_time="13:00", end_time="15:00"))
    assert r.status_code == 201, r.text


def test_unassigned_series_skips_the_guard(seeded):
    """No cleaner picked yet — nothing to check, and the series must still be
    creatable exactly as it always was before this guard existed."""
    db, c, p, cleaner_id, today = seeded
    r = api.post("/api/recurring", json=_payload(c, p, cleaner_id, today, cleaner_ids=[]))
    assert r.status_code == 201, r.text
