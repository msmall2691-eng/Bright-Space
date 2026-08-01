"""POST /api/comms/conversations/{id}/link-client — attach an unknown-sender
conversation (client_id NULL) to a client, cascading the link to its messages
so the client's unified comms view picks up the whole thread. Passing
client_id=null unlinks.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7802, 1, "admin", "active", True
    email = "comms-link@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _seed_unlinked_thread():
    """An inbound thread from an unknown sender: conversation + message both
    client_id NULL, keyed only by external_contact."""
    db = SessionLocal()
    conv = Conversation(client_id=None, external_contact="+15551230000",
                        channel="sms", status="open", org_id=1)
    db.add(conv); db.commit(); db.refresh(conv)
    db.add(Message(conversation_id=conv.id, client_id=None, channel="sms",
                   direction="inbound", body="Hi, do you clean condos?",
                   from_addr="+15551230000", org_id=1))
    db.commit()
    cid = conv.id
    db.close()
    return cid


def test_link_attaches_conversation_and_messages(api):
    cid = _seed_unlinked_thread()
    db = SessionLocal()
    cl = Client(name=f"Condo Lead {uuid.uuid4().hex[:5]}", status="lead", org_id=1)
    db.add(cl); db.commit(); db.refresh(cl)
    clid = cl.id
    db.close()
    try:
        r = api.post(f"/api/comms/conversations/{cid}/link-client", json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert r.json()["client_id"] == clid

        db = SessionLocal()
        msgs = db.query(Message).filter(Message.conversation_id == cid).all()
        assert msgs and all(m.client_id == clid for m in msgs)  # cascaded
        db.close()
    finally:
        _cleanup(cid, clid)


def test_unlink_detaches_without_deleting(api):
    cid = _seed_unlinked_thread()
    db = SessionLocal()
    cl = Client(name=f"Tmp {uuid.uuid4().hex[:5]}", status="lead", org_id=1)
    db.add(cl); db.commit(); db.refresh(cl)
    clid = cl.id
    db.close()
    try:
        api.post(f"/api/comms/conversations/{cid}/link-client", json={"client_id": clid})
        r = api.post(f"/api/comms/conversations/{cid}/link-client", json={"client_id": None})
        assert r.status_code == 200, r.text
        assert r.json()["client_id"] is None
        db = SessionLocal()
        assert db.query(Conversation).filter(Conversation.id == cid).first() is not None  # not deleted
        db.close()
    finally:
        _cleanup(cid, clid)


def test_link_to_missing_client_404(api):
    cid = _seed_unlinked_thread()
    try:
        r = api.post(f"/api/comms/conversations/{cid}/link-client", json={"client_id": 99999999})
        assert r.status_code == 404
    finally:
        _cleanup(cid, None)


def _cleanup(cid, clid):
    db = SessionLocal()
    db.query(Message).filter(Message.conversation_id == cid).delete(synchronize_session=False)
    db.query(Conversation).filter(Conversation.id == cid).delete(synchronize_session=False)
    if clid:
        db.query(Client).filter(Client.id == clid).delete(synchronize_session=False)
    db.commit(); db.close()
