"""Tests for the integration audit log (§5.5 of the April audit).

Covers:
- log_integration_event writes a row and truncates long detail
- the helper never raises and rolls back on a broken session
- the read endpoint filters by entity/provider/status and returns newest-first
- sending a quote records an email integration event
"""
import pytest
from unittest.mock import patch

from database.db import SessionLocal
from database.models import Client, Quote, IntegrationEvent
from utils.integration_log import log_integration_event
from modules.integration_events.router import list_integration_events
from modules.quoting.router import send_quote, QuoteSendRequest


@pytest.fixture
def db_session():
    db = SessionLocal()
    yield db
    db.rollback()
    db.close()


def test_log_writes_row(db_session):
    db = db_session
    log_integration_event(
        db, entity_type="job", entity_id=999001, provider="gcal",
        action="create", status="ok", external_id="evt_abc", detail="hi",
    )
    row = (
        db.query(IntegrationEvent)
        .filter(IntegrationEvent.entity_id == 999001)
        .first()
    )
    assert row is not None
    assert row.provider == "gcal" and row.action == "create" and row.status == "ok"
    assert row.external_id == "evt_abc"
    # ok status routes the note to request_payload, not error_message
    assert row.request_payload == "hi" and row.error_message is None
    db.query(IntegrationEvent).filter(IntegrationEvent.entity_id == 999001).delete(
        synchronize_session=False
    )
    db.commit()


def test_log_truncates_long_detail(db_session):
    db = db_session
    log_integration_event(
        db, entity_type="quote", entity_id=999002, provider="email",
        action="send", status="failed", detail="x" * 5000,
    )
    row = (
        db.query(IntegrationEvent)
        .filter(IntegrationEvent.entity_id == 999002)
        .first()
    )
    # failed status routes the note to error_message, truncated to 1000 chars
    assert row is not None and len(row.error_message) == 1000
    db.query(IntegrationEvent).filter(IntegrationEvent.entity_id == 999002).delete(
        synchronize_session=False
    )
    db.commit()


def test_log_never_raises_on_broken_db():
    """A logging failure must not propagate to the caller."""
    class Boom:
        def add(self, *_a, **_k):
            raise RuntimeError("db is down")

        def commit(self):
            raise RuntimeError("db is down")

        def rollback(self):
            pass

    # Should swallow the error and return cleanly.
    log_integration_event(
        Boom(), entity_type="job", entity_id=1, provider="gcal",
        action="create", status="ok",
    )


def test_read_endpoint_filters_newest_first(db_session):
    db = db_session
    for i, prov in enumerate(["gcal", "email", "sms"]):
        log_integration_event(
            db, entity_type="quote", entity_id=999003, provider=prov,
            action="send", status="ok" if prov != "sms" else "failed",
        )
    out = list_integration_events(entity_type="quote", entity_id=999003, limit=50, offset=0, db=db)
    assert len(out) == 3
    # All three providers present, scoped to our entity.
    assert {r["provider"] for r in out} == {"gcal", "email", "sms"}

    failed = list_integration_events(entity_id=999003, status="failed", limit=50, offset=0, db=db)
    assert len(failed) == 1 and failed[0]["provider"] == "sms"

    emails = list_integration_events(entity_id=999003, provider="email", limit=50, offset=0, db=db)
    assert len(emails) == 1 and emails[0]["provider"] == "email"

    db.query(IntegrationEvent).filter(IntegrationEvent.entity_id == 999003).delete(
        synchronize_session=False
    )
    db.commit()


def test_send_quote_records_email_event(db_session):
    db = db_session
    c = Client(name="Audit Test", email="cust@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-AUDIT-1", title="T",
              service_type="residential", address="1 St", notes="", items=[],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100, status="draft")
    db.add(q); db.commit(); db.refresh(q)
    try:
        with patch("modules.quoting.router.QuotePDFService") as PDF, \
             patch("modules.quoting.router.QuoteEmailService") as Email:
            PDF.return_value.generate_quote_pdf.return_value = b"%PDF"
            Email.return_value.send_quote_email.return_value = {"success": True, "email_id": "e-audit-1"}
            send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
        rows = (
            db.query(IntegrationEvent)
            .filter(IntegrationEvent.entity_type == "quote",
                    IntegrationEvent.entity_id == q.id,
                    IntegrationEvent.provider == "email",
                    IntegrationEvent.external_id == "e-audit-1")
            .all()
        )
        assert len(rows) == 1
        assert rows[0].status == "ok"
    finally:
        db.query(IntegrationEvent).filter(IntegrationEvent.entity_id == q.id).delete(
            synchronize_session=False
        )
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit()
