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


def test_send_with_no_destination_raises_not_false_success(quote_ctx):
    db, c, q = quote_ctx
    c.email = None; c.phone = None; db.commit()
    with pytest.raises(Exception):
        send_quote(q.id, QuoteSendRequest(channel="both"), db=db)
    db.refresh(q)
    assert q.status == "draft"  # not falsely marked sent
