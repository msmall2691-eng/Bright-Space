"""Unassigned recurring visits go on the bench — SCOPED to opted-in customers.

Owner decision (Sept 2026), then scoped (migration 122): a repeating visit that
generates with no cleaner is offered to the crew board ONLY when its customer is
opted in (Client.recurring_open_to_crew). Opted-in → open_for_claims=True, open
to everyone, still an offer (sub requests, office approves). Not opted in → the
occurrence generates unassigned-and-hidden, exactly as before. An ASSIGNED
occurrence is never posted, opted in or not; route occurrences never hit the
board.
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
    c = Client(name=f"OpenRec {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Rec Home", address="9 Maple Way",
                 property_type="residential", active=True, default_price=120.0)
    db.add(p); db.commit(); db.refresh(p)
    today = business_today()
    yield db, c, p, today
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _opt_in(db, client_id, on=True):
    db.query(Client).filter(Client.id == client_id).update(
        {"recurring_open_to_crew": on}, synchronize_session=False)
    db.commit()


def _payload(client, prop, today, **overrides):
    payload = {
        "client_id": client.id, "job_type": "residential", "title": "Weekly clean",
        "address": prop.address, "frequency": "weekly", "interval_weeks": 1,
        "days_of_week": [today.weekday()],
        "start_time": "10:00", "end_time": "12:00",
        "cleaner_ids": [], "property_id": prop.id, "generate_weeks_ahead": 4,
    }
    payload.update(overrides)
    return payload


def _occurrences(db, client_id):
    return (db.query(Job)
            .filter(Job.client_id == client_id, Job.recurring_schedule_id.isnot(None))
            .all())


def test_opted_in_customer_unassigned_occurrences_go_on_the_board(seeded):
    db, c, p, today = seeded
    _opt_in(db, c.id, True)
    r = api.post("/api/recurring", json=_payload(c, p, today, cleaner_ids=[]))
    assert r.status_code == 201, r.text
    occ = _occurrences(db, c.id)
    assert occ, "expected generated occurrences"
    for j in occ:
        assert (j.cleaner_ids or []) == []
        assert j.open_for_claims is True
        assert (j.offer_audience or []) == []
        assert j.posted_rate is None          # default-pay % off → sub names price


def test_customer_not_opted_in_stays_hidden(seeded):
    db, c, p, today = seeded
    # c.recurring_open_to_crew defaults False — do not opt in.
    r = api.post("/api/recurring", json=_payload(c, p, today, cleaner_ids=[]))
    assert r.status_code == 201, r.text
    occ = _occurrences(db, c.id)
    assert occ, "expected generated occurrences"
    for j in occ:
        assert (j.cleaner_ids or []) == []
        assert j.open_for_claims is False      # unassigned but NOT on the board
        assert j.posted_rate is None


def test_assigned_occurrences_stay_off_the_board_even_when_opted_in(seeded):
    db, c, p, today = seeded
    _opt_in(db, c.id, True)
    cid = f"CT-{uuid.uuid4().hex[:6]}"          # fresh cleaner, no conflicts
    r = api.post("/api/recurring", json=_payload(c, p, today, cleaner_ids=[cid]))
    assert r.status_code == 201, r.text
    assigned = [j for j in _occurrences(db, c.id) if cid in (j.cleaner_ids or [])]
    assert assigned, "expected the free cleaner to be assigned"
    for j in assigned:
        assert j.open_for_claims is False


def test_client_open_to_crew_flag_patch_and_read(seeded):
    db, c, p, today = seeded
    assert api.patch(f"/api/clients/{c.id}", json={"recurring_open_to_crew": True}).status_code == 200
    assert api.get(f"/api/clients/{c.id}").json().get("recurring_open_to_crew") is True
    # ...and it turns back off (False is sent, not dropped as None).
    api.patch(f"/api/clients/{c.id}", json={"recurring_open_to_crew": False})
    assert api.get(f"/api/clients/{c.id}").json().get("recurring_open_to_crew") is False
