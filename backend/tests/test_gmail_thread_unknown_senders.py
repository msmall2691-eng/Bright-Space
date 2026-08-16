"""Unknown senders must be threaded into Conversations even when they don't
qualify to auto-create a Client (audit finding #3, July 2026).

Before this fix, modules.gmail.router.run_inbox_sync `continue`d past the
threading step entirely whenever evaluate_inbound_email said "don't
auto-create a lead" — so a real prospect whose email happened not to mention
a cleaning keyword ("Hi, are you free Tuesday? We met at the market") created
nothing anywhere in BrightBase; the only trace was a log line. The fix
decouples "worth auto-creating a Client for" (content-based, unchanged) from
"worth showing in the unified inbox at all" (should_thread_inbound_email —
only excludes definitive automated/bulk senders).
"""
import uuid
from datetime import datetime, timezone

import pytest

from database.db import SessionLocal
from database.models import Client, Conversation, Message
from modules.gmail.router import run_inbox_sync


@pytest.fixture
def db():
    session = SessionLocal()
    yield session
    session.rollback()
    session.close()


def _email(**over):
    base = dict(
        id="g1", message_id=f"<{uuid.uuid4().hex}@mail.example.com>",
        from_name="Jamie Prospect", from_email=f"jamie-{uuid.uuid4().hex[:8]}@example.com",
        to="office@maineclean.co", subject="Quick question", snippet="hi",
        body="hi", date=datetime.now(timezone.utc).isoformat(),
        is_read=False, has_attachments=False,
        to_email="", in_reply_to="", references="",
        list_unsubscribe="", precedence="", feedback_id="", auto_submitted="",
    )
    base.update(over)
    return base


def _cleanup(db, message_id, addr=None):
    msg = db.query(Message).filter(Message.external_id == message_id).first()
    if msg:
        conv_id = msg.conversation_id
        db.delete(msg); db.commit()
        conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
        if conv:
            db.delete(conv); db.commit()
    if addr:
        c = db.query(Client).filter(Client.email == addr.lower()).first()
        if c:
            db.delete(c); db.commit()


def test_unmatched_sender_without_keyword_still_gets_threaded(db):
    """The core fix: no cleaning keyword, not a reply, unknown sender —
    still must produce a client-less Conversation/Message, not nothing."""
    em = _email(subject="are you free tuesday?", body="we met at the market")
    try:
        result = run_inbox_sync(db, emails=[em])
        assert result["summary"]["threaded"] == 1
        assert result["summary"]["new_contacts_created"] == 0
        assert result["summary"]["skipped_by_filter"] == 1

        msg = db.query(Message).filter(Message.external_id == em["message_id"]).one()
        assert msg.client_id is None
        conv = db.query(Conversation).filter(Conversation.id == msg.conversation_id).one()
        assert conv.client_id is None
        assert conv.external_contact == em["from_email"].lower()

        synced_em = result["emails"][0]
        assert synced_em["can_convert_to_client"] is True
        assert synced_em["lead_skip_reason"] == "no_cleaning_intent"
    finally:
        _cleanup(db, em["message_id"], em["from_email"])


def test_unmatched_sender_with_keyword_creates_client_and_threads(db):
    """Regression: the existing auto-create-a-lead path still works."""
    em = _email(subject="Need a cleaning quote", body="Looking for biweekly cleaning")
    try:
        result = run_inbox_sync(db, emails=[em])
        assert result["summary"]["threaded"] == 1
        assert result["summary"]["new_contacts_created"] == 1

        client = db.query(Client).filter(Client.email == em["from_email"].lower()).one()
        msg = db.query(Message).filter(Message.external_id == em["message_id"]).one()
        assert msg.client_id == client.id
    finally:
        _cleanup(db, em["message_id"], em["from_email"])


def test_auto_created_lead_is_stamped_with_the_syncing_account_org(db):
    """BB-MT-01 regression: an auto-created lead used to land with org_id
    NULL regardless of which account's sync produced it. The NULL-tolerant
    _org() tenant filter (MT-3) then surfaced that lead on EVERY workspace's
    board/brief, not just the one whose inbox it came from. org_id must be
    stamped from the org_id run_inbox_sync was called with."""
    em = _email(subject="Need a cleaning quote", body="Looking for biweekly cleaning")
    try:
        result = run_inbox_sync(db, emails=[em], org_id=7)
        assert result["summary"]["new_contacts_created"] == 1

        client = db.query(Client).filter(Client.email == em["from_email"].lower()).one()
        assert client.org_id == 7
    finally:
        _cleanup(db, em["message_id"], em["from_email"])


def test_bulk_mail_is_not_threaded(db):
    """Newsletter/ESP headers still keep an email out of the inbox entirely —
    'non-bulk' in the audit's fix instruction is the operative word."""
    em = _email(from_email=f"newsletter-{uuid.uuid4().hex[:8]}@example.com",
                list_unsubscribe="<mailto:unsub@example.com>")
    try:
        result = run_inbox_sync(db, emails=[em])
        assert result["summary"]["threaded"] == 0
        assert db.query(Message).filter(Message.external_id == em["message_id"]).first() is None
    finally:
        _cleanup(db, em["message_id"], em["from_email"])


def test_blocked_spam_domain_is_not_threaded(db):
    """A known automated/marketing domain (the SPAM_DOMAINS list) is still
    excluded from the inbox — only content-based misses were the bug."""
    em = _email(from_email="notifications@github.com")
    try:
        result = run_inbox_sync(db, emails=[em])
        assert result["summary"]["threaded"] == 0
        assert db.query(Message).filter(Message.external_id == em["message_id"]).first() is None
    finally:
        _cleanup(db, em["message_id"], em["from_email"])


def test_known_contact_with_bulk_headers_still_threads(db):
    """A REAL customer replying from their normal address must always land in
    Comms, even if their mail carries bulk headers (List-Unsubscribe etc.)
    that many legitimate small-business/ESP senders add. The bulk gate only
    applies to UNKNOWN senders. (Fix for 'customer emails aren't showing up'.)"""
    addr = f"regular-{uuid.uuid4().hex[:8]}@example.com"
    client = Client(name="Regular Customer", first_name="Regular", last_name="Customer",
                    email=addr.lower(), status="active", source="manual")
    db.add(client); db.commit()
    em = _email(from_email=addr, subject="Re: this week's clean",
                list_unsubscribe="<mailto:unsub@example.com>")
    try:
        result = run_inbox_sync(db, emails=[em])
        assert result["summary"]["threaded"] == 1
        msg = db.query(Message).filter(Message.external_id == em["message_id"]).one()
        assert msg.client_id == client.id
    finally:
        _cleanup(db, em["message_id"])
        db.delete(db.query(Client).get(client.id)); db.commit()


def test_reply_to_our_thread_creates_client_and_threads(db):
    em = _email(subject="Re: your quote", to_email="office@maineclean.co")
    try:
        result = run_inbox_sync(db, emails=[em])
        assert result["summary"]["threaded"] == 1
        assert result["summary"]["new_contacts_created"] == 1
    finally:
        _cleanup(db, em["message_id"], em["from_email"])
