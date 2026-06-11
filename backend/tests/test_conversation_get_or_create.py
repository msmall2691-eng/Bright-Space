"""find_or_create_conversation must never INSERT a doomed duplicate.

uq_conversations_client_channel (alembic 003) allows exactly ONE conversations
row per (client_id, channel). June 10 incident: client 91's only email
conversation was resolved, the lookup skipped resolved rows, and the INSERT hit
the constraint — which poisoned the whole Gmail sync transaction, so the
"Quote accepted" notification email was retried (and re-failed) every 10
minutes and never reached the inbox.
"""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.comms.router import find_or_create_conversation, _apply_inbound
from modules.gmail.router import _thread_inbound_email


@pytest.fixture
def ctx():
    db = SessionLocal()
    # Mirror the prod constraint; SQLite supports partial unique indexes.
    db.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_client_channel "
        "ON conversations (client_id, channel) WHERE client_id IS NOT NULL"
    ))
    db.commit()
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


def test_constraint_is_enforced_in_test_db(ctx):
    """Sanity: the partial unique index actually rejects duplicates here,
    otherwise the tests below prove nothing."""
    db, c = ctx
    _conv(db, c, status="resolved")
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(Conversation(client_id=c.id, channel="email", status="open"))
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
