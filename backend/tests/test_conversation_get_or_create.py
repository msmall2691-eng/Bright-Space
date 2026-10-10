"""find_or_create_conversation must reuse a person's thread, never duplicate it.

June 10 incident: client 91's only email conversation was resolved, the lookup
skipped resolved rows, and the INSERT hit uq_conversations_client_channel —
which poisoned the whole Gmail sync transaction, so the "Quote accepted"
notification email was retried (and re-failed) every 10 minutes and never
reached the inbox.

ALEMBIC 131 DROPPED THAT INDEX (threads are keyed to a person now, not a
person-and-channel), so the database no longer forces this behaviour. These
tests stay, and the fixture no longer creates the index, because the behaviour
was never really about the constraint: a customer replying to a closed thread
should re-open it rather than open a parallel one, and the Gmail sync must
still land the message somewhere real. What changed is that a violation is now
a silent duplicate instead of a loud IntegrityError — which is a weaker signal,
not a reason to stop checking.
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.comms.router import find_or_create_conversation, _apply_inbound
from modules.gmail.router import _thread_inbound_email


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Conv GetOrCreate Test", email="client91@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.rollback()
    conv_ids = [cid for (cid,) in db.query(Conversation.id).filter(Conversation.client_id == c.id)]
    if conv_ids:
        db.query(Message).filter(Message.conversation_id.in_(conv_ids)).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.id.in_(conv_ids)).delete(synchronize_session=False)
    db.query(Message).filter(Message.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _conv(db, c, status="open"):
    conv = Conversation(client_id=c.id, channel="email", status=status,
                        external_contact=c.email, subject="hello")
    db.add(conv); db.commit(); db.refresh(conv)
    return conv


def test_a_duplicate_is_now_possible_which_is_why_the_lookup_matters(ctx):
    """The inverse of the old sanity check, and the reason to keep the rest.

    This used to assert that the database REJECTED a second (client_id,
    channel) row. After alembic 131 it accepts one — so nothing stops a
    careless caller from stranding half a customer's history in a second
    thread except find_or_create_conversation getting it right. The tests
    below are now the only thing holding that.
    """
    db, c = ctx
    _conv(db, c, status="resolved")
    with db.begin_nested():
        db.add(Conversation(client_id=c.id, channel="email", status="open"))
    assert db.query(Conversation).filter(Conversation.client_id == c.id).count() == 2
    db.rollback()


def test_reuses_open_conversation(ctx):
    db, c = ctx
    conv = _conv(db, c, status="open")
    got = find_or_create_conversation(db, channel="email", client_id=c.id,
                                      external_contact=c.email)
    assert got.id == conv.id


def test_reuses_resolved_conversation_instead_of_doomed_insert(ctx):
    """The June 10 bug: a resolved conversation must be returned, not raced
    with an INSERT that the unique index is guaranteed to reject."""
    db, c = ctx
    conv = _conv(db, c, status="resolved")
    got = find_or_create_conversation(db, channel="email", client_id=c.id,
                                      external_contact=c.email)
    assert got.id == conv.id
    db.commit()
    assert db.query(Conversation).filter(Conversation.client_id == c.id).count() == 1


def test_inbound_email_reaches_and_reopens_resolved_conversation(ctx):
    """The accepted-quote notification must land in the existing thread (and
    re-open it) instead of vanishing in a constraint violation."""
    db, c = ctx
    conv = _conv(db, c, status="resolved")
    em = {"from_email": c.email, "to": "office@mainecleaningco.com",
          "subject": "✅ Quote QT-2026-0007 accepted",
          "body": "Harborview Rentals accepted quote QT-2026-0007.",
          "message_id": "<accept-0007@mail.example>", "date": None}
    created = _thread_inbound_email(db, c.id, em)
    db.commit()
    assert created is True
    db.refresh(conv)
    assert conv.status == "open"          # _apply_inbound re-opened it
    assert conv.unread_count == 1
    msgs = db.query(Message).filter(Message.conversation_id == conv.id).all()
    assert len(msgs) == 1
    assert msgs[0].subject.endswith("accepted")
    # Re-delivery of the same Message-ID dedupes instead of duplicating.
    assert _thread_inbound_email(db, c.id, dict(em)) is False
    db.commit()
    assert db.query(Message).filter(Message.conversation_id == conv.id).count() == 1


def test_new_conversation_still_created_when_none_exists(ctx):
    db, c = ctx
    got = find_or_create_conversation(db, channel="sms", client_id=c.id,
                                      external_contact="+12075550191")
    db.commit()
    assert got.id is not None
    assert got.status == "open"
    assert got.channel == "sms"
