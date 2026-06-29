"""Quote delivery history is now backed by IntegrationEvent (not per-channel
quote_emails / quote_sms tables). This pins the three history endpoints to
read from the shared audit log and to expose recipient + status the same way
the old endpoints did.
"""
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Quote, IntegrationEvent
from modules.quoting.router import (
    send_quote, QuoteSendRequest,
    get_quote_email_history, get_quote_sms_history, get_quote_delivery_history,
)


@pytest.fixture
def quote_ctx():
    db = SessionLocal()
    c = Client(name="History Test", email="hist@example.com",
               phone="+12075551234", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-HIST-1", title="T",
              service_type="residential", address="1 St", notes="", items=[],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100, status="draft")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, q
    db.rollback()
    db.query(IntegrationEvent).filter(IntegrationEvent.entity_id == q.id).delete(
        synchronize_session=False
    )
    db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_email_history_reads_from_integration_events(quote_ctx):
    db, _c, q = quote_ctx
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {
            "success": True, "email_id": "e-hist-1",
        }
        send_quote(q.id, QuoteSendRequest(channel="email"), db=db)

    out = get_quote_email_history(q.id, db=db)
    assert out["total_emails_sent"] == 1
    row = out["emails"][0]
    # Recipient flows through the new structured 'request_payload: to <addr>'
    # convention rather than reading off QuoteEmail.recipient_email.
    assert row["recipient"] == "hist@example.com"
    assert row["status"] == "sent"        # 'ok' -> 'sent' for UI back-compat
    assert row["email_id"] == "e-hist-1"  # IntegrationEvent.external_id


def test_sms_history_reads_from_integration_events(quote_ctx):
    db, _c, q = quote_ctx
    with patch("integrations.twilio_client.send_sms",
               return_value={"sid": "SM-HIST-1", "status": "queued"}):
        send_quote(q.id, QuoteSendRequest(channel="sms"), db=db)

    out = get_quote_sms_history(q.id, db=db)
    assert out["total_sms_sent"] == 1
    row = out["messages"][0]
    assert row["recipient"] == "+12075551234"
    assert row["status"] == "sent"
    assert row["message_sid"] == "SM-HIST-1"


def test_delivery_history_includes_failures_with_recipient(quote_ctx):
    db, _c, q = quote_ctx
    # A failed send still records who we tried to reach.
    with patch("modules.quoting.router.QuotePDFService") as PDF, \
         patch("modules.quoting.router.QuoteEmailService") as Email:
        PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
        Email.return_value.send_quote_email.return_value = {
            "success": False, "error": "SMTP auth failed: 535", "email_id": None,
        }
        send_quote(q.id, QuoteSendRequest(channel="email"), db=db)

    out = get_quote_delivery_history(q.id, db=db)
    assert out["total_deliveries"] == 1
    row = out["history"][0]
    assert row["channel"] == "email"
    assert row["recipient"] == "hist@example.com"
    assert row["status"] == "failed"
    assert "SMTP auth failed" in (row["error"] or "")


def test_models_no_longer_expose_quote_email_or_quote_sms():
    """The per-channel models and their backref relationships are gone."""
    from database import models as m
    assert not hasattr(m, "QuoteEmail")
    assert not hasattr(m, "QuoteSMS")
    assert not hasattr(m, "QuoteEmailStatus")
    assert not hasattr(m, "QuoteSMSStatus")
    assert not hasattr(m.Quote, "emails")
    assert not hasattr(m.Quote, "sms_messages")
