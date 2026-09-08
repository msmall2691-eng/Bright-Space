"""BB-INV-02: a completed job with no quote must invoice its OWN price, and a
$0 draft must still read as unbilled money.

Two halves of one leak:

  * `auto_create_draft_invoice` itemized from the source quote, but a recurring
    visit (whose series often carries no quote) or a manually-created job has no
    quote — so it fell through to a $0 placeholder line and produced a $0 draft
    invoice, even though migration 110 had already stamped `job.price` from the
    series / accepted quote / house default. Every quote-less completed visit
    was billed nothing.

  * the daily brief's "completed jobs never invoiced" counter tested for the
    ABSENCE of an invoice row (`Invoice.id IS NULL`). A $0 placeholder IS a row,
    so it read as billed and the unbilled work vanished from the one list that
    was supposed to catch it.

Both mutation-checked.
"""
from datetime import date, time, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, Quote, Invoice
from modules.scheduling.completion import auto_create_draft_invoice
from modules.ai.router import _compute_followups
from utils.dates import business_today


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Price Co", email="price@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="H", address="1 Price Rd",
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


def test_a_quoteless_job_invoices_its_own_price(ctx):
    db, c, p = ctx
    j = Job(client_id=c.id, property_id=p.id, title="Weekly clean", job_type="residential",
            scheduled_date=date.today(), start_time=time(9, 0), end_time=time(11, 0),
            status="completed", cleaner_ids=[], price=140.0)  # no quote_id
    db.add(j); db.commit(); db.refresh(j)

    auto_create_draft_invoice(db, j)

    inv = db.query(Invoice).filter(Invoice.job_id == j.id).first()
    assert inv is not None
    assert inv.subtotal == 140.0, "billed the job's price, not a $0 placeholder"
    # Default 5.5% tax when no quote says otherwise → 140 + 7.70.
    assert inv.total == round(140.0 + 140.0 * 0.055, 2)


def test_a_job_with_no_price_still_falls_to_zero(ctx):
    # price=None (nobody set one) is the one case that legitimately invoices $0 —
    # and it's exactly what the brief must then flag (below).
    db, c, p = ctx
    j = Job(client_id=c.id, property_id=p.id, title="Unpriced", job_type="residential",
            scheduled_date=date.today(), start_time=time(9, 0), end_time=time(11, 0),
            status="completed", cleaner_ids=[], price=None)
    db.add(j); db.commit(); db.refresh(j)

    auto_create_draft_invoice(db, j)

    inv = db.query(Invoice).filter(Invoice.job_id == j.id).first()
    assert inv is not None
    assert inv.total == 0.0


def test_a_zero_dollar_invoice_still_counts_as_unbilled(ctx):
    db, c, p = ctx
    old = business_today() - timedelta(days=5)   # past the 3-day grace
    j = Job(client_id=c.id, property_id=p.id, title="Old completed", job_type="residential",
            scheduled_date=old, start_time=time(9, 0), end_time=time(11, 0),
            status="completed", cleaner_ids=[], org_id=1)
    db.add(j); db.commit(); db.refresh(j)

    def _unbilled_count():
        for it in _compute_followups(db, 1)["followups"]:
            if "never invoiced" in it["title"]:
                return int(it["title"].split()[0])
        return 0

    # With no invoice at all, the completed old job is counted as unbilled.
    with_no_invoice = _unbilled_count()
    assert with_no_invoice >= 1

    # A $0 placeholder invoice — a row exists, but no money is billed. The job
    # must STAY on the list. Under the old `Invoice.id IS NULL` test the row's
    # mere existence dropped it (that's the bug).
    zero_inv = Invoice(client_id=c.id, job_id=j.id, org_id=1, items=[],
                       subtotal=0, tax=0, discount=0, total=0, status="draft")
    db.add(zero_inv); db.commit()
    assert _unbilled_count() == with_no_invoice, "a $0 invoice hid the job from the unbilled list"

    # Give it a real amount → NOW it's billed and drops off.
    zero_inv.subtotal = 100; zero_inv.total = 100
    db.commit()
    assert _unbilled_count() == with_no_invoice - 1
