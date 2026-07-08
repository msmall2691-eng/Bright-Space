"""GET /api/jobs pagination + cap (T-23).

Before this the endpoint returned every matching row unbounded — a 4.6 MB
response on the production book kept a single uvicorn worker busy for
~2s, queuing traffic past Railway's edge timeout. These tests pin the
new guarantees:

  - Default cap: `limit=500`, no matter what.
  - `limit=N` returns at most N rows.
  - `offset=K` skips the first K.
  - `paginated=true` returns the envelope `{items, total, limit, offset}`
    with `total` equal to the whole filtered set (not just this page).
  - Legacy shape (no `paginated`) is still a bare list so pre-envelope
    consumers keep working.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 9101, 1, "admin", "active", True
    email = "jobs-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    yield TestClient(app)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def seeded(api):
    """Seed N=25 jobs on distinct future dates so tests can slice."""
    db = SessionLocal()
    c = Client(name=f"Pagn {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Test",
                 property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p)

    ids = {"jobs": [], "clients": [c.id], "props": [p.id]}
    for i in range(25):
        j = Job(
            client_id=c.id, property_id=p.id, job_type="residential",
            title=f"Job {i}",
            scheduled_date=date.today() + timedelta(days=100 + i),
            start_time=time(9, 0), end_time=time(11, 0),
            status="scheduled", cleaner_ids=[], org_id=1,
        )
        db.add(j); db.commit(); db.refresh(j)
        ids["jobs"].append(j.id)
    db.close()

    yield api, ids

    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["props"])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seeded_ids(items, ids):
    """Filter a response payload to the jobs this fixture seeded, so
    unrelated pre-existing rows in the shared test DB don't confuse
    slicing assertions."""
    return [it["id"] for it in items if it["id"] in ids["jobs"]]


def test_bare_list_response_by_default(seeded):
    """Pre-envelope callers expect a raw JSON array — must keep working."""
    api, _ = seeded
    r = api.get("/api/jobs?client_id=999999")   # narrow to isolate
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_limit_bounds_the_response(seeded):
    api, ids = seeded
    r = api.get(f"/api/jobs?client_id={ids['clients'][0]}&limit=5")
    assert r.status_code == 200
    seeded_matches = _seeded_ids(r.json(), ids)
    assert len(seeded_matches) == 5


def test_offset_skips_first_rows(seeded):
    api, ids = seeded
    first = api.get(f"/api/jobs?client_id={ids['clients'][0]}&limit=10").json()
    offset = api.get(f"/api/jobs?client_id={ids['clients'][0]}&limit=10&offset=5").json()
    first_ids = _seeded_ids(first, ids)
    offset_ids = _seeded_ids(offset, ids)
    # No overlap between rows 0-4 and rows 5-14.
    assert set(first_ids[:5]).isdisjoint(offset_ids)


def test_paginated_envelope_shape(seeded):
    """paginated=true switches to envelope + reports total across ALL pages."""
    api, ids = seeded
    r = api.get(
        f"/api/jobs?client_id={ids['clients'][0]}&limit=10&paginated=true"
    )
    body = r.json()
    assert set(body.keys()) >= {"items", "total", "limit", "offset"}
    assert isinstance(body["items"], list)
    assert len(_seeded_ids(body["items"], ids)) == 10
    assert body["total"] >= 25         # 25 seeded + whatever else lives in the DB
    assert body["limit"] == 10
    assert body["offset"] == 0


def test_paginated_envelope_last_page(seeded):
    api, ids = seeded
    body = api.get(
        f"/api/jobs?client_id={ids['clients'][0]}&limit=10&offset=20&paginated=true"
    ).json()
    # 25 seeded rows means offset 20 returns 5 seeded matches.
    assert len(_seeded_ids(body["items"], ids)) == 5


def test_limit_out_of_range_is_rejected_by_validation(seeded):
    api, _ = seeded
    # ge=1 le=1000 on the Query. 0 and 1001 should 422.
    assert api.get("/api/jobs?limit=0").status_code == 422
    assert api.get("/api/jobs?limit=1001").status_code == 422


def test_offset_negative_is_rejected(seeded):
    api, _ = seeded
    assert api.get("/api/jobs?offset=-1").status_code == 422


def test_unassigned_filter_applied_before_pagination(api):
    """Codex P2 on #526: with `unassigned=true`, the endpoint must apply
    the filter BEFORE slicing offset/limit — otherwise if all rows on the
    first DB page happen to be assigned, the caller sees zero matches
    even when unassigned rows exist further down the sort order.

    Repro: seed 6 assigned jobs on earlier dates + 2 unassigned jobs on
    later dates, then request `?unassigned=true&limit=3`. With the bug,
    DB pagination returns the first 3 (all assigned), Python filter
    strips them, response is empty. Fixed, the filter runs first and
    the 2 unassigned rows come back on page 0.
    """
    db = SessionLocal()
    c = Client(name=f"UnAsn {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Test",
                 property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    client_id = c.id
    property_id = p.id
    job_ids = []
    # 6 assigned on early dates so they sort BEFORE the unassigned ones.
    for i in range(6):
        j = Job(
            client_id=client_id, property_id=property_id, job_type="residential",
            title=f"Assigned {i}",
            scheduled_date=date.today() + timedelta(days=200 + i),
            start_time=time(9, 0), end_time=time(11, 0),
            status="scheduled", cleaner_ids=[42], org_id=1,
        )
        db.add(j); db.commit(); db.refresh(j)
        job_ids.append(j.id)
    unassigned_ids = []
    for i in range(2):
        j = Job(
            client_id=client_id, property_id=property_id, job_type="residential",
            title=f"UnAssigned {i}",
            scheduled_date=date.today() + timedelta(days=210 + i),
            start_time=time(9, 0), end_time=time(11, 0),
            status="scheduled", cleaner_ids=[], org_id=1,
        )
        db.add(j); db.commit(); db.refresh(j)
        job_ids.append(j.id)
        unassigned_ids.append(j.id)
    # Close before we hit the endpoint so the endpoint's own session
    # sees fully-committed rows.
    db.close()

    try:
        # Scope tightly to this client so pre-existing test rows don't
        # confuse the assertion.
        r = api.get(f"/api/jobs?client_id={client_id}&unassigned=true&limit=3")
        assert r.status_code == 200
        returned = {it["id"] for it in r.json()}
        # Bug would return empty (assigned filled first page then got
        # filtered out). Fix returns both unassigned rows.
        assert returned == set(unassigned_ids), (
            f"unassigned filter should run BEFORE pagination — "
            f"expected {unassigned_ids}, got {returned}"
        )

        # Envelope total should reflect the whole filtered set, not
        # just this page.
        env = api.get(
            f"/api/jobs?client_id={client_id}&unassigned=true&limit=1&paginated=true"
        ).json()
        assert env["total"] == 2
        assert len(env["items"]) == 1
    finally:
        db = SessionLocal()
        db.query(Job).filter(Job.id.in_(job_ids)).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == property_id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
        db.commit(); db.close()
