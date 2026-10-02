"""The owner's Gmail-composed replies (SENT) thread into the client's inbox.

A reply written directly in Gmail — not through BrightBase — used to be
invisible here, because the sync only reads INBOX. run_account_sent_sync reads
recent SENT, threads the ones addressed to a KNOWN client as OUTBOUND messages
(in the same conversation their inbound mail lands in), skips everything else,
and dedups on the RFC Message-ID (so BrightBase's own sent copies aren't
re-threaded into duplicates).
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Conversation, Message


@pytest.fixture
def ctx():
    db = SessionLocal()
    client = Client(name="Sent Test", email="customer@example.com", status="active", org_id=1)
    db.add(client); db.commit(); db.refresh(client)
    acct = SimpleNamespace(id=999, email="office@mainecleaninco.com", org_id=1)
    yield db, client, acct
    db.rollback()
    db.query(Message).filter(Message.client_id == client.id).delete(synchronize_session=False)
    db.query(Conversation).filter(Conversation.client_id == client.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _sent(to_email, message_id, subject="Re: your quote", body="Sounds good!",
          date=None):
    return {
        "message_id": message_id, "from_email": "office@mainecleaninco.com",
        "to": to_email, "to_email": to_email, "subject": subject, "body": body,
        "date": (date or datetime.now(timezone.utc)).isoformat(),
    }


def _run(db, acct, emails):
    from modules.gmail.router import run_account_sent_sync
    with patch("integrations.google_accounts.account_credentials", return_value=object()), \
         patch("integrations.gmail_api.fetch_sent_for_account", return_value=emails):
        return run_account_sent_sync(db, acct)


def test_sent_reply_to_a_client_threads_as_outbound(ctx):
    db, client, acct = ctx
    out = _run(db, acct, [_sent("customer@example.com", "<sent-1@mail>")])
    assert out["threaded"] == 1
    msg = db.query(Message).filter(Message.external_id == "<sent-1@mail>").one()
    assert msg.direction == "outbound"
    assert msg.channel == "email"
    assert msg.client_id == client.id
    assert msg.synced_by_google_account_id == acct.id
    conv = db.query(Conversation).filter(Conversation.id == msg.conversation_id).one()
    assert conv.client_id == client.id
    assert conv.channel == "email"


def test_sent_to_a_non_client_is_read_past_not_stored(ctx):
    db, client, acct = ctx
    out = _run(db, acct, [_sent("stranger@nowhere.example", "<sent-2@mail>")])
    assert out["threaded"] == 0
    assert out["skipped_not_client"] == 1
    # No lead created, no message stored for a non-client recipient.
    assert db.query(Message).filter(Message.external_id == "<sent-2@mail>").first() is None
    assert db.query(Client).filter(Client.email == "stranger@nowhere.example").first() is None


def test_sent_dedups_on_message_id(ctx):
    # BrightBase's own sent copy (already stored with this Message-ID) — and any
    # re-scan of the same window — must not create a duplicate.
    db, client, acct = ctx
    email = _sent("customer@example.com", "<sent-3@mail>")
    first = _run(db, acct, [email])
    second = _run(db, acct, [email])
    assert first["threaded"] == 1
    assert second["threaded"] == 0
    assert db.query(Message).filter(Message.external_id == "<sent-3@mail>").count() == 1


def test_sent_to_another_orgs_client_is_not_threaded(ctx):
    # Codex P1 on #896: _match_email_to_client is a GLOBAL lookup. A recipient
    # address that belongs to ANOTHER org's client must never have this
    # account's (org 1) sent mail attached to that foreign org's conversation.
    db, client, acct = ctx
    other = Client(name="Foreign Org", email="shared@example.com",
                   status="active", org_id=2)
    db.add(other); db.commit(); db.refresh(other)
    try:
        out = _run(db, acct, [_sent("shared@example.com", "<sent-x-org@mail>")])
        assert out["threaded"] == 0
        assert out["skipped_not_client"] == 1
        # Nothing stored, and no conversation created against the foreign client.
        assert db.query(Message).filter(
            Message.external_id == "<sent-x-org@mail>").first() is None
        assert db.query(Conversation).filter(
            Conversation.client_id == other.id).first() is None
    finally:
        db.query(Message).filter(Message.client_id == other.id).delete(synchronize_session=False)
        db.query(Conversation).filter(Conversation.client_id == other.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == other.id).delete(synchronize_session=False)
        db.commit()


def test_backfilled_old_send_does_not_regress_conversation_clock(ctx):
    # Codex P1 on #896: the scan backfills up to newer_than_days. A historical
    # send must not (a) drag the conversation's last_message_at backwards, nor
    # (b) be mis-recorded as the first response to an inbound that arrived AFTER
    # it. Seed a conversation whose latest activity (and last inbound) is NOW,
    # then thread a send dated two days ago.
    db, client, acct = ctx
    # The schema stores naive UTC (see _parse_email_dt / _utcnow); seed the
    # conversation the same way so the comparison mirrors production.
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    old = now - timedelta(days=2)
    conv = Conversation(
        client_id=client.id, channel="email", status="open", priority="normal",
        org_id=1, last_message_at=now, last_inbound_at=now, first_response_at=None,
    )
    db.add(conv); db.commit(); db.refresh(conv)

    # `old` is timezone-aware on the wire (real Gmail Date headers are); the
    # sync normalizes it to naive UTC before storing.
    out = _run(db, acct, [_sent("customer@example.com", "<sent-old@mail>",
                                date=old.replace(tzinfo=timezone.utc))])
    assert out["threaded"] == 1
    db.refresh(conv)
    # The newer inbound still owns the activity clock — not dragged back to `old`.
    assert conv.last_message_at >= now
    # A send that predates the inbound is not the reply to it: SLA stays unmet.
    assert conv.first_response_at is None
