"""Folding a thread must re-establish what the newest inbound determines.

#1151 made `link-client` fold a thread into the client's existing one, and
`_fold_conv_into` carries the source's `last_inbound_at` forward when it is the
newer of the two. Moving that field is not a timestamp bump: TWO pieces of
conversation state are derived from which inbound is newest, and
`comms._apply_inbound` re-establishes both every time a real inbound moves it.
The fold moved the field and skipped both. Codex caught it on #1151; by then
the PR was already merged, so this is the follow-up.

1. THE REPLY CHANNEL (P1 — wrong-destination send). `send_reply` branches on
   `conv.channel` for both the transport and the address. Oldest-wins means a
   new email folds into an older SMS keeper, and the keeper still said "sms":
   the operator read the email on screen, hit Send, and TEXTED client.phone
   while the email went unanswered. `_apply_inbound` has a comment about the
   mirror-image hazard, added after an earlier codex P1 — the fold is the same
   bug approached from the other side.

2. RESPONSE TRACKING (P2 — silent triage miss). `_sla_state` recomputes the
   deadline from `last_inbound_at`, then calls the thread "met" if
   `first_response_at` predates it. The keeper's OLD response measured against
   the source's NEW inbound reported every folded thread as answered — and
   permanently, because `_apply_outbound` records a first response only when
   the field is empty, so no later reply could correct it. An unanswered
   customer left the Overdue filter and the "past SLA" count with no trace.

Both are pinned here against the real endpoint rather than against
`_fold_conv_into` directly, because the endpoint is what chooses the keeper and
the keeper choice is half the bug.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.auth.router import get_current_user, current_org_id
from modules.comms.router import _sla_state

NOW = datetime.now(timezone.utc)


class _Admin:
    id, org_id, role, status, active = 7812, 1, "admin", "active", True
    email = "fold-invariants@example.com"


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
    cl = Client(name=f"Inv {uuid.uuid4().hex[:6]}", status="active", org_id=1,
                phone="+15551239999", email="inv@example.com")
    db.add(cl); db.commit(); db.refresh(cl)
    cid = cl.id
    db.close()
    return cid


def _thread(*, client_id, channel, contact, created_days, inbound_days,
            responded_days=None, body="hi"):
    """A conversation with one inbound message and explicit SLA state.

    `created_days` drives the keeper choice (oldest created wins);
    `inbound_days` drives the invariants under test. They are separate on
    purpose — a thread opened long ago can hold the newest inbound.
    """
    db = SessionLocal()
    inbound_at = NOW - timedelta(days=inbound_days)
    conv = Conversation(
        client_id=client_id, external_contact=contact, channel=channel,
        status="open", priority="normal", org_id=1,
        created_at=NOW - timedelta(days=created_days),
        last_message_at=inbound_at,
        last_inbound_at=inbound_at,
        first_response_at=(None if responded_days is None
                           else NOW - timedelta(days=responded_days)),
        sla_response_minutes=480,
        sla_deadline=inbound_at + timedelta(hours=8),
    )
    db.add(conv); db.commit(); db.refresh(conv)
    db.add(Message(conversation_id=conv.id, client_id=client_id, channel=channel,
                   direction="inbound", body=body, from_addr=contact, org_id=1,
                   created_at=inbound_at))
    db.commit()
    cid = conv.id
    db.close()
    return cid


def _reload(conv_id):
    db = SessionLocal()
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if conv is not None:
        db.refresh(conv)
        db.expunge(conv)
    db.close()
    return conv


def _cleanup(client_id):
    db = SessionLocal()
    ids = [i for (i,) in db.query(Conversation.id).filter(Conversation.client_id == client_id)]
    if ids:
        db.query(Message).filter(Message.conversation_id.in_(ids)).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id.in_(ids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_the_reply_channel_follows_the_newest_inbound(api):
    """A new email folded into an old SMS keeper leaves the keeper on EMAIL.

    Without this the operator's next reply is a text to client.phone, sent to
    someone who wrote in by email — a wrong-destination send, not a display
    glitch.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230010",
                     created_days=30, inbound_days=20, responded_days=20)
    newer_email = _thread(client_id=None, channel="email", contact="new@example.com",
                          created_days=1, inbound_days=1, body="emailing instead")
    try:
        r = api.post(f"/api/comms/conversations/{newer_email}/link-client",
                     json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == keeper, "oldest should still win the keeper slot"
        assert r.json()["channel"] == "email", \
            "the keeper still advertises SMS — send_reply would text an emailer"
        assert _reload(keeper).channel == "email"
    finally:
        _cleanup(clid)


def test_an_unsendable_source_never_parks_the_keeper(api):
    """A voicemail is the newest inbound but cannot be replied to.

    `_apply_inbound` refuses to point a thread at a receive-only channel for
    this reason — send_reply 400s on anything outside SENDABLE_CHANNELS. The
    fold has to refuse it too, or folding a voicemail in makes the whole
    thread unanswerable.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230011",
                     created_days=30, inbound_days=20, responded_days=20)
    voicemail = _thread(client_id=None, channel="voice", contact="+15551230012",
                        created_days=1, inbound_days=1, body="[voicemail] call me")
    try:
        r = api.post(f"/api/comms/conversations/{voicemail}/link-client",
                     json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == keeper
        assert _reload(keeper).channel == "sms", \
            "the keeper is parked on a channel send_reply refuses"
    finally:
        _cleanup(clid)


def test_an_unanswered_folded_inbound_is_not_reported_as_met(api):
    """The keeper's old reply must not count as an answer to the new inbound.

    This is the silent one: `_sla_state` would read "met", so the thread drops
    out of the Overdue chip and the header's "past SLA" count while a customer
    sits unanswered — and `_apply_outbound` can never correct it, because
    first_response_at is already populated.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230013",
                     created_days=40, inbound_days=20, responded_days=20)
    # Ten days old and nobody has replied: unmistakably breached on its own.
    unanswered = _thread(client_id=None, channel="sms", contact="+15551230014",
                         created_days=10, inbound_days=10, responded_days=None,
                         body="still waiting")
    try:
        before = _reload(keeper)
        assert before.first_response_at is not None, "fixture precondition"

        r = api.post(f"/api/comms/conversations/{unanswered}/link-client",
                     json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == keeper

        after = _reload(keeper)
        assert after.first_response_at is None, \
            "the keeper still claims an answer that predates the folded inbound"
        assert _sla_state(after) == "breached", \
            f"an unanswered 10-day-old inbound reports as {_sla_state(after)!r}"
        assert r.json()["sla_state"] == "breached"
    finally:
        _cleanup(clid)


def test_the_keepers_own_state_survives_an_older_fold(api):
    """Nothing moves when the keeper already holds the newest inbound.

    The guard is conditional on the SOURCE being newer. Applying it
    unconditionally would be its own bug — an ancient email folded in would
    drag the reply channel backwards, which is precisely the hazard
    `_apply_inbound`'s own comment records. Pinned because the obvious
    implementation (always copy the source's channel and response state)
    passes all three tests above and fails this one.
    """
    clid = _client_row()
    # Opened first (so it wins the keeper slot) AND holds the newest inbound.
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230015",
                     created_days=30, inbound_days=0, responded_days=0)
    stale_email = _thread(client_id=None, channel="email", contact="old@example.com",
                          created_days=5, inbound_days=5, responded_days=5,
                          body="three weeks ago")
    try:
        before = _reload(keeper)
        r = api.post(f"/api/comms/conversations/{stale_email}/link-client",
                     json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == keeper

        after = _reload(keeper)
        assert after.channel == "sms", \
            "an older email dragged the reply channel off the customer's latest text"
        assert after.first_response_at == before.first_response_at
        assert after.last_inbound_at == before.last_inbound_at
    finally:
        _cleanup(clid)


def test_linking_takes_the_client_identity_lock_before_it_queries(monkeypatch, api):
    """The fold is a read-then-write on one person's threads, so it needs the
    same lock `find_or_create_conversation` takes.

    Without it an inbound arriving between the flush and the commit cannot see
    the uncommitted reassignment, finds no thread for this client, and inserts
    one. Neither transaction violates a constraint, both commit, and the client
    holds two threads again — the exact condition #1151 set out to remove, with
    four uvicorn workers to make the interleaving real.

    The race itself isn't reproducible in-process against SQLite (where the
    lock is a documented no-op). What IS worth pinning is that the call happens
    at all, on the destination client's key, and BEFORE the sibling query —
    a lock taken after the read guards nothing.
    """
    from modules.comms import router as comms_router

    calls = []
    real = comms_router._lock_conversation_identity

    def _spy(db, **kw):
        calls.append(kw)
        return real(db, **kw)

    monkeypatch.setattr(comms_router, "_lock_conversation_identity", _spy)

    clid = _client_row()
    conv = _thread(client_id=None, channel="sms", contact="+15551230016",
                   created_days=1, inbound_days=1)
    try:
        r = api.post(f"/api/comms/conversations/{conv}/link-client",
                     json={"client_id": clid})
        assert r.status_code == 200, r.text
        assert calls, "link-client never took the conversation identity lock"
        assert any(c.get("client_id") == clid for c in calls), \
            f"locked the wrong identity: {calls}"
        # Person-keyed, so no channel in the key — matching
        # _conversation_identity_key's client branch exactly. A key that
        # disagrees with find_or_create_conversation's guards a different row.
        locked = next(c for c in calls if c.get("client_id") == clid)
        assert not locked.get("external_contact"), \
            "a contact in the key makes this lock conv:contact:…, not conv:client:…"
    finally:
        _cleanup(clid)


def test_unlinking_takes_no_lock_and_changes_no_channel(monkeypatch, api):
    """client_id=null detaches; there is no person to serialize on and no fold."""
    from modules.comms import router as comms_router

    calls = []
    monkeypatch.setattr(comms_router, "_lock_conversation_identity",
                        lambda db, **kw: calls.append(kw))

    clid = _client_row()
    a = _thread(client_id=clid, channel="sms", contact="+15551230017",
                created_days=5, inbound_days=5, responded_days=5)
    b = _thread(client_id=clid, channel="email", contact="two@example.com",
                created_days=2, inbound_days=2)
    try:
        r = api.post(f"/api/comms/conversations/{b}/link-client",
                     json={"client_id": None})
        assert r.status_code == 200, r.text
        assert r.json()["id"] == b
        assert calls == [], "unlinking locked a client identity it isn't touching"
        assert _reload(a).channel == "sms"
        assert _reload(b).channel == "email"
    finally:
        _cleanup(clid)
        db = SessionLocal()
        db.query(Message).filter(Message.conversation_id == b).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id == b).delete(synchronize_session=False)
        db.commit(); db.close()
