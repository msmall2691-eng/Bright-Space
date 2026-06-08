"""Customer quote responses: accept / request-changes / decline persist on the
quote and notify the owner (not just a hidden activity log)."""
import pytest
from unittest.mock import patch

from database.db import SessionLocal
from database.models import Client, Quote
from modules.quoting.router import (
    public_accept_quote, public_request_changes, public_decline_quote,
    PublicAcceptRequest, PublicChangeRequest, PublicDeclineRequest,
)


@pytest.fixture
def quote_ctx():
    db = SessionLocal()
    c = Client(name="Resp Test", email="cust@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-RESP-1", title="T", service_type="residential",
              address="1 St", notes="", items=[], subtotal=100, tax_rate=0, tax=0,
              discount=0, total=100, status="sent", public_token="tok-resp-1")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, q
    db.rollback()
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _owner_patches():
    return (
        patch("integrations.email._load_smtp_creds", return_value={"from_email": "owner@biz.com"}),
        patch("integrations.email.send_email", return_value={"ok": True}),
    )


def test_request_changes_persists_message_and_notifies_owner(quote_ctx):
    db, c, q = quote_ctx
    p1, p2 = _owner_patches()
    with p1, p2 as send:
        out = public_request_changes("tok-resp-1", PublicChangeRequest(message="Can you lower the price?"), db=db)
    assert out["status"] == "received"
    db.refresh(q)
    assert q.requested_changes_message == "Can you lower the price?"
    assert q.requested_changes_at is not None
    assert q.status == "changes_requested"
    assert send.called  # owner got an email


def test_decline_sets_fields_and_notifies_owner(quote_ctx):
    db, c, q = quote_ctx
    p1, p2 = _owner_patches()
    with p1, p2 as send:
        out = public_decline_quote("tok-resp-1", PublicDeclineRequest(name="Jo", reason="Went with someone else"), db=db)
    assert out["status"] == "declined"
    db.refresh(q)
    assert q.status == "declined"
    assert q.declined_at is not None
    assert q.declined_reason == "Went with someone else"
    assert q.declined_by_name == "Jo"
    assert send.called


def test_accept_notifies_owner(quote_ctx):
    db, c, q = quote_ctx
    p1, p2 = _owner_patches()
    with p1, p2 as send:
        out = public_accept_quote("tok-resp-1", PublicAcceptRequest(name="Jo", email="jo@x.com"), db=db)
    assert out["status"] == "accepted"
    db.refresh(q)
    assert q.status == "accepted" and q.accepted_at is not None
    assert send.called


def test_accept_emails_customer_a_confirmation(quote_ctx):
    db, c, q = quote_ctx
    p1, p2 = _owner_patches()
    with p1, p2 as send:
        public_accept_quote("tok-resp-1", PublicAcceptRequest(name="Jo", email="jo@x.com"), db=db)
    # Among the send_email calls, one goes to the accepting customer.
    recipients = [(call.kwargs.get("to") or (call.args[0] if call.args else None)) for call in send.call_args_list]
    assert "jo@x.com" in recipients, f"expected a customer confirmation to jo@x.com, got {recipients}"
