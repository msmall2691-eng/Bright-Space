"""BB-INV-03: marking an invoice paid must keep the payment DATE, and recording
a payment twice must not double-count.

Two ways money went wrong at the "paid" moment:

  * update_invoice stamped paid_at ONLY when the caller sent an explicit
    paid_at. The "Mark paid" button PATCHes status="paid" alone — so the invoice
    flipped to paid with paid_at left NULL. Revenue-by-month filters on paid_at,
    so that paid invoice showed as collected on its own page yet never landed in
    ANY month's revenue: money vanishing from the figure the owner checks first.

  * process_payment overwrote paid_at with a fresh now() on every call and wrote
    a "payment received" message each time. A double-click moved the payment
    date (a cheque banked last month could jump months) and recorded the same
    money twice.

Both mutation-checked.
"""
from datetime import datetime, timezone, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Invoice, Message, Activity
from modules.invoicing.router import update_invoice, process_payment, InvoiceUpdate


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Paid Co", email="paid@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)

    def _inv(**kw):
        i = Invoice(client_id=c.id, org_id=1, items=[], subtotal=100, tax=0,
                    discount=0, total=100, status="draft", **kw)
        db.add(i); db.commit(); db.refresh(i)
        return i

    yield db, c, _inv
    db.rollback()
    # Activity rows too: paying an invoice logs an `invoice_paid` activity, and
    # SQLite reuses this client's id after we delete it — leaving those rows
    # behind would attach them to whichever client is created next (e.g. the
    # invoice-timeline test, which runs right after this file and counts paid
    # events by client id).
    db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
    db.query(Message).filter(Message.client_id == c.id).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_marking_paid_by_status_alone_still_stamps_the_date(ctx):
    db, c, _inv = ctx
    inv = _inv()
    assert inv.paid_at is None
    out = update_invoice(inv.id, InvoiceUpdate(status="paid"), db=db, org_id=1)
    assert out["status"] == "paid"
    assert out["paid_at"] is not None, "paid with no date — it drops out of monthly revenue"


def test_an_explicit_paid_at_is_respected_not_overwritten(ctx):
    db, c, _inv = ctx
    inv = _inv()
    when = "2026-06-01T12:00:00"
    out = update_invoice(inv.id, InvoiceUpdate(status="paid", paid_at=when), db=db, org_id=1)
    assert out["paid_at"].startswith("2026-06-01T12:00:00")


def test_editing_a_paid_invoice_does_not_move_its_payment_date(ctx):
    db, c, _inv = ctx
    inv = _inv()
    update_invoice(inv.id, InvoiceUpdate(status="paid"), db=db, org_id=1)
    db.refresh(inv)
    first = inv.paid_at
    assert first is not None
    # A later unrelated edit (e.g. notes) must not restamp the date.
    update_invoice(inv.id, InvoiceUpdate(notes="thanks"), db=db, org_id=1)
    db.refresh(inv)
    assert inv.paid_at == first


def test_recording_a_payment_twice_is_idempotent(ctx):
    db, c, _inv = ctx
    inv = _inv()
    first = process_payment(inv.id, {}, db=db)
    assert first.get("already_paid") is not True
    db.refresh(inv)
    paid_at_1 = inv.paid_at
    msgs_1 = db.query(Message).filter(Message.client_id == c.id,
                                      Message.channel == "payment").count()
    assert msgs_1 == 1

    # Second call (double-click / retry) — must change nothing.
    second = process_payment(inv.id, {}, db=db)
    assert second.get("already_paid") is True
    db.refresh(inv)
    assert inv.paid_at == paid_at_1, "the payment date moved on a second record"
    msgs_2 = db.query(Message).filter(Message.client_id == c.id,
                                      Message.channel == "payment").count()
    assert msgs_2 == 1, "a second payment message double-recorded the money"
