"""Crew single-job detail endpoint (month tap-through) + greeting fields.

Assigned-only is the whole point: even a lead who can SEE the whole month
gets a 404 opening someone else's job — the full-context payload (door
code, notes) stays need-to-know. Weather is deliberately untested against
the network; it's fail-soft by design.
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
    def __init__(self, uid, cleaner_id, full_name="Pat Tester"):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = full_name
        self.cleaner_id = cleaner_id
        self.can_view_full_schedule = True   # even leads get 404 on others' details


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def job():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Det {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"8 Elm {tag}", address=f"8 Elm {tag}",
                 org_id=1, house_code="4141")
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title=f"Det clean {tag}", scheduled_date=business_today(),
            start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=["CT-det-1"], status="scheduled", org_id=1,
            notes="watch the cat")
    db.add(j); db.commit(); db.refresh(j)
    ids = (j.id, p.id, c.id)
    db.close()
    yield ids[0]
    db = SessionLocal()
    db.query(Job).filter(Job.id == ids[0]).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids[1]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids[2]).delete(synchronize_session=False)
    db.commit(); db.close()


def test_assigned_cleaner_gets_full_context(job):
    try:
        api = _as(_Cleaner(9975, "CT-det-1"))
        r = api.get(f"/api/crew/jobs/{job}")
        assert r.status_code == 200
        d = r.json()
        assert d["house_code"] == "4141"
        assert d["notes"] == "watch the cat"
        assert "my_response" in d           # the sheet can show accept state
    finally:
        _clear()


def test_unassigned_cleaner_404s_even_as_lead(job):
    try:
        api = _as(_Cleaner(9976, "CT-det-2"))   # lead flag set in the stub
        assert api.get(f"/api/crew/jobs/{job}").status_code == 404
    finally:
        _clear()


def test_my_day_carries_first_name(job):
    try:
        api = _as(_Cleaner(9977, "CT-det-1", full_name="Sam Q Cleaner"))
        assert api.get("/api/crew/my-day").json()["first_name"] == "Sam"
    finally:
        _clear()
