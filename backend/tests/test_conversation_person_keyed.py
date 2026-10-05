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
