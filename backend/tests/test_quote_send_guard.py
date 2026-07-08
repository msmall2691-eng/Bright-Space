"""Send guard (July-2026 audit item 3): POST /quotes/{id}/send must refuse an
empty / $0 quote instead of emailing the customer a blank quote. Totals are
computed from line items, so an empty quote nets to $0 — guarding on the total
covers both "no line items" and "priced to zero/negative"."""
import pytest

from database.db import SessionLocal
from database.models import Client, Quote
from modules.quoting.router import send_quote, QuoteSendRequest
from fastapi import HTTPException


@pytest.fixture
def quote_ctx():
    db = SessionLocal()
    c = Client(name="Guard Test", email="guard@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number="QT-GUARD-1", title="T", service_type="residential",
              address="1 St", notes="", items=[], subtotal=0, tax_rate=0, tax=0,
              discount=0, total=0, status="draft")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, q
    db.rollback()
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_send_blocks_zero_total_quote(quote_ctx):
    db, c, q = quote_ctx
    with pytest.raises(HTTPException) as ei:
        send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    assert ei.value.status_code == 400
    assert "$0" in ei.value.detail
    # Status must NOT flip to sent on a blocked send.
    db.refresh(q)
    assert q.status == "draft"


def test_send_blocks_negative_total_quote(quote_ctx):
    db, c, q = quote_ctx
    q.total = -10
    db.commit()
    with pytest.raises(HTTPException) as ei:
        send_quote(q.id, QuoteSendRequest(channel="email"), db=db)
    assert ei.value.status_code == 400
