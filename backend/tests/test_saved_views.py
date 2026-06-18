"""Saved views: per-user, per-workspace list presets with CRUD + default switching.

Drives the endpoints through TestClient with get_current_user / current_org_id
overridden so each test acts as a specific (user, org), proving views are
isolated per user and per workspace.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import SavedView
from modules.auth.router import get_current_user, current_org_id


class _StubUser:
    def __init__(self, uid, org):
        self.id, self.org_id = uid, org
        self.role, self.status, self.active = "admin", "active", True
        self.email = f"u{uid}@example.com"


def _act_as(uid, org):
    app.dependency_overrides[get_current_user] = lambda: _StubUser(uid, org)
    app.dependency_overrides[current_org_id] = lambda: org


@pytest.fixture
def client():
    api = TestClient(app)
    yield api
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    # Clean up any views created during the test.
    db = SessionLocal()
    db.query(SavedView).filter(SavedView.entity_type.like("test_%")).delete(
        synchronize_session=False)
    db.commit(); db.close()


def test_crud_lifecycle(client):
    _act_as(1001, 1)
    et = f"test_{uuid.uuid4().hex[:6]}"
    # create
    r = client.post("/api/views", json={"entity_type": et, "name": "Active only",
                                         "config": {"statusFilter": "active"}})
    assert r.status_code == 201, r.text
    vid = r.json()["id"]
    assert r.json()["config"] == {"statusFilter": "active"}

    # list (filtered by entity type)
    r = client.get(f"/api/views?entity_type={et}")
    assert r.status_code == 200
    assert [v["id"] for v in r.json()] == [vid]

    # update name + config
    r = client.patch(f"/api/views/{vid}", json={"name": "Leads", "config": {"statusFilter": "lead"}})
    assert r.status_code == 200
    assert r.json()["name"] == "Leads"
    assert r.json()["config"] == {"statusFilter": "lead"}

    # delete
    assert client.delete(f"/api/views/{vid}").status_code == 204
    assert client.get(f"/api/views?entity_type={et}").json() == []


def test_only_one_default_per_entity(client):
    _act_as(1002, 1)
    et = f"test_{uuid.uuid4().hex[:6]}"
    a = client.post("/api/views", json={"entity_type": et, "name": "A", "is_default": True}).json()
    b = client.post("/api/views", json={"entity_type": et, "name": "B", "is_default": True}).json()
    views = {v["id"]: v["is_default"] for v in client.get(f"/api/views?entity_type={et}").json()}
    assert views[a["id"]] is False    # superseded
    assert views[b["id"]] is True
    # Promoting A back flips B off.
    client.patch(f"/api/views/{a['id']}", json={"is_default": True})
    views = {v["id"]: v["is_default"] for v in client.get(f"/api/views?entity_type={et}").json()}
    assert views[a["id"]] is True and views[b["id"]] is False
    # Default sorts first.
    assert client.get(f"/api/views?entity_type={et}").json()[0]["id"] == a["id"]


def test_views_isolated_per_user(client):
    et = f"test_{uuid.uuid4().hex[:6]}"
    _act_as(2001, 1)
    mine = client.post("/api/views", json={"entity_type": et, "name": "Mine"}).json()
    _act_as(2002, 1)                                  # different user, same org
    assert client.get(f"/api/views?entity_type={et}").json() == []
    assert client.get(f"/api/views").status_code == 200
    # Can't read, edit, or delete another user's view.
    assert client.patch(f"/api/views/{mine['id']}", json={"name": "Hijack"}).status_code == 404
    assert client.delete(f"/api/views/{mine['id']}").status_code == 404


def test_views_isolated_per_workspace(client):
    et = f"test_{uuid.uuid4().hex[:6]}"
    _act_as(3001, 1)                                  # same user id, org 1
    v = client.post("/api/views", json={"entity_type": et, "name": "Org1 view"}).json()
    _act_as(3001, 2)                                  # same user id, DIFFERENT org
    assert client.get(f"/api/views?entity_type={et}").json() == []
    assert client.patch(f"/api/views/{v['id']}", json={"name": "x"}).status_code == 404
