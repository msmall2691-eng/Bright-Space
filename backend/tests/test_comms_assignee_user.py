"""Phase F: conversation assignee is a real user reference.
  - POST /conversations/{id}/assign {assignee_user_id} sets the FK and derives
    the display label from the user; unknown user 404s; null unassigns both.
  - GET /comms/assignees lists assignable staff (excludes clients/disabled).
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, User
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7951, 1, "admin", "active", True
    email = "assign-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_user(db, **over):
    fields = dict(email=f"{uuid.uuid4().hex[:6]}@ex.com", role="member",
                  status="active", full_name="Casey Cleaner", org_id=1)
    fields.update(over)
    u = User(**fields)
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_assign_by_user_sets_fk_and_label(api):
    db = SessionLocal()
    made = []
    try:
        u = _mk_user(db)
        conv = Conversation(channel="sms", status="open", external_contact="+15550001111", org_id=1)
        db.add(conv); db.commit(); db.refresh(conv)
        made = [conv, u]

        r = api.post(f"/api/comms/conversations/{conv.id}/assign", json={"assignee_user_id": u.id})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["assignee_user_id"] == u.id
        assert body["assignee"] == "Casey Cleaner"   # derived display label

        # Unassign clears both.
        r2 = api.post(f"/api/comms/conversations/{conv.id}/assign", json={"assignee_user_id": None})
        assert r2.status_code == 200
        assert r2.json()["assignee_user_id"] is None
        assert r2.json()["assignee"] is None
    finally:
        db2 = SessionLocal()
        for m in made:
            db2.delete(db2.merge(m))
        db2.commit(); db2.close(); db.close()


def test_assign_unknown_user_404(api):
    db = SessionLocal()
    conv = Conversation(channel="sms", status="open", org_id=1)
    db.add(conv); db.commit(); db.refresh(conv)
    cid = conv.id
    db.close()
    try:
        r = api.post(f"/api/comms/conversations/{cid}/assign", json={"assignee_user_id": 99999999})
        assert r.status_code == 404
    finally:
        db = SessionLocal()
        db.query(Conversation).filter(Conversation.id == cid).delete()
        db.commit(); db.close()


def test_assignees_lists_staff_not_clients(api):
    db = SessionLocal()
    staff = _mk_user(db, full_name="Staff Person")
    client_user = _mk_user(db, role="client", full_name="Portal Customer")
    try:
        r = api.get("/api/comms/assignees")
        assert r.status_code == 200, r.text
        ids = [row["id"] for row in r.json()]
        assert staff.id in ids
        assert client_user.id not in ids   # portal accounts excluded
    finally:
        db2 = SessionLocal()
        db2.query(User).filter(User.id.in_([staff.id, client_user.id])).delete(synchronize_session=False)
        db2.commit(); db2.close(); db.close()
