"""Folding a thread must re-derive what hangs off its newest inbound.

`conversations` carries DENORMALIZED copies of facts that live in `messages` —
`channel` (the reply channel), `external_contact` (where to send),
`last_inbound_at`, `first_response_at`, `sla_deadline`. `comms._apply_inbound`
and `_apply_outbound` keep those copies honest as messages arrive. A fold moves
messages between threads, so it owes the same bookkeeping.

#1151 did none of it, and shipped three bugs to production (the reply channel,
response tracking, and a missing identity lock). The first attempt at this fix
copied the SOURCE's aggregates when the source's inbound was newer; codex found
three more holes in that, all one shape: **after a fold, neither pre-merge row's
aggregate is correct, because the merged history interleaves.** No rule for
choosing between two stale copies fixes that.

So `_rederive_inbound_state` derives from the rows the keeper now holds, and
these cases are written against the ways the aggregate approach lied:

  * the newest inbound and the newest SENDABLE inbound are different messages
    whenever a voicemail is involved (`_apply_inbound` advances the timestamp
    for voice but refuses to point `channel` at it);
  * `send_reply` falls back to `conv.external_contact`, and `Client.email` is
    nullable — switching channel without the address handed a phone number to
    `_send_email`;
  * "has anyone replied since the newest inbound?" can be answered by a message
    on the OTHER thread.

Every fixture writes real Message rows and derives the conversation's
aggregates from them, because a test that sets `first_response_at` with no
outbound message to match is asserting against data the app cannot produce —
which is how the first version of this file passed over the interleaving case.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.auth.router import get_current_user, current_org_id
from modules.comms.router import _sla_state, SENDABLE_CHANNELS

NOW = datetime.now(timezone.utc)


def _ago(days):
    return NOW - timedelta(days=days)


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


def _client_row(*, email="inv@example.com"):
    db = SessionLocal()
    cl = Client(name=f"Inv {uuid.uuid4().hex[:6]}", status="active", org_id=1,
                phone="+15551239999", email=email)
    db.add(cl); db.commit(); db.refresh(cl)
    cid = cl.id
    db.close()
    return cid


def _thread(*, client_id, channel, contact, created_days, msgs):
    """A conversation plus real messages, with aggregates derived from them.

    `msgs` is a list of (direction, channel, days_ago, addr) — exactly what
    `_apply_inbound`/`_apply_outbound` would have seen arriving, so the stored
    aggregates below match the rows. That agreement is the precondition the
    fold has to preserve, and faking it is how you write a green test over a
    broken fold.
    """
    db = SessionLocal()
    conv = Conversation(
        client_id=client_id, external_contact=contact, channel=channel,
        status="open", priority="normal", org_id=1,
        created_at=_ago(created_days),
    )
    db.add(conv); db.commit(); db.refresh(conv)

    rows = sorted(msgs, key=lambda m: -m[2])  # oldest first
    for direction, ch, days, addr in rows:
        db.add(Message(conversation_id=conv.id, client_id=client_id, channel=ch,
                       direction=direction, body=f"{direction} {ch} {days}d",
                       from_addr=addr, org_id=1, created_at=_ago(days),
                       is_internal_note=(direction == "note")))
    db.commit()

    # Aggregates, the way the live inbound/outbound paths maintain them.
    ins = [m for m in rows if m[0] == "inbound"]
    outs = [m for m in rows if m[0] == "outbound"]
    conv.last_message_at = _ago(min(m[2] for m in rows)) if rows else None
    conv.last_inbound_at = _ago(min(m[2] for m in ins)) if ins else None
    conv.last_outbound_at = _ago(min(m[2] for m in outs)) if outs else None
    if ins:
        newest_in = min(m[2] for m in ins)
        after = [m for m in outs if m[2] < newest_in]
        conv.first_response_at = _ago(max(m[2] for m in after)) if after else None
        sendable = [m for m in ins if m[1] in SENDABLE_CHANNELS]
        if sendable:
            conv.channel = min(sendable, key=lambda m: m[2])[1]
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


def _link(api, conv_id, client_id):
    r = api.post(f"/api/comms/conversations/{conv_id}/link-client",
                 json={"client_id": client_id})
    assert r.status_code == 200, r.text
    return r.json()


# ── the reply channel ────────────────────────────────────────────────────────

def test_the_reply_channel_follows_the_newest_inbound(api):
    """A new email folded into an old SMS keeper leaves the keeper on EMAIL.

    Without it the operator's next reply is a text to client.phone, sent to
    someone who wrote in by email — a wrong-destination send, not a display
    glitch.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230010",
                     created_days=30,
                     msgs=[("inbound", "sms", 20, "+15551230010"),
                           ("outbound", "sms", 19, None)])
    newer = _thread(client_id=None, channel="email", contact="new@example.com",
                    created_days=1,
                    msgs=[("inbound", "email", 1, "new@example.com")])
    try:
        body = _link(api, newer, clid)
        assert body["id"] == keeper, "oldest should still win the keeper slot"
        assert body["channel"] == "email", \
            "the keeper still advertises SMS — send_reply would text an emailer"
    finally:
        _cleanup(clid)


def test_a_voicemail_does_not_hand_the_channel_to_a_stale_email(api):
    """The newest inbound and the newest SENDABLE inbound differ here.

    `_apply_inbound` advances `last_inbound_at` for a voicemail but refuses to
    point `channel` at it, so the source's aggregates read "newest inbound =
    today" and "channel = email (3 days ago)". Copying them gave the keeper
    `email` even though its own SMS from yesterday is the newest message anyone
    can actually reply to. The source's timestamp is not evidence that the
    channel it retained is the newest sendable one.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230020",
                     created_days=30,
                     msgs=[("inbound", "sms", 1, "+15551230020")])
    src = _thread(client_id=None, channel="email", contact="vm@example.com",
                  created_days=10,
                  msgs=[("inbound", "email", 3, "vm@example.com"),
                        ("inbound", "voice", 0, "+15551230021")])
    try:
        body = _link(api, src, clid)
        assert body["id"] == keeper
        assert body["channel"] == "sms", \
            "took the source's retained email channel over a newer sendable SMS"
    finally:
        _cleanup(clid)


def test_the_send_address_travels_with_the_channel(api):
    """Switching to email must not leave a phone number as the fallback address.

    `send_reply` resolves `client.email` for an email thread and falls back to
    `conv.external_contact`. `Client.email` is nullable and an SMS-only client
    routinely has none, so changing the channel without the address handed a
    phone number to `_send_email` — turning "wrong channel, delivered" into
    "right channel, undeliverable".
    """
    clid = _client_row(email=None)
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230030",
                     created_days=30,
                     msgs=[("inbound", "sms", 20, "+15551230030")])
    src = _thread(client_id=None, channel="email", contact="writes@example.com",
                  created_days=1,
                  msgs=[("inbound", "email", 1, "writes@example.com")])
    try:
        body = _link(api, src, clid)
        assert body["id"] == keeper
        assert body["channel"] == "email"
        after = _reload(keeper)
        assert after.external_contact == "writes@example.com", \
            f"send_reply would email {after.external_contact!r}"
    finally:
        _cleanup(clid)


def test_an_unsendable_source_never_parks_the_keeper(api):
    """A voicemail is the newest inbound but cannot be replied to.

    `_apply_inbound` refuses to point a thread at a receive-only channel
    because `send_reply` 400s on anything outside SENDABLE_CHANNELS. The fold
    has to refuse it too, or folding a voicemail in makes the thread
    unanswerable.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230040",
                     created_days=30,
                     msgs=[("inbound", "sms", 20, "+15551230040")])
    vm = _thread(client_id=None, channel="voice", contact="+15551230041",
                 created_days=1,
                 msgs=[("inbound", "voice", 1, "+15551230041")])
    try:
        body = _link(api, vm, clid)
        assert body["id"] == keeper
        assert _reload(keeper).channel == "sms", \
            "the keeper is parked on a channel send_reply refuses"
    finally:
        _cleanup(clid)


# ── response tracking ───────────────────────────────────────────────────────

def test_an_unanswered_folded_inbound_is_not_reported_as_met(api):
    """The keeper's old reply must not count as an answer to the new inbound.

    This is the silent one: `_sla_state` would read "met", so the thread drops
    out of the Overdue chip and the header's "past SLA" count while a customer
    sits unanswered — and `_apply_outbound` can never correct it, because
    first_response_at is already populated.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230050",
                     created_days=40,
                     msgs=[("inbound", "sms", 20, "+15551230050"),
                           ("outbound", "sms", 19, None)])
    unanswered = _thread(client_id=None, channel="sms", contact="+15551230051",
                         created_days=10,
                         msgs=[("inbound", "sms", 10, "+15551230051")])
    try:
        assert _reload(keeper).first_response_at is not None, "fixture precondition"
        body = _link(api, unanswered, clid)
        assert body["id"] == keeper

        after = _reload(keeper)
        assert after.first_response_at is None, \
            "the keeper still claims an answer that predates the folded inbound"
        assert _sla_state(after) == "breached", \
            f"an unanswered 10-day-old inbound reports as {_sla_state(after)!r}"
        assert body["sla_state"] == "breached"
    finally:
        _cleanup(clid)


def test_a_reply_on_the_other_thread_still_counts(api):
    """Interleaved history: the answer lives on the keeper, the question on the
    source.

    The source took an inbound ten days ago and nobody replied *there*, but the
    keeper sent an outbound nine days ago — after it. Copying the source's NULL
    marked the merged thread unanswered while its own history contains the
    reply, which is the mirror of the bug above and just as wrong. First
    response is the earliest outbound after the newest inbound across
    EVERYTHING the keeper now holds.

    This asserts the recorded response, NOT an SLA verdict. A reply a day after
    the inbound is late, so the honest verdict here is still "breached" — the
    thread was answered, just not in time. An earlier draft of this case
    asserted "met" and failed; the code was right and the expectation was
    wrong. Pinning the verdict would also make the case depend on the
    business-hours policy, which is not what it is about.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230060",
                     created_days=40,
                     msgs=[("inbound", "sms", 20, "+15551230060"),
                           ("outbound", "sms", 9, None)])
    src = _thread(client_id=None, channel="sms", contact="+15551230061",
                  created_days=10,
                  msgs=[("inbound", "sms", 10, "+15551230061")])
    try:
        body = _link(api, src, clid)
        assert body["id"] == keeper
        after = _reload(keeper)
        assert after.first_response_at is not None, \
            "the reply nine days ago answered the inbound ten days ago"
        # Specifically the keeper's outbound, not the keeper's pre-fold
        # aggregate (which pointed at a reply from nineteen days ago).
        recorded = after.first_response_at
        if recorded.tzinfo is None:
            recorded = recorded.replace(tzinfo=timezone.utc)
        assert abs((recorded - _ago(9)).total_seconds()) < 60, \
            f"recorded {recorded} rather than the 9-day-old reply"
    finally:
        _cleanup(clid)


def test_an_internal_note_is_not_an_answer(api):
    """A note is written with direction='note' and must count as neither an
    inbound nor a reply — telling a teammate is not answering the customer."""
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230070",
                     created_days=40,
                     msgs=[("inbound", "sms", 20, "+15551230070"),
                           ("outbound", "sms", 19, None)])
    src = _thread(client_id=None, channel="sms", contact="+15551230071",
                  created_days=10,
                  msgs=[("inbound", "sms", 10, "+15551230071"),
                        ("note", "sms", 9, None)])
    try:
        body = _link(api, src, clid)
        assert body["id"] == keeper
        after = _reload(keeper)
        assert after.first_response_at is None, \
            "an internal note was counted as a reply to the customer"
        assert _sla_state(after) == "breached"
    finally:
        _cleanup(clid)


# ── not over-applying ───────────────────────────────────────────────────────

def test_the_keepers_own_newest_inbound_keeps_its_channel(api):
    """Nothing moves when the keeper already holds the newest sendable inbound.

    Applying the derivation blindly to the source would drag the reply channel
    BACKWARDS when an ancient email is folded in — precisely the hazard
    `_apply_inbound`'s own comment records (it was added after an earlier codex
    P1). Pinned because the obvious implementation passes everything above and
    fails this.
    """
    clid = _client_row()
    keeper = _thread(client_id=clid, channel="sms", contact="+15551230080",
                     created_days=30,
                     msgs=[("inbound", "sms", 0, "+15551230080")])
    stale = _thread(client_id=None, channel="email", contact="old@example.com",
                    created_days=5,
                    msgs=[("inbound", "email", 5, "old@example.com")])
    try:
        before = _reload(keeper)
        body = _link(api, stale, clid)
        assert body["id"] == keeper
        after = _reload(keeper)
        assert after.channel == "sms", \
            "an older email dragged the reply channel off the customer's latest text"
        assert after.external_contact == before.external_contact
        assert after.last_inbound_at == before.last_inbound_at
    finally:
        _cleanup(clid)


# ── the identity lock ───────────────────────────────────────────────────────

def test_linking_takes_the_client_identity_lock_before_it_queries(monkeypatch, api):
    """The fold is a read-then-write on one person's threads, so it needs the
    same lock `find_or_create_conversation` takes.

    Without it an inbound arriving between the flush and the commit cannot see
    the uncommitted reassignment, finds no thread for this client, and inserts
    one. Neither transaction violates a constraint, both commit, and the client
    holds two threads again — the exact condition #1151 set out to remove, with
    four uvicorn workers to make the interleaving real.

    The race itself isn't reproducible in-process against SQLite, where the
    lock is a documented no-op. What IS worth pinning is that the call happens
    at all, on the destination client's key, and BEFORE the sibling query — a
    lock taken after the read guards nothing.
    """
    from modules.comms import router as comms_router

    calls = []
    real = comms_router._lock_conversation_identity

    def _spy(db, **kw):
        calls.append(kw)
        return real(db, **kw)

    monkeypatch.setattr(comms_router, "_lock_conversation_identity", _spy)

    clid = _client_row()
    conv = _thread(client_id=None, channel="sms", contact="+15551230090",
                   created_days=1, msgs=[("inbound", "sms", 1, "+15551230090")])
    try:
        _link(api, conv, clid)
        assert calls, "link-client never took the conversation identity lock"
        assert any(c.get("client_id") == clid for c in calls), \
            f"locked the wrong identity: {calls}"
        # Person-keyed, so no channel in the key — matching
        # `_conversation_identity_key`'s client branch exactly. A key that
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
    a = _thread(client_id=clid, channel="sms", contact="+15551230100",
                created_days=5, msgs=[("inbound", "sms", 5, "+15551230100")])
    b = _thread(client_id=clid, channel="email", contact="two@example.com",
                created_days=2, msgs=[("inbound", "email", 2, "two@example.com")])
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
