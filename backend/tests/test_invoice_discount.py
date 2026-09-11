"""BB-INV-01: a discount promised on the quote must survive to the invoice.

`Quote` carried a `discount` and its `total` reflected it, but `Invoice` had no
discount column — so when a completed job auto-generated its draft invoice (or
an operator composed one), the discount had nowhere to land and `total` was
billed at the full, pre-discount amount. A customer promised money off was
billed the whole number.

Covered here, each mutation-checked:
  * calc_totals subtracts the discount AFTER tax (matching the quote math);
  * a completed job whose quote carried a discount produces an invoice that
    keeps the discount and bills subtotal + tax − discount;
  * editing ONLY the discount on an existing invoice reprices its total (the
    old update path recomputed only when line items changed).
"""
from datetime import date, time

import pytest
from pydantic import ValidationError

from database.db import SessionLocal
from database.models import Client, Property, Job, Quote, Invoice
from modules.invoicing.router import calc_totals, create_invoice, update_invoice, InvoiceCreate, InvoiceItem, InvoiceUpdate
from modules.scheduling.completion import auto_create_draft_invoice


def test_a_negative_discount_is_rejected():
    # total = subtotal + tax - discount, so a negative discount silently ADDS to
    # the total — a hidden surcharge. A discount only ever subtracts; reject < 0
    # on both the create and update shapes before it can reach calc_totals.
    items = [InvoiceItem(name="Clean", qty=1, unit_price=100.0)]
    with pytest.raises(ValidationError):
        InvoiceCreate(client_id=1, items=items, discount=-10.0)
    with pytest.raises(ValidationError):
        InvoiceUpdate(discount=-0.01)
    # Zero and positive still fine.
    assert InvoiceCreate(client_id=1, items=items, discount=0).discount == 0
    assert InvoiceUpdate(discount=25.0).discount == 25.0


def test_calc_totals_subtracts_discount_after_tax():
    items = [{"name": "Clean", "qty": 1, "unit_price": 200.0}]
    # 200 subtotal, 10% tax = 20, less $30 discount = 190.
    subtotal, tax, total = calc_totals(items, 10.0, 30.0)
    assert subtotal == 200.0
    assert tax == 20.0
    assert total == 190.0
    # No discount → unchanged behavior.
    assert calc_totals(items, 10.0) == (200.0, 20.0, 220.0)


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Discount Co", email="disc@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="H", address="1 Disc Rd",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    db.rollback()
    db.query(Invoice).filter(Invoice.client_id == c.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_auto_invoice_carries_the_quotes_discount(ctx):
    db, c, p = ctx
    q = Quote(client_id=c.id, quote_number="QT-DISC-1", title="T", service_type="residential",
              items=[{"name": "Deep clean", "qty": 1, "unit_price": 300.0}],
              subtotal=300.0, tax_rate=0, tax=0, discount=50.0, total=250.0, status="accepted")
    db.add(q); db.commit(); db.refresh(q)
    j = Job(client_id=c.id, property_id=p.id, title="Deep clean", job_type="residential",
            scheduled_date=date.today(), start_time=time(9, 0), end_time=time(12, 0),
            status="completed", quote_id=q.id, cleaner_ids=[])
    db.add(j); db.commit(); db.refresh(j)

    auto_create_draft_invoice(db, j)

    inv = db.query(Invoice).filter(Invoice.job_id == j.id).first()
    assert inv is not None, "no invoice created"
    assert inv.discount == 50.0, "the quote's discount was dropped"
    # subtotal 300, tax 0, less 50 discount = 250 — what the customer accepted.
    assert inv.subtotal == 300.0
    assert inv.total == 250.0


def test_editing_only_the_discount_reprices_the_total(ctx):
    db, c, p = ctx
    created = create_invoice(
        InvoiceCreate(client_id=c.id,
                      items=[InvoiceItem(name="Clean", qty=1, unit_price=100.0)],
                      tax_rate=0),
        db=db, org_id=1,
    )
    assert created["discount"] == 0
    assert created["total"] == 100.0

    # Change ONLY the discount — no items in the payload. The old code recomputed
    # total solely when items were supplied, so this used to leave total stale.
    updated = update_invoice(created["id"], InvoiceUpdate(discount=25.0), db=db, org_id=1)
    assert updated["discount"] == 25.0
    assert updated["total"] == 75.0
