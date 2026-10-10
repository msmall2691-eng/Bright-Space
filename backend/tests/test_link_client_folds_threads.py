"""Linking a thread to a client folds it into the client's existing thread.

Before #1105 the `(client_id, channel)` unique index made a second thread on
the same channel impossible, so `link-client` could re-parent without merging
and nothing went wrong. #1105 dropped that index to key threads on the PERSON,
which removed the accident of enforcement holding this together: a client could
then hold two conversations while `find_or_create_conversation`'s person-keyed
lookup picked one — so half the history quietly stopped appearing in the inbox.
#1105's own docstring flagged it and deferred it, because folding moves message
rows and that PR was scoped not to. This is that fix.

The fold itself is `_fold_conv_into` (modules/clients/router.py), already used
by the phone-add path. Every message moves onto the keeper; only the emptied
shell is deleted, so nothing is lost.

The response contract is what will bite a caller: the endpoint returns the
KEEPER, whose id differs from the posted conv_id whenever a fold happened. The
conversation you posted about may no longer exist — pages/Comms.jsx was
reloading the stale id and is fixed in the same change.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7811, 1, "admin", "active", True
    email = "fold-link@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _client_row():
    db = SessionLocal()
    cl = Client(name=f"Fold {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(cl); db.commit(); db.refresh(cl)
    cid = cl.id
    db.close()
    return cid


def _thread(*, client_id, channel, contact, body, age_days):
    """A conversation with one message, created `age_days` ago."""
    db = SessionLocal()
    conv = Conversation(client_id=client_id, external_contact=contact,
                        channel=channel, status="open", org_id=1,
                        created_at=datetime.now(timezone.utc) - timedelta(days=age_days))
    db.add(conv); db.commit(); db.refresh(conv)
    db.add(Message(conversation_id=conv.id, client_id=client_id, channel=channel,
                   direction="inbound", body=body, from_addr=contact, org_id=1))
    db.commit()
    cid = conv.id
    db.close()
    return cid


def _cleanup(client_id):
    db = SessionLocal()
    ids = [i for (i,) in db.query(Conversation.id).filter(Conversation.client_id == client_id)]
    if ids:
        db.query(Message).filter(Message.conversation_id.in_(ids)).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id.in_(ids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
    db.commit(); db.close()


def _bodies(conv_id):
    db = SessionLocal()
    out = {m.body for m in db.query(Message).filter(Message.conversation_id == conv_id).all()}
    db.close()
    return out


def _exists(conv_id):
    db = SessionLocal()
    found = db.query(Conversation).filter(Conversation.id == conv_id).first() is not None
    db.close()
    return found


def test_links_without_folding_when_the_client_has_no_thread(api):
    """The original behaviour, unchanged: re-parent, same id back."""
    clid = _client_row()
    conv = _thread(client_id=None, channel="sms", contact="+15551230001",
                   body="do you clean condos?", age_days=1)
    try:
        r = api.post(f"/api/comms/conversations/{conv}/link-client", json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == conv
        assert r.json()["client_id"] == clid
        assert _exists(conv)
    finally:
        _cleanup(clid)


def test_folds_into_the_existing_thread_and_keeps_every_message(api):
    clid = _client_row()
    existing = _thread(client_id=clid, channel="sms", contact="+15551230002",
                       body="older thread", age_days=10)
    unknown = _thread(client_id=None, channel="email", contact="fold@example.com",
                      body="newer thread", age_days=1)
    try:
        r = api.post(f"/api/comms/conversations/{unknown}/link-client", json={"client_id": clid})
        assert r.status_code == 200, r.text

        # Oldest wins, so the id changes out from under the caller.
        assert r.json()["id"] == existing
        assert r.json()["id"] != unknown

        assert not _exists(unknown), "the emptied shell should be gone"
        assert _bodies(existing) == {"older thread", "newer thread"}, \
            "a message was lost in the fold — the whole point of this change"

        db = SessionLocal()
        n = db.query(Conversation).filter(Conversation.client_id == clid).count()
        db.close()
        assert n == 1, "the client still holds more than one thread"
    finally:
        _cleanup(clid)


def test_the_linked_thread_wins_when_it_is_the_older_one(api):
    """Oldest wins SYMMETRICALLY — the client's existing thread folds into the
    one being linked when that one came first. Pinned because the obvious
    implementation (always fold the linked thread into the existing one) passes
    the test above and fails this one."""
    clid = _client_row()
    newer_existing = _thread(client_id=clid, channel="sms", contact="+15551230003",
                             body="recent", age_days=1)
    older_unknown = _thread(client_id=None, channel="email", contact="old@example.com",
                            body="ancient", age_days=30)
    try:
        r = api.post(f"/api/comms/conversations/{older_unknown}/link-client",
                     json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == older_unknown, "the older thread should be the keeper"
        assert not _exists(newer_existing)
        assert _bodies(older_unknown) == {"ancient", "recent"}
    finally:
        _cleanup(clid)


def test_unlinking_never_folds(api):
    """client_id=null detaches and must not merge anything."""
    clid = _client_row()
    a = _thread(client_id=clid, channel="sms", contact="+15551230004", body="one", age_days=5)
    b = _thread(client_id=clid, channel="email", contact="two@example.com", body="two", age_days=2)
    try:
        r = api.post(f"/api/comms/conversations/{b}/link-client", json={"client_id": None})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == b
        assert _exists(a) and _exists(b)
    finally:
        _cleanup(clid)
        db = SessionLocal()
        db.query(Message).filter(Message.conversation_id == b).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id == b).delete(synchronize_session=False)
        db.commit(); db.close()
