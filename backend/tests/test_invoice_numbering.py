"""Invoice numbering — race-free, and never NULL.

Regression for the "Invoice None" bug: invoices auto-created on job completion
never got an invoice_number (only the manual path did), so most invoices carried
NULL and the customer's email/SMS was titled "Invoice None". They also weren't
org-stamped. Also pins the numbering scheme off the row's PK (unique) rather
than the old racey max(id)+1.
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, Invoice
from modules.invoicing.router import assign_invoice_number
from modules.scheduling.router import _auto_create_draft_invoice


@pytest.fixture
def ids():
    tracked = {"clients": [], "properties": [], "jobs": [], "invoices": []}
    yield tracked
    db = SessionLocal()
    jobs = tracked["jobs"] or [0]
    db.query(Invoice).filter(Invoice.job_id.in_(jobs)).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.id.in_(tracked["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(jobs)).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(tracked["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(tracked["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _client(db, ids, name="Inv Test"):
    c = Client(name=name, org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    return c


def test_assign_heals_null_and_is_unique(ids):
    db = SessionLocal()
    try:
        c = _client(db, ids)
        a = Invoice(client_id=c.id, total=50, status="draft", org_id=1)
        b = Invoice(client_id=c.id, total=60, status="draft", org_id=1)
        db.add(a); db.add(b); db.commit(); db.refresh(a); db.refresh(b)
        ids["invoices"] += [a.id, b.id]

        assert a.invoice_number is None                     # the pre-fix state
        na = assign_invoice_number(db, a)
        nb = assign_invoice_number(db, b)
        db.commit()

        assert na.startswith("INV-") and nb.startswith("INV-")
        assert na != nb                                     # PK-derived → no max()+1 collision
        assert assign_invoice_number(db, a) == na           # idempotent — never renumbers
    finally:
        db.close()


def test_auto_invoice_on_completion_gets_number_and_org(ids):
    db = SessionLocal()
    try:
        c = _client(db, ids, name="Auto Inv")
        p = Property(client_id=c.id, name="1 Test St", address="1 Test St",
                     property_type="residential", org_id=1)
        db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
        j = Job(client_id=c.id, property_id=p.id, job_type="residential",
                title="Clean", status="completed", org_id=1)
        db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)

        _auto_create_draft_invoice(db, j)

        inv = db.query(Invoice).filter(Invoice.job_id == j.id).first()
        assert inv is not None
        assert inv.invoice_number and inv.invoice_number.startswith("INV-")  # was NULL → "Invoice None"
        assert inv.org_id == 1                                               # was unset → cross-workspace leak
    finally:
        db.close()
