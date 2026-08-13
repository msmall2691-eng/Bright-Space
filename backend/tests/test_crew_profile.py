"""Crew app Phase 1: the Me profile + who-you-work-with on job rows.

/api/crew/me is strictly the CALLER's own row (no user_id anywhere in the
path) — the test that matters is that a cleaner can maintain their contact
info but can never blank their display name (teammates and payroll show it),
and that office roles don't pass the cleaner gate by accident.

my-day rows resolve teammate crew-IDs to human names via one bulk query;
unclaimed IDs fall back to the raw ID rather than hiding a teammate.
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, User
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def me_user():
    """A real users row for /me to read and write."""
    db = SessionLocal()
    u = User(email=f"me-{uuid.uuid4().hex[:8]}@example.com", full_name="Pat Doe",
             role="cleaner", status="active", active=True, org_id=1,
             cleaner_id=f"CT-me-{uuid.uuid4().hex[:4]}", phone="207-555-0101")
    db.add(u); db.commit(); db.refresh(u)
    uid, cid = u.id, u.cleaner_id
    db.close()
    yield {"id": uid, "cleaner_id": cid}
    db = SessionLocal()
    db.query(User).filter(User.id == uid).delete(synchronize_session=False)
    db.commit(); db.close()


def test_me_roundtrip_and_name_never_blanks(me_user):
    try:
        me = _Cleaner(me_user["id"], me_user["cleaner_id"])
        api = _as(me)

        r = api.get("/api/crew/me")
        assert r.status_code == 200
        assert r.json()["full_name"] == "Pat Doe"
        assert r.json()["phone"] == "207-555-0101"

        r = api.patch("/api/crew/me", json={
            "full_name": "  Pat Doe-Smith  ",
            "phone": "",                       # explicit clear
            "emergency_contact_name": "Sam Doe",
            "emergency_contact_phone": "207-555-0199",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["full_name"] == "Pat Doe-Smith"   # trimmed
        assert body["phone"] is None                  # cleared
        assert body["emergency_contact_name"] == "Sam Doe"

        # Blanking the display name is ignored, not applied.
        r = api.patch("/api/crew/me", json={"full_name": "   "})
        assert r.status_code == 200
        assert r.json()["full_name"] == "Pat Doe-Smith"
    finally:
        _clear()


def test_me_requires_cleaner_role():
    class _Admin:
        id, org_id, role, status, active = 9800, 1, "admin", "active", True
        email = "admin@example.com"
        cleaner_id = None

    try:
        api = _as(_Admin())
        assert api.get("/api/crew/me").status_code == 403
        assert api.patch("/api/crew/me", json={"phone": "555"}).status_code == 403
    finally:
        _clear()


def test_my_day_shows_teammates_and_client(me_user):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    teammate = User(email=f"tm-{tag}@example.com", full_name="Sasha Lee",
                    role="cleaner", status="active", active=True, org_id=1,
                    cleaner_id=f"CT-tm-{tag}")
    c = Client(name=f"Waterview {tag}", status="active", org_id=1, phone="207-555-0155")
    db.add_all([teammate, c]); db.commit(); db.refresh(teammate); db.refresh(c)
    p = Property(client_id=c.id, name="5 Cove Rd", address="5 Cove Rd", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Clean",
            scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=[me_user["cleaner_id"], teammate.cleaner_id, "CT-ghost"],
            status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    tm_id, cid_j, pid, cl_id = teammate.id, j.id, p.id, c.id
    db.close()

    try:
        api = _as(_Cleaner(me_user["id"], me_user["cleaner_id"]))
        r = api.get("/api/crew/my-day")
        assert r.status_code == 200
        rows = [row for row in r.json()["today"] if row["id"] == cid_j]
        assert rows, "job missing from my-day"
        row = rows[0]
        # Named teammate resolves; unclaimed ID falls back to the raw string;
        # the caller themself is excluded.
        assert row["teammates"] == sorted(["Sasha Lee", "CT-ghost"])
        assert row["client_name"].startswith("Waterview")
        assert row["client_phone"] == "207-555-0155"
        assert row["crew_size"] == 3
    finally:
        _clear()
        db = SessionLocal()
        db.query(Job).filter(Job.id == cid_j).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == pid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == cl_id).delete(synchronize_session=False)
        db.query(User).filter(User.id == tm_id).delete(synchronize_session=False)
        db.commit(); db.close()
