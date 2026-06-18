"""GET /api/schedule/week bundles the calendar week's data into one response:
visits (date-ranged), all jobs, properties, clients, and the coverage check.
Asserts the envelope shape and that a visit seeded inside the range comes back.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Visit, Property
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7501, 1, "admin", "active", True
    email = "sched-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "jobs": [], "visits": [], "properties": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Visit).filter(Visit.id.in_(ids["visits"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _client_with_property(db, ids):
    c = Client(name=f"Sched {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"Prop {uuid.uuid4().hex[:6]}",
                 address="1 Test St", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id)
    return c.id, p.id


def test_schedule_week_bundles_everything(client):
    api, ids = client
    db = SessionLocal()
    cid, pid = _client_with_property(db, ids)
    target = date.today() + timedelta(days=2)
    j = Job(client_id=cid, property_id=pid, title="Week job", scheduled_date=target,
            start_time=time(10, 0), end_time=time(12, 0), status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    v = Visit(job_id=j.id, scheduled_date=target, start_time=time(10, 0),
              end_time=time(12, 0), status="scheduled", cleaner_ids=[], org_id=1)
    db.add(v); db.commit(); db.refresh(v)
    jid, vid = j.id, v.id
    ids["jobs"].append(jid); ids["visits"].append(vid)
    db.close()

    start = (target - timedelta(days=2)).isoformat()
    end = (target + timedelta(days=2)).isoformat()
    res = api.get(f"/api/schedule/week?scheduled_date_from={start}&scheduled_date_to={end}")
    assert res.status_code == 200
    body = res.json()

    # Envelope shape — one response carries all five sections.
    assert set(["visits", "jobs", "properties", "clients", "coverage"]).issubset(body)
    assert isinstance(body["visits"], list)
    assert isinstance(body["jobs"], list)
    assert isinstance(body["properties"], list)
    assert isinstance(body["clients"], list)
    assert isinstance(body["coverage"], dict)
    assert "coverage_percent" in body["coverage"]

    # The seeded visit is in range and carries its joined job detail.
    seeded = next((x for x in body["visits"] if x.get("id") == vid), None)
    assert seeded is not None
    assert str(seeded.get("scheduled_date", "")).startswith(target.isoformat())

    # The seeded job is present in the bundled jobs list.
    assert any(x.get("id") == jid for x in body["jobs"])


def test_schedule_week_excludes_out_of_range_visits(client):
    api, ids = client
    db = SessionLocal()
    cid, pid = _client_with_property(db, ids)
    far = date.today() + timedelta(days=60)
    j = Job(client_id=cid, property_id=pid, title="Far job", scheduled_date=far,
            status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id)
    v = Visit(job_id=j.id, scheduled_date=far, start_time=time(9, 0),
              end_time=time(11, 0), status="scheduled", cleaner_ids=[], org_id=1)
    db.add(v); db.commit(); db.refresh(v)
    vid = v.id
    ids["visits"].append(vid)
    db.close()

    start = date.today().isoformat()
    end = (date.today() + timedelta(days=6)).isoformat()
    res = api.get(f"/api/schedule/week?scheduled_date_from={start}&scheduled_date_to={end}")
    assert res.status_code == 200
    assert all(x.get("id") != vid for x in res.json()["visits"])
