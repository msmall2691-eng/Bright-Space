"""GET /api/quotes/{id}/delivery-history — the combined email+SMS send log.

This endpoint shipped calling two helpers (_extract_recipient / _ie_status) that
were never defined, so every request 500'd with a NameError. There was no test.
These pin it: the endpoint returns the IntegrationEvent send rows for a quote,
parses the "to <recipient>" note back to the bare recipient, and reports each
row's status.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote, IntegrationEvent

client = TestClient(app)


def _quote(db):
    c = Client(name=f"DH {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number=f"QT-DH-{uuid.uuid4().hex[:6]}", title="DH",
              status="sent", total=100)
    db.add(q); db.commit(); db.refresh(q)
    return c, q


def test_delivery_history_returns_send_rows_and_parses_recipient():
    db = SessionLocal()
    c, q = _quote(db)
    db.add_all([
        IntegrationEvent(entity_type="quote", entity_id=q.id, provider="email",
                         action="send", status="ok", request_payload="to owner@example.com",
                         external_id="msg-1"),
        IntegrationEvent(entity_type="quote", entity_id=q.id, provider="sms",
                         action="send", status="failed", request_payload="to +12075551212",
                         error_message="carrier rejected"),
        # An unrelated event on this quote (different action) must NOT appear.
        IntegrationEvent(entity_type="quote", entity_id=q.id, provider="gcal",
                         action="create", status="ok"),
    ])
    db.commit()
    try:
        r = client.get(f"/api/quotes/{q.id}/delivery-history")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["total_deliveries"] == 2
        by_channel = {h["channel"]: h for h in body["history"]}
        assert by_channel["email"]["recipient"] == "owner@example.com"
        assert by_channel["email"]["status"] == "ok"
        assert by_channel["sms"]["recipient"] == "+12075551212"
        assert by_channel["sms"]["status"] == "failed"
        assert by_channel["sms"]["error"] == "carrier rejected"
    finally:
        db.query(IntegrationEvent).filter(IntegrationEvent.entity_id == q.id,
                                          IntegrationEvent.entity_type == "quote").delete(synchronize_session=False)
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
