"""Tier 4a: a thread is a person, not a person-and-a-channel.

Alembic 131 drops uq_conversations_client_channel and
find_or_create_conversation stops filtering on channel for a known client. The
effect the owner actually asked for: a customer who texts and then emails is
ONE conversation, so the office reads a whole exchange instead of half of it in
each of two threads.

Two things this had to get right, and both are easy to get wrong:

  * `conversations.channel` stops meaning identity and starts meaning "reply
    on this by default". It therefore has to FOLLOW the customer — answering a
    text must not email them — which `_apply_inbound` now does.

  * ...but only for a channel we can send on. `voice` is receive-only
    (send_reply raises "not sendable"), so letting a voicemail set the reply
    channel would leave the thread unanswerable until someone edited the
    database by hand. That is the sharpest edge in this change and it is the
    reason SENDABLE_CHANNELS exists.

Unlinked contacts stay channel-scoped on purpose — see the docstring on
find_or_create_conversation. A phone number and an email address are two
different handles with no honest way to know they are one person.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.comms.router import (
    find_or_create_conversation, _apply_inbound, SENDABLE_CHANNELS,
)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def client(db):
    c = Client(name=f"Omni {uuid.uuid4().hex[:6]}", email="omni@example.com",
               phone="+12075550143", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    yield c
    ids = [i for (i,) in db.query(Conversation.id).filter(Conversation.client_id == c.id)]
    if ids:
        db.query(Message).filter(Message.conversation_id.in_(ids)).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id.in_(ids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit()


def _inbound(db, conv, channel, body="hi"):
    """An inbound message on a thread, applied the way the webhooks do."""
    m = Message(conversation_id=conv.id, client_id=conv.client_id, channel=channel,
                direction="inbound", body=body, status="received", org_id=conv.org_id)
    db.add(m); db.flush()
    _apply_inbound(conv, m)
    db.commit()
    return m


class TestOneThreadPerPerson:
    def test_sms_and_email_land_in_the_same_thread(self, db, client):
        sms = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                          external_contact=client.phone, org_id=1)
        db.commit()
        email = find_or_create_conversation(db, channel="email", client_id=client.id,
                                            external_contact=client.email, org_id=1)
        db.commit()
        assert email.id == sms.id, "a second channel opened a second thread"
        assert db.query(Conversation).filter(Conversation.client_id == client.id).count() == 1

    def test_a_voicemail_joins_it_too(self, db, client):
        first = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                            external_contact=client.phone, org_id=1)
        db.commit()
        voice = find_or_create_conversation(db, channel="voice", client_id=client.id,
                                            external_contact=client.phone, org_id=1)
        db.commit()
        assert voice.id == first.id

    def test_the_transcript_holds_every_channel(self, db, client):
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        _inbound(db, conv, "sms", "can you come Friday")
        _inbound(db, conv, "email", "attaching the gate photo")
        _inbound(db, conv, "voice", "[voicemail transcript]")

        got = (db.query(Message).filter(Message.conversation_id == conv.id)
                 .order_by(Message.id).all())
        assert [m.channel for m in got] == ["sms", "email", "voice"]


class TestDefaultReplyChannel:
    def test_it_follows_the_customer(self, db, client):
        # Started as email; they then text. Replying must text back.
        conv = find_or_create_conversation(db, channel="email", client_id=client.id,
                                           external_contact=client.email, org_id=1)
        db.commit()
        assert conv.channel == "email"
        _inbound(db, conv, "sms")
        assert conv.channel == "sms"

    def test_a_voicemail_does_NOT_strand_the_thread(self, db, client):
        # The sharp edge: voice is receive-only. If a voicemail set the reply
        # channel, send_reply would 400 on this thread forever.
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        _inbound(db, conv, "voice", "[voicemail transcript]")
        assert conv.channel == "sms", "a voicemail hijacked the reply channel"
        assert conv.channel in SENDABLE_CHANNELS

    def test_the_thread_never_parks_on_an_unsendable_channel(self, db, client):
        conv = find_or_create_conversation(db, channel="email", client_id=client.id,
                                           external_contact=client.email, org_id=1)
        db.commit()
        for ch in ("voice", "sms", "voice", "email", "voice"):
            _inbound(db, conv, ch)
            assert conv.channel in SENDABLE_CHANNELS, f"stranded after an inbound {ch}"
        assert conv.channel == "email"   # the last SENDABLE one, not the last one


class TestTheInboxChannelTabsStillWork:
    """The regression this change nearly shipped.

    The inbox's channel tabs filter `?channel=`, which used to compare against
    `Conversation.channel`. Once a voicemail joins the person's existing SMS
    thread — whose channel stays "sms", because voice is not sendable — that
    comparison matches nothing and the Voicemail tab goes permanently empty.
    The filter asks about the thread's MESSAGES now.
    """

    def test_a_thread_is_findable_by_every_channel_it_contains(self, db, client):
        from modules.comms.router import Conversation as _C   # noqa: F401
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        _inbound(db, conv, "sms")
        _inbound(db, conv, "email")
        _inbound(db, conv, "voice")

        for ch in ("sms", "email", "voice"):
            found = (db.query(Conversation)
                       .filter(Conversation.id == conv.id,
                               Conversation.messages.any(Message.channel == ch))
                       .first())
            assert found is not None, f"thread not findable under the {ch} tab"

    def test_it_is_NOT_findable_under_a_channel_it_never_used(self, db, client):
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        _inbound(db, conv, "sms")
        found = (db.query(Conversation)
                   .filter(Conversation.id == conv.id,
                           Conversation.messages.any(Message.channel == "email"))
                   .first())
        assert found is None

    def test_the_thread_channel_alone_would_have_missed_the_voicemail(self, db, client):
        # Stated as its own case because it is the exact failure: the old
        # filter's predicate, run against the new data shape.
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        _inbound(db, conv, "voice", "[voicemail transcript]")
        assert conv.channel == "sms"                    # the old filter's value
        assert db.query(Message).filter(               # but the voicemail is right there
            Message.conversation_id == conv.id, Message.channel == "voice").count() == 1


class TestUnlinkedContactsStayChannelScoped:
    def test_two_handles_are_not_assumed_to_be_one_person(self, db):
        phone = f"+1207555{uuid.uuid4().int % 10000:04d}"
        a = find_or_create_conversation(db, channel="sms", external_contact=phone, org_id=1)
        db.commit()
        b = find_or_create_conversation(db, channel="email",
                                        external_contact="stranger@example.com", org_id=1)
        db.commit()
        assert a.id != b.id
        db.query(Conversation).filter(Conversation.id.in_([a.id, b.id])).delete(
            synchronize_session=False)
        db.commit()

    def test_the_same_handle_on_the_same_channel_still_reuses(self, db):
        phone = f"+1207555{uuid.uuid4().int % 10000:04d}"
        a = find_or_create_conversation(db, channel="sms", external_contact=phone, org_id=1)
        db.commit()
        b = find_or_create_conversation(db, channel="sms", external_contact=phone, org_id=1)
        db.commit()
        assert a.id == b.id
        db.query(Conversation).filter(Conversation.id == a.id).delete(synchronize_session=False)
        db.commit()


class TestABackfillDoesNotHijackTheReplyChannel:
    """codex P1: the reply channel must follow the CUSTOMER'S clock.

    `_apply_inbound` sets `conv.channel = msg.channel`, and `now` is
    `msg.created_at` when the message carries one. A first-time Gmail sync or
    an expired-cursor resync imports real emails with real old timestamps —
    so without a recency guard a three-week-old email takes over a thread
    whose customer texted yesterday, and the next reply emails someone who is
    waiting for a text.

    Before alembic 131 this was impossible: the old email landed in its own
    email-channel thread and could not touch the SMS one. Unifying the thread
    is what exposes it, which is why the guard belongs to this change.
    """

    def test_an_old_email_does_not_steal_a_thread_from_a_recent_text(self, db, client):
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()

        # Yesterday: the customer texts. This is their latest real contact.
        recent = Message(conversation_id=conv.id, client_id=client.id, channel="sms",
                         direction="inbound", body="you coming thursday?",
                         status="received", org_id=1,
                         created_at=datetime.now(timezone.utc) - timedelta(days=1))
        db.add(recent); db.flush(); _apply_inbound(conv, recent); db.commit()
        assert conv.channel == "sms"

        # Now a backfill drags in an email from three weeks ago.
        old = Message(conversation_id=conv.id, client_id=client.id, channel="email",
                      direction="inbound", body="quote request from last month",
                      status="received", org_id=1,
                      created_at=datetime.now(timezone.utc) - timedelta(days=21))
        db.add(old); db.flush(); _apply_inbound(conv, old); db.commit()

        assert conv.channel == "sms", (
            "a backfilled email took over the reply channel — the next reply "
            "would email a customer whose latest contact was a text"
        )

    def test_a_genuinely_newer_email_still_takes_over(self, db, client):
        """The guard must not freeze the channel — that would break the
        feature it is protecting. Only BACKWARDS moves are refused."""
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        old_sms = Message(conversation_id=conv.id, client_id=client.id, channel="sms",
                          direction="inbound", body="text first", status="received",
                          org_id=1,
                          created_at=datetime.now(timezone.utc) - timedelta(days=3))
        db.add(old_sms); db.flush(); _apply_inbound(conv, old_sms); db.commit()

        newer_email = Message(conversation_id=conv.id, client_id=client.id, channel="email",
                              direction="inbound", body="switching to email",
                              status="received", org_id=1,
                              created_at=datetime.now(timezone.utc))
        db.add(newer_email); db.flush(); _apply_inbound(conv, newer_email); db.commit()

        assert conv.channel == "email", "the channel stopped following the customer"

    def test_the_first_inbound_sets_the_channel_even_though_there_is_no_baseline(self, db, client):
        """`last_inbound_at` is NULL on a brand-new thread. A guard written as
        a bare `>=` against None would raise TypeError and drop the message."""
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        assert conv.last_inbound_at is None
        m = Message(conversation_id=conv.id, client_id=client.id, channel="email",
                    direction="inbound", body="first contact", status="received",
                    org_id=1, created_at=datetime.now(timezone.utc))
        db.add(m); db.flush(); _apply_inbound(conv, m); db.commit()
        assert conv.channel == "email"

    def test_a_naive_stored_timestamp_compares_without_blowing_up(self, db, client):
        """The trap this nearly shipped with.

        Every datetime column here is `Column(DateTime)` with no
        `timezone=True`, so a value READ BACK from Postgres is naive while
        `datetime.now(timezone.utc)` is aware. Comparing them raises
        `TypeError: can't compare offset-naive and offset-aware datetimes`.
        A guard that skipped `_as_utc` would pass on freshly-assigned objects
        and then 500 on every inbound message in production.
        """
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        # Naive, exactly as the DB hands it back.
        conv.last_inbound_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
        db.commit()

        m = Message(conversation_id=conv.id, client_id=client.id, channel="email",
                    direction="inbound", body="aware timestamp", status="received",
                    org_id=1, created_at=datetime.now(timezone.utc))
        db.add(m); db.flush()
        _apply_inbound(conv, m)          # must not raise
        db.commit()
        assert conv.channel == "email"


class TestThreadCreationIsSerialized:
    """codex P1: dropping the unique index removed the concurrency guard.

    `uq_conversations_client_channel` was not only a shape constraint — it was
    the only thing making find_or_create_conversation's read-then-insert safe.
    With it, two concurrent first messages for one client both inserted, one
    raised IntegrityError, and the savepoint returned the survivor. Without it
    neither insert violates anything, both succeed, and the person's messages
    split across two threads with no error raised anywhere.

    A true concurrency race needs two connections and is not what the curated
    suite should spend its time on. What IS worth pinning is that the lock is
    actually taken, keyed on the same identity the lookup uses, and that it
    never takes down an inbound message — because a lock keyed on the wrong
    thing, or one that throws, is worse than none.
    """

    def test_the_lock_is_taken_before_the_lookup_for_a_known_client(self, db, client, monkeypatch):
        import modules.comms.router as R
        calls = []
        monkeypatch.setattr(R, "_lock_conversation_identity",
                            lambda db, **kw: calls.append(kw))
        find_or_create_conversation(db, channel="sms", client_id=client.id,
                                    external_contact=client.phone, org_id=1)
        db.commit()
        assert calls, "thread creation ran with no identity lock at all"
        assert calls[0]["client_id"] == client.id

    def test_the_lock_key_matches_the_lookup_it_guards(self, db):
        """A known client locks on the PERSON — no channel. If the key kept
        the channel, SMS and email would take different locks and could still
        both insert, which is the exact race this is for."""
        from modules.comms.router import _conversation_identity_key
        sms = _conversation_identity_key(client_id=7, external_contact="+12075550143",
                                         channel="sms")
        email = _conversation_identity_key(client_id=7, external_contact="a@b.com",
                                           channel="email")
        assert sms == email == "conv:client:7"

        # An unlinked contact is channel-scoped, so its key must be too —
        # otherwise the lock is stricter than the lookup and serializes
        # unrelated threads.
        a = _conversation_identity_key(client_id=None, external_contact="+12075550143",
                                       channel="sms")
        b = _conversation_identity_key(client_id=None, external_contact="+12075550143",
                                       channel="email")
        assert a != b

        # Nothing to key on: no lock, rather than a lock on the empty string
        # that would serialize every anonymous thread in the system.
        assert _conversation_identity_key(client_id=None, external_contact=None,
                                          channel="sms") is None

    def test_a_locking_failure_does_not_drop_the_message(self, db, client, monkeypatch):
        """Degrade to today's behaviour, never to a lost text."""
        import modules.comms.router as R
        monkeypatch.setattr(R, "text",
                            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
        monkeypatch.setattr(db, "bind", db.bind)
        conv = find_or_create_conversation(db, channel="sms", client_id=client.id,
                                           external_contact=client.phone, org_id=1)
        db.commit()
        assert conv is not None and conv.client_id == client.id

    def test_sqlite_is_a_no_op_rather_than_an_error(self, db, client):
        """The suite runs on SQLite, which has no pg_advisory_xact_lock. The
        guard must notice the dialect instead of raising OperationalError on
        every inbound message locally."""
        from modules.comms.router import _lock_conversation_identity
        _lock_conversation_identity(db, client_id=client.id,
                                    external_contact=client.phone, channel="sms")
