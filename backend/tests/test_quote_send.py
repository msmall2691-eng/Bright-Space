"""POST /quotes/{id}/send must actually DELIVER (email/SMS), not just mark sent.

Regression for the bug where the endpoint flipped status to 'sent' and minted the
link but never emailed or texted the customer.
"""
import pytest
from unittest.mock import patch, MagicMock

from database.db import SessionLocal
from database.models import Client, Quote
from modules.quoting.router import send_quote, QuoteSendRequest


@pytest.fixture
def quote_ctx():
    db = SessionLocal()
    c = Client(name="Send Test", email="cust@example.com", phone="+12075551212", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-SEND-1", title="T", service_type="residential",
              address="1 St", notes="", items=[], subtotal=100, tax_rate=0, tax=0,
              discount=0, total=100, status="draft")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, q
    db.rollback()
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_send_email_actually_delivers(quote_ctx):
    db, c, q = quote_ctx
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "e1"}
        out = send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    assert out["results"]["email"] == "sent"
    assert out["status"] == "sent"
    assert Email.return_value.send_quote_email.called  # actually invoked delivery
    db.refresh(q)
    assert q.status == "sent" and q.sent_at is not None


def test_send_sms_actually_delivers(quote_ctx):
    db, c, q = quote_ctx
    with patch("integrations.twilio_client.send_sms", return_value={"sid": "SM1", "status": "queued"}) as sms:
        out = send_quote(q.id, QuoteSendRequest(channel="sms", custom_message="Your quote is ready"), db=db)
    assert out["results"]["sms"] == "sent"
    assert sms.called
    body = sms.call_args.kwargs.get("body") or sms.call_args.args[1]
    assert "/quote/" in body  # the accept link is included


def test_send_with_no_destination_is_undelivered_not_error(quote_ctx):
    db, c, q = quote_ctx
    c.email = None; c.phone = None; db.commit()
    # No longer 502s — returns 200 with delivered=False + the link to share
    # manually, and the quote stays draft (not falsely marked sent).
    out = send_quote(q.id, QuoteSendRequest(channel="both"), db=db)
    assert out["delivered"] is False
    assert out["errors"]            # explains why nothing went out
    assert out["quote_link"]        # link still provided
    db.refresh(q)
    assert q.status == "draft"


def test_send_with_string_valid_until_does_not_crash(quote_ctx):
    """Prod schema drift hands us valid_until as a str, not a date. Building
    the PDF/email used to call .strftime() on it → AttributeError → the send
    "failed" with a misleading 'email could not be sent'. The tolerant
    formatter must let the send go through for a quote that carries an expiry."""
    db, c, q = quote_ctx
    # Simulate the drifted column: a raw ISO string that reads back as a str.
    # set_committed_value marks it as loaded-from-DB (not dirty) so SQLite's
    # strict Date column doesn't reject it on commit — mirroring prod, where
    # the column is text and the read returns a string.
    from sqlalchemy.orm.attributes import set_committed_value
    set_committed_value(q, "valid_until", "2026-07-13")
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "e-drift-1"}
        out = send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    assert out["delivered"] is True
    assert out["results"]["email"] == "sent"
    # The pre-formatted expiry string is what the email service receives.
    _, kwargs = Email.return_value.send_quote_email.call_args
    assert kwargs["expires_at"] == "July 13, 2026"


def test_failed_send_surfaces_real_error(quote_ctx):
    """A delivery failure must record the REAL reason, not a generic string,
    so an SMTP problem is distinguishable from a code bug (P1-B)."""
    db, c, q = quote_ctx
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {
            "success": False, "error": "SMTP auth failed: 535", "email_id": None,
        }
        out = send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    assert out["delivered"] is False
    assert any("SMTP auth failed" in e for e in out["errors"])
    db.refresh(q)
    assert "SMTP auth failed" in (q.last_send_error or "")


def test_failed_send_is_visible_then_cleared_on_success(quote_ctx):
    """A failed delivery must not leave a silent draft: last_send_error /
    last_send_attempt_at record what happened, and a later successful send
    clears the error."""
    db, c, q = quote_ctx
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {
            "success": False, "error": "SMTP auth failed", "email_id": None,
        }
        out = send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    assert out["delivered"] is False
    db.refresh(q)
    assert q.status == "draft"                    # not falsely marked sent
    assert q.last_send_attempt_at is not None
    assert q.last_send_error                      # visible reason, not silence

    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "e2"}
        out = send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    assert out["delivered"] is True
    db.refresh(q)
    assert q.status == "sent"
    assert q.last_send_error is None              # cleared on success
