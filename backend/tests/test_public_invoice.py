"""Customer-facing public invoice page — GET /api/invoices/public/{token}.

Rebuilds a capability the app deliberately deleted once, fixing the two faults
that got it deleted:
  * it never worked end-to-end  → the read path is verified here;
  * it leaked the customer's email + phone to any token holder → the payload is
    asserted to carry NONE of that.

The token is the credential: a wrong/absent token is a 404, never a peek.
"""
import uuid

import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Invoice
from modules.invoicing.router import (
    public_view_invoice, _ensure_invoice_public_token, invoice_to_dict,
)


@pytest.fixture
def invoice_ctx():
    db = SessionLocal()
    c = Client(
        name="Pay Test", email="payer@example.com", phone="+12075550000",
        address="42 Private Lane", status="active",
    )
    db.add(c); db.commit(); db.refresh(c)
    inv = Invoice(
        client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:6]}",
        items=[{"name": "Standard clean", "qty": 1, "unit_price": 150}],
        subtotal=150, tax_rate=0, tax=0, discount=0, total=150,
        status="sent", due_date="October 01, 2026", notes="Thanks!",
        public_token=uuid.uuid4().hex,
    )
    db.add(inv); db.commit(); db.refresh(inv)
    yield db, c, inv
    db.rollback()
    db.query(Invoice).filter(Invoice.id == inv.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_public_view_returns_the_invoice_for_a_valid_token(invoice_ctx):
    db, c, inv = invoice_ctx
    out = public_view_invoice(inv.public_token, db=db)
    assert out["invoice_number"] == inv.invoice_number
    assert out["total"] == 150
    assert out["status"] == "sent"
    assert out["client_name"] == "Pay Test"      # display name only
    assert out["items"][0]["name"] == "Standard clean"
    # The write path isn't built — the page is told so rather than shown a dead button.
    assert out["online_payment_enabled"] is False


def test_public_payload_leaks_no_contact_pii(invoice_ctx):
    """The reason the old endpoint was deleted: it served email + phone to any
    token holder. The rebuilt payload must carry neither — nor address, nor any
    internal field."""
    db, c, inv = invoice_ctx
    out = public_view_invoice(inv.public_token, db=db)
    assert "payer@example.com" not in str(out)
    assert "2075550000" not in str(out).replace("+", "")
    assert "42 Private Lane" not in str(out)
    for leaked in ("client_id", "email", "phone", "address", "custom_fields",
                   "job_id", "opportunity_id"):
        assert leaked not in out, f"public payload must not expose {leaked!r}"


def test_a_bad_token_is_404_not_a_peek(invoice_ctx):
    db, c, inv = invoice_ctx
    with pytest.raises(HTTPException) as ei:
        public_view_invoice("not-a-real-token", db=db)
    assert ei.value.status_code == 404


def test_ensure_token_mints_once_and_is_stable(invoice_ctx):
    db, c, inv = invoice_ctx
    inv.public_token = None
    db.commit()
    first = _ensure_invoice_public_token(inv)
    assert first  # minted
    assert _ensure_invoice_public_token(inv) == first  # stable on re-call


def test_office_dict_exposes_token_for_copyable_link(invoice_ctx):
    """InvoiceDetail needs the token to show the office a copyable pay link."""
    db, c, inv = invoice_ctx
    assert invoice_to_dict(inv)["public_token"] == inv.public_token
