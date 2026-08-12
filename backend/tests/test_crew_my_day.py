"""GET /api/crew/my-day — a cleaner-role login sees only jobs assigned to
their linked crew ID (Job.cleaner_ids), scoped to today + a short window.
Additive feature: doesn't touch dispatch, Connecteam, or payroll."""
import uuid
from datetime import time, timedelta

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


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(ids):
    db = SessionLocal()
    c = Client(name=f"Crew {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def _mk_str_property(ids, cid):
    db = SessionLocal()
    p = Property(client_id=cid, name="9 Lakeshore Dr", address="9 Lakeshore Dr",
                 property_type="str", org_id=1,
                 check_out_time="10:00", check_in_time="16:00", house_code="4521",
                 access_notes="Side door lockbox")
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id); pid = p.id; db.close()
    return pid


def _mk_job(ids, cid, pid, cleaner_ids, offset_days=0, job_type="str_turnover"):
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type=job_type,
            title="Turnover", scheduled_date=business_today() + timedelta(days=offset_days),
            start_time=time(10, 0), end_time=time(13, 0),
            cleaner_ids=cleaner_ids, status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id); jid = j.id; db.close()
    return jid


def test_my_day_returns_only_this_cleaners_jobs(ids):
    cid = _mk_client(ids)
    pid = _mk_str_property(ids, cid)
    mine_today = _mk_job(ids, cid, pid, ["CT-101"], offset_days=0)
    mine_later = _mk_job(ids, cid, pid, ["CT-101"], offset_days=2)
    # A distinct property/date/type combo — (property, date, job_type) is
    # unique, so this can't share `mine_today`'s slot.
    pid2 = _mk_str_property(ids, cid)
    someone_elses = _mk_job(ids, cid, pid2, ["CT-202"], offset_days=0)

    app.dependency_overrides[get_current_user] = lambda: _Cleaner(9001, "CT-101")
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.get("/api/crew/my-day")
        assert res.status_code == 200
        body = res.json()
        today_ids = {j["id"] for j in body["today"]}
        upcoming_ids = {j["id"] for j in body["upcoming"]}
        assert today_ids == {mine_today}
        assert upcoming_ids == {mine_later}
        assert someone_elses not in today_ids and someone_elses not in upcoming_ids

        # Turnover context surfaces without needing the job-detail drawer.
        row = body["today"][0]
        assert row["turnover_line"] == "Guest out 10:00 → in 16:00 · Code 4521"
        assert row["access_notes"] == "Side door lockbox"
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


def test_my_day_requires_a_linked_crew_id():
    app.dependency_overrides[get_current_user] = lambda: _Cleaner(9002, None)
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.get("/api/crew/my-day")
        assert res.status_code == 400
        assert "crew ID" in res.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


def test_non_cleaner_role_is_rejected():
    class _Admin:
        id, org_id, role, status, active = 9003, 1, "admin", "active", True
        email = "admin@example.com"
        cleaner_id = None

    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.get("/api/crew/my-day")
        assert res.status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


def test_admin_can_link_a_cleaner_id_via_users_endpoint():
    """AdminUserUpdate.cleaner_id round-trips through the existing Users
    admin screen's PATCH endpoint."""
    db = SessionLocal()
    u = User(email=f"crew-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="Test Crew", org_id=1, active=True, status="active")
    db.add(u); db.commit(); db.refresh(u)
    uid = u.id; db.close()

    class _Admin:
        id, org_id, role, status, active = 9004, 1, "admin", "active", True
        email = "admin2@example.com"

    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.patch(f"/api/auth/users/{uid}", json={"cleaner_id": " CT-303 "})
        assert res.status_code == 200
        assert res.json()["cleaner_id"] == "CT-303"  # trimmed

        res2 = api.patch(f"/api/auth/users/{uid}", json={"cleaner_id": ""})
        assert res2.status_code == 200
        assert res2.json()["cleaner_id"] is None  # "" clears the link
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)
        db = SessionLocal()
        db.query(User).filter(User.id == uid).delete()
        db.commit(); db.close()
