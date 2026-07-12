"""POST/GET /api/settings/connecteam/push-open-shifts (T-20 Part B).

The push used to run inline and block the request for the whole bulk
Connecteam POST. It's now async: POST returns 202 + a run_id immediately and
schedules the sweep as a FastAPI BackgroundTask; GET polls a DB-backed run
row for status. Starlette's TestClient executes background tasks synchronously
as part of the request cycle, so by the time client.post() returns here the
run has already finished — these tests exercise the full queued->done/error
lifecycle without needing to poll in a loop.

Connecteam's HTTP layer is monkeypatched — hermetic, no network.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

import integrations.connecteam as connecteam
from main import app
from database.db import SessionLocal
from database.models import Client, ConnecteamPushRun, Job, Property
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 9001, 1, "admin", "active", True
    email = "push-admin@example.com"


@pytest.fixture
def api_client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "properties": [], "jobs": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_job(ids, *, days_from_today=1, dispatched_shift_ids=None):
    db = SessionLocal()
    c = Client(name=f"Push {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    p = Property(client_id=c.id, name="P", address="1 Push St",
                 property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id)
    d = date.today() + timedelta(days=days_from_today)
    j = Job(
        client_id=c.id, property_id=p.id, title="Push me",
        job_type="residential", status="scheduled",
        scheduled_date=d, start_time=time(9, 0), end_time=time(11, 0),
        address="1 Push St", connecteam_shift_ids=dispatched_shift_ids or [],
    )
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id)
    jid = j.id
    db.close()
    return jid


def test_not_configured_returns_400(api_client, monkeypatch):
    api, ids = api_client
    monkeypatch.setattr(connecteam, "is_configured", lambda: False)
    r = api.post("/api/settings/connecteam/push-open-shifts", json={})
    assert r.status_code == 400


def test_push_run_completes_and_is_pollable(api_client, monkeypatch):
    api, ids = api_client
    jid = _mk_job(ids)
    monkeypatch.setattr(connecteam, "is_configured", lambda: True)
    monkeypatch.setattr(connecteam, "create_shifts_sync", lambda shifts: [f"sh_{i}" for i in range(len(shifts))])

    r = api.post("/api/settings/connecteam/push-open-shifts", json={})
    assert r.status_code == 202
    body = r.json()
    run_id = body["run_id"]
    assert body["status"] == "queued"

    status = api.get(f"/api/settings/connecteam/push-open-shifts/{run_id}").json()
    assert status["status"] == "done"
    assert status["pushed"] == 1
    assert status["skipped"] == 0
    assert status["errors"] == []
    assert status["ok"] is True

    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    assert job.connecteam_shift_ids == ["sh_0"]
    assert job.dispatched is True
    run_row = db.query(ConnecteamPushRun).filter(ConnecteamPushRun.id == run_id).first()
    assert run_row is not None and run_row.status == "done"
    db.close()


def test_already_dispatched_job_is_skipped(api_client, monkeypatch):
    api, ids = api_client
    _mk_job(ids, dispatched_shift_ids=["already_there"])
    monkeypatch.setattr(connecteam, "is_configured", lambda: True)
    called = []
    monkeypatch.setattr(connecteam, "create_shifts_sync", lambda shifts: called.append(shifts) or [])

    run_id = api.post("/api/settings/connecteam/push-open-shifts", json={}).json()["run_id"]
    status = api.get(f"/api/settings/connecteam/push-open-shifts/{run_id}").json()
    assert status["status"] == "done"
    assert status["pushed"] == 0
    assert status["skipped"] == 1
    assert not called  # nothing sendable -> create_shifts_sync never called


def test_auth_error_flips_run_to_error(api_client, monkeypatch):
    api, ids = api_client
    _mk_job(ids)
    monkeypatch.setattr(connecteam, "is_configured", lambda: True)

    def _boom(shifts):
        raise connecteam.ConnecteamAuthError("bad key")
    monkeypatch.setattr(connecteam, "create_shifts_sync", _boom)

    run_id = api.post("/api/settings/connecteam/push-open-shifts", json={}).json()["run_id"]
    status = api.get(f"/api/settings/connecteam/push-open-shifts/{run_id}").json()
    assert status["status"] == "error"
    assert "rotate" in status["error"].lower() or "api key" in status["error"].lower()


def test_unknown_run_id_404s(api_client):
    api, _ = api_client
    r = api.get(f"/api/settings/connecteam/push-open-shifts/{uuid.uuid4().hex}")
    assert r.status_code == 404
