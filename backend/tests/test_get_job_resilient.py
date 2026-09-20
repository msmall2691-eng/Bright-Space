"""A single job's bad data must not 500 the whole job page.

Prod hit an HTTP 500 on GET /api/jobs/<id> for one turnover row: the
serializer raised while building that job's dict and the endpoint had no
fallback, so the office job page was unopenable. get_job/get_job_details now
degrade gracefully — on a serialize error they log the row's shape + traceback
and return a booking-less but complete-enough payload (`_degraded: true`)
instead of a 500. These pin that contract.
"""
import uuid
import datetime as dt
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property
from modules.auth.router import get_current_user, current_org_id
import modules.scheduling.router as sched_router


class _Admin:
    id, org_id, role, status, active = 7811, 1, "admin", "active", True
    email = "resilient-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"jobs": [], "props": [], "clients": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["props"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seed_turnover(ids):
    db = SessionLocal()
    c = Client(name=f"Spin Drift {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    prop = Property(client_id=c.id, name="Wells rental", address="9 Shore Rd", org_id=1)
    db.add(prop); db.commit(); db.refresh(prop)
    j = Job(client_id=c.id, property_id=prop.id, job_type="str_turnover",
            title="Turnover", status="scheduled", scheduled_date=dt.date(2026, 9, 20),
            start_time=dt.time(11, 0), end_time=dt.time(15, 0), org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["clients"].append(c.id); ids["props"].append(prop.id); ids["jobs"].append(j.id)
    jid = j.id
    db.close()
    return jid


def test_normal_job_is_fully_enriched(client):
    api, ids = client
    jid = _seed_turnover(ids)
    body = api.get(f"/api/jobs/{jid}").json()
    assert body["id"] == jid
    # The healthy path carries the booking-enrichment keys and is NOT degraded.
    assert "turnover_lead_hours" in body
    assert body.get("_degraded") is not True


def test_serialize_error_degrades_instead_of_500(client, monkeypatch):
    api, ids = client
    jid = _seed_turnover(ids)

    # Force the normal serializer to blow up the way one row's bad data would.
    def _boom(*a, **k):
        raise ValueError("simulated bad-row serialization")
    monkeypatch.setattr(sched_router, "job_to_dict", _boom)

    r = api.get(f"/api/jobs/{jid}")
    assert r.status_code == 200, r.text          # was a 500 before the fallback
    body = r.json()
    assert body["id"] == jid
    assert body["_degraded"] is True
    # Dates/times survive as JSON-safe strings, booking extras are emptied.
    assert body["scheduled_date"] == "2026-09-20"
    assert body["start_time"] == "11:00:00"
    assert body["booking"] is None
    assert body["turnover_lead_hours"] is None


def test_details_also_degrades(client, monkeypatch):
    api, ids = client
    jid = _seed_turnover(ids)

    def _boom(*a, **k):
        raise ValueError("simulated bad-row serialization")
    monkeypatch.setattr(sched_router, "job_to_dict", _boom)

    r = api.get(f"/api/jobs/{jid}/details")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == jid
    assert body["_degraded"] is True
    # /details still aggregates its side records on top of the degraded core.
    assert "invoices" in body and "timeline" in body
