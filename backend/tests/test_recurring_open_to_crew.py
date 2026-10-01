"""Unassigned recurring occurrences go on the bench (owner decision, Sept 2026).

Reversing the older "only office-marked jobs are claimable" rule FOR RECURRING
work: a repeating visit generated with no cleaner — a series with no crew, or a
date its regular can't cover — is auto-posted (open_for_claims=True) so any
cleared sub can grab that one visit. It stays an offer: the sub requests and the
office approves (brightbase-marketplace Rule 0). An ASSIGNED occurrence is not
posted (it's already someone's), and a route occurrence never hits the board.

posted_rate is seeded from the visit's price × the owner's default-pay %
(BB-CLAIM-04); with that setting off (the default), it stays NULL and the sub
names their price on claim.
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


def test_unassigned_recurring_occurrences_go_on_the_board(seeded):
    db, c, p, today = seeded
    r = api.post("/api/recurring", json=_payload(c, p, today, cleaner_ids=[]))
    assert r.status_code == 201, r.text
    occ = _occurrences(db, c.id)
    assert occ, "expected generated occurrences"
    for j in occ:
        assert (j.cleaner_ids or []) == []          # nobody assigned
        assert j.open_for_claims is True            # ...so it's offered to the bench
        assert (j.offer_audience or []) == []       # open to everyone, not targeted
        # default-pay % is off by default → no rate seeded, sub names their price
        assert j.posted_rate is None


def test_assigned_recurring_occurrences_stay_off_the_board(seeded):
    db, c, p, today = seeded
    cid = f"CT-{uuid.uuid4().hex[:6]}"           # fresh cleaner, no conflicts
    r = api.post("/api/recurring", json=_payload(c, p, today, cleaner_ids=[cid]))
    assert r.status_code == 201, r.text
    occ = _occurrences(db, c.id)
    assert occ, "expected generated occurrences"
    # At least the near-term occurrences assign cleanly (cleaner is free), and an
    # assigned occurrence is never posted — it's already someone's.
    assigned = [j for j in occ if cid in (j.cleaner_ids or [])]
    assert assigned, "expected the free cleaner to be assigned"
    for j in assigned:
        assert j.open_for_claims is False
