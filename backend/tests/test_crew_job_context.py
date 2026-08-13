"""Crew cards carry the job's office notes (owner bug report, Aug 2026:
"still not seeing notes or job details or door codes").

The notes half was a straight serializer omission — job.notes never reached
the crew payload. (The door-code half turned out to be DATA, not code: every
job has a property [PR 2, property_id NOT NULL], but properties without a
house_code on file correctly show nothing — fixed by making empty codes
visible/fillable on the office JobDetail instead.)

Under test: office notes reach assigned crew's cards; open-jobs listings
still hide them (notes can carry access details, and an open listing is an
offer, not a work order).
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def ids():
    made = {"clients": [], "properties": [], "jobs": []}
    yield made
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk(db, ids, *, notes=None, cid="CT-ctx-1", open_for_claims=False):
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Ctx {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"House {tag}", address=f"1 Ctx St {tag}",
                 org_id=1, house_code="5501")
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title=f"Ctx clean {tag}", scheduled_date=business_today(),
            start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=[cid], status="scheduled", org_id=1, notes=notes,
            open_for_claims=open_for_claims)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id)
    return j.id


def test_office_notes_reach_the_assigned_card(ids):
    db = SessionLocal()
    jid = _mk(db, ids, notes="Dog in the yard — text before entering.")
    db.close()
    try:
        api = _as(_Cleaner(9995, "CT-ctx-1"))
        rows = [j for j in api.get("/api/crew/my-day").json()["today"] if j["id"] == jid]
        assert rows and rows[0]["notes"] == "Dog in the yard — text before entering."
        assert rows[0]["house_code"] == "5501"   # property data flows as before
    finally:
        _clear()


def test_blank_notes_serialize_as_null_not_empty_string(ids):
    db = SessionLocal()
    jid = _mk(db, ids, notes="   ")
    db.close()
    try:
        api = _as(_Cleaner(9996, "CT-ctx-1"))
        rows = [j for j in api.get("/api/crew/my-day").json()["today"] if j["id"] == jid]
        assert rows and rows[0]["notes"] is None   # the card gates on truthiness
    finally:
        _clear()


def test_open_listings_hide_notes(ids):
    db = SessionLocal()
    jid = _mk(db, ids, notes="Lockbox code is 9999", cid="CT-ctx-other",
              open_for_claims=True)
    db.close()
    try:
        api = _as(_Cleaner(9998, "CT-ctx-2"))   # not assigned → sees it as open
        listing = [j for j in api.get("/api/crew/my-day").json()["open_jobs"] if j["id"] == jid]
        assert listing and listing[0]["notes"] is None
    finally:
        _clear()
