"""The conversations list builds each row's preview from the NEWEST message,
now via one batched query (_last_message_previews) instead of loading every
message of every conversation. This locks in that the preview still equals the
last message body."""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7801, 1, "admin", "active", True
    email = "comms-preview@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_list_preview_is_last_message(api):
    db = SessionLocal()
    cl = Client(name=f"Preview {uuid.uuid4().hex[:5]}", email="pv@example.com", status="active", org_id=1)
    db.add(cl); db.commit(); db.refresh(cl)
    conv = Conversation(client_id=cl.id, channel="sms", status="open", org_id=1)
    db.add(conv); db.commit(); db.refresh(conv)
    db.add(Message(conversation_id=conv.id, client_id=cl.id, channel="sms",
                   direction="inbound", body="first message", org_id=1))
    db.commit()
    db.add(Message(conversation_id=conv.id, client_id=cl.id, channel="sms",
                   direction="outbound", body="the latest reply", org_id=1))
    db.commit()
    cid, clid = conv.id, cl.id
    db.close()
    try:
        r = api.get("/api/comms/conversations")
        assert r.status_code == 200, r.text
        row = next((x for x in r.json() if x["id"] == cid), None)
        assert row is not None
        assert row["preview"] == "the latest reply"   # newest, not "first message"
    finally:
        db = SessionLocal()
        db.query(Message).filter(Message.conversation_id == cid).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id == cid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == clid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_empty_conversation_has_null_preview(api):
    db = SessionLocal()
    cl = Client(name=f"Empty {uuid.uuid4().hex[:5]}", email="empty@example.com", status="active", org_id=1)
    db.add(cl); db.commit(); db.refresh(cl)
    conv = Conversation(client_id=cl.id, channel="sms", status="open", org_id=1)
    db.add(conv); db.commit(); db.refresh(conv)
    cid, clid = conv.id, cl.id
    db.close()
    try:
        r = api.get("/api/comms/conversations")
        assert r.status_code == 200, r.text
        row = next((x for x in r.json() if x["id"] == cid), None)
        assert row is not None
        assert row["preview"] is None
    finally:
        db = SessionLocal()
        db.query(Conversation).filter(Conversation.id == cid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == clid).delete(synchronize_session=False)
        db.commit(); db.close()
