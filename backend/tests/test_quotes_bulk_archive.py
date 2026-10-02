"""POST /api/quotes/bulk-archive — clear a pile of quotes in one call.

The bulk version of DELETE /{id}, used by the Flow list's multi-select. Pins:
archives the ones it can, SKIPS (never archives) a quote already converted into
a job — orphaning the revenue→job link is the trap the single-delete already
guards — and is org-scoped and idempotent.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, Quote
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7602, 1, "admin", "active", True
    email = "bulk-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "properties": [], "jobs": [], "quotes": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _cid(ids):
    db = SessionLocal()
    c = Client(name=f"Bulk {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def test_bulk_archive_archives_the_clearable_and_skips_a_booked_one(client):
    api, ids = client
    cid = _cid(ids)
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    a = Quote(client_id=cid, status="accepted", total=100.0, org_id=1, quote_number=f"Q{tag}1")
    b = Quote(client_id=cid, status="accepted", total=200.0, org_id=1, quote_number=f"Q{tag}2")
    # Converted-into-a-job quote: must be SKIPPED, not archived.
    booked = Quote(client_id=cid, status="converted", total=300.0, org_id=1, quote_number=f"Q{tag}3")
    prop = Property(client_id=cid, name="1 Way", address="1 Way", property_type="residential", org_id=1)
    db.add_all([a, b, booked, prop]); db.commit()
    for o in (a, b, booked, prop):
        db.refresh(o)
    ids["quotes"] += [a.id, b.id, booked.id]
    ids["properties"].append(prop.id)
    job = Job(client_id=cid, property_id=prop.id, quote_id=booked.id, job_type="residential",
              title="Clean", status="unscheduled", org_id=1)
    db.add(job); db.commit(); db.refresh(job); ids["jobs"].append(job.id)
    a_id, b_id, booked_id = a.id, b.id, booked.id
    missing_id = booked_id + 99999
    db.close()

    r = api.post("/api/quotes/bulk-archive", json={"ids": [a_id, b_id, booked_id, missing_id]})
    assert r.status_code == 200
    body = r.json()
    assert set(body["archived"]) == {a_id, b_id}
    skipped = {s["id"]: s["reason"] for s in body["skipped"]}
    assert skipped.get(booked_id) == "scheduled_into_job"
    assert skipped.get(missing_id) == "not_found"

    db = SessionLocal()
    assert db.query(Quote).get(a_id).status == "archived"
    assert db.query(Quote).get(b_id).status == "archived"
    assert db.query(Quote).get(booked_id).status == "converted"  # untouched
    db.close()


def test_bulk_archive_is_idempotent(client):
    api, ids = client
    cid = _cid(ids)
    db = SessionLocal()
    q = Quote(client_id=cid, status="accepted", total=50.0, org_id=1,
              quote_number=f"Q{uuid.uuid4().hex[:8]}")
    db.add(q); db.commit(); db.refresh(q); ids["quotes"].append(q.id)
    qid = q.id; db.close()

    api.post("/api/quotes/bulk-archive", json={"ids": [qid]})
    r2 = api.post("/api/quotes/bulk-archive", json={"ids": [qid, qid]})  # re-run + dupe
    assert r2.status_code == 200
    assert r2.json()["archived"] == [qid]  # de-duped, still archived, no error
