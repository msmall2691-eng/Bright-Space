"""Sticky notes: per-user, per-workspace Home notes with CRUD.

Drives /api/notes through TestClient with get_current_user / current_org_id
overridden, proving notes are owned by (user, org) — a note is invisible to a
different user AND to the same user in a different workspace, and only its owner
can edit or delete it.
"""
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import StickyNote
from modules.auth.router import get_current_user, current_org_id

# High, test-only ids so cleanup can target them without touching real rows.
U1, U2, ORG_A, ORG_B = 990101, 990102, 97001, 97002


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
    db = SessionLocal()
    db.query(StickyNote).filter(StickyNote.user_id.in_([U1, U2])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_crud_lifecycle(client):
    _act_as(U1, ORG_A)
    # create
    r = client.post("/api/notes", json={"body": "Order microfiber", "color": "blue"})
    assert r.status_code == 201, r.text
    nid = r.json()["id"]
    assert r.json()["body"] == "Order microfiber"
    assert r.json()["color"] == "blue"

    # list
    r = client.get("/api/notes")
    assert r.status_code == 200
    assert [n["id"] for n in r.json()] == [nid]

    # edit body + color
    r = client.patch(f"/api/notes/{nid}", json={"body": "Order microfiber + glass cleaner", "color": "green"})
    assert r.status_code == 200
    assert r.json()["body"] == "Order microfiber + glass cleaner"
    assert r.json()["color"] == "green"

    # delete
    assert client.delete(f"/api/notes/{nid}").status_code == 204
    assert client.get("/api/notes").json() == []


def test_empty_body_and_unknown_color_are_tolerated(client):
    _act_as(U1, ORG_A)
    # A blank note (about to be filled) is allowed; a bogus color folds to amber.
    r = client.post("/api/notes", json={"body": "", "color": "chartreuse"})
    assert r.status_code == 201, r.text
    assert r.json()["body"] == ""
    assert r.json()["color"] == "amber"


def test_notes_are_isolated_per_user_and_per_workspace(client):
    _act_as(U1, ORG_A)
    mine = client.post("/api/notes", json={"body": "mine"}).json()["id"]

    # A different user in the same workspace does not see it.
    _act_as(U2, ORG_A)
    assert client.get("/api/notes").json() == []
    # …and cannot edit or delete it (404, never reveals it exists).
    assert client.patch(f"/api/notes/{mine}", json={"body": "hijack"}).status_code == 404
    assert client.delete(f"/api/notes/{mine}").status_code == 404

    # The SAME user in a different workspace also does not see it.
    _act_as(U1, ORG_B)
    assert client.get("/api/notes").json() == []

    # Back in the owning (user, org), it's still there and intact.
    _act_as(U1, ORG_A)
    got = client.get("/api/notes").json()
    assert [n["id"] for n in got] == [mine]
    assert got[0]["body"] == "mine"
