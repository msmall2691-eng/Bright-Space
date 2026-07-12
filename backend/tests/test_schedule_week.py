"""GET /api/schedule/week bundles the calendar week's data into one response:
jobs, properties, clients, a synthetic `visits` list derived from jobs (kept
for one release so an in-flight Schedule.jsx bundle still renders), and the
coverage envelope. Asserts the shape and that a job seeded inside the range
comes back in both the `jobs` and `visits` lists.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7501, 1, "admin", "active", True
    email = "sched-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "jobs": [], "properties": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
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
    jid = j.id
    ids["jobs"].append(jid)
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
    # Coverage is trivially 100% now that occurrences are Jobs.
    assert body["coverage"]["healthy"] is True

    # The seeded job is present in the jobs list AND mirrored into the
    # visit-shaped fallback so an in-flight Schedule.jsx bundle renders.
    assert any(x.get("id") == jid for x in body["jobs"])
    seeded = next((x for x in body["visits"] if x.get("id") == jid), None)
    assert seeded is not None
    assert str(seeded.get("scheduled_date", "")).startswith(target.isoformat())


def test_schedule_week_returns_every_job_past_the_500_row_page_size(client):
    """Regression: schedule_week() used to call get_jobs(limit=500) exactly
    once. get_jobs orders by scheduled_date ascending, so once a requested
    range held more than 500 jobs, SQL's LIMIT silently dropped every job
    past the 500th row — i.e. the chronologically LATEST ones in the range.
    A busy-enough org's month-view grid (used by the Calendar view) could
    cross that threshold; a week's 7-day window almost never would, so
    jobs still showed correctly in Week view while vanishing from Calendar
    view for the exact same dates. schedule_week must now page through
    get_jobs until it has the full range, not just the first 500 rows."""
    api, ids = client
    db = SessionLocal()
    cid, pid = _client_with_property(db, ids)
    start_date = date.today()
    n = 520
    jobs = [
        Job(client_id=cid, property_id=pid, title=f"Bulk {i}",
            scheduled_date=start_date + timedelta(days=i % 60),
            start_time=time(9, 0), end_time=time(10, 0),
            status="scheduled", org_id=1)
        for i in range(n)
    ]
    db.add_all(jobs)
    db.commit()
    for j in jobs:
        db.refresh(j)
    ids["jobs"].extend(j.id for j in jobs)
    # The chronologically latest job — exactly what a naive limit=500,
    # offset=0, order-by-scheduled_date-ascending call would drop.
    latest = max(jobs, key=lambda j: j.scheduled_date)
    latest_id = latest.id
    db.close()

    start = start_date.isoformat()
    end = (start_date + timedelta(days=59)).isoformat()
    res = api.get(f"/api/schedule/week?scheduled_date_from={start}&scheduled_date_to={end}")
    assert res.status_code == 200
    body = res.json()
    assert len(body["jobs"]) >= n
    assert any(x.get("id") == latest_id for x in body["jobs"]), (
        "the chronologically latest job in the range was dropped — "
        "schedule_week is still capping at a single get_jobs page"
    )


def test_schedule_week_excludes_out_of_range_jobs(client):
    api, ids = client
    db = SessionLocal()
    cid, pid = _client_with_property(db, ids)
    far = date.today() + timedelta(days=60)
    j = Job(client_id=cid, property_id=pid, title="Far job", scheduled_date=far,
            start_time=time(9, 0), end_time=time(11, 0),
            status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    jid = j.id
    ids["jobs"].append(jid)
    db.close()

    start = date.today().isoformat()
    end = (date.today() + timedelta(days=6)).isoformat()
    res = api.get(f"/api/schedule/week?scheduled_date_from={start}&scheduled_date_to={end}")
    assert res.status_code == 200
    body = res.json()
    assert all(x.get("id") != jid for x in body["jobs"])
    assert all(x.get("id") != jid for x in body["visits"])
