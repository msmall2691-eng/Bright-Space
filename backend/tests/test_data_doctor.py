"""Data Doctor — the read-only whole-schema data-quality scan.

Seeds a handful of deliberately-broken rows in an isolated workspace and asserts
the scan reports each class of problem, that it never writes, and that a clean
workspace comes back healthy. The scan is the sibling of the recurring health
scan and, like it, must only ever SELECT.
"""
import uuid
from datetime import date, timedelta
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Quote, Job, Invoice, Opportunity
from services.data_doctor import run_data_scan

client = TestClient(app)
ORG = 88123          # isolated workspace for the "broken data" fixtures
CLEAN_ORG = 88124    # a workspace we keep pristine


def _codes(report):
    return {f["code"] for f in report["findings"]}


def test_scan_flags_each_problem_class_and_never_writes():
    db = SessionLocal()
    c = Client(name="Doc Owner", status="active", org_id=ORG)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(name="1 Test Way", address="1 Test Way", client_id=c.id, org_id=ORG)
    db.add(p); db.commit(); db.refresh(p)

    past = date.today() - timedelta(days=10)
    rows = [
        # negative money
        Quote(client_id=c.id, quote_number=f"QT-N-{uuid.uuid4().hex[:6]}", title="neg",
              status="draft", subtotal=0, tax=0, discount=0, total=-5, org_id=ORG),
        # total ≠ subtotal + tax − discount
        Quote(client_id=c.id, quote_number=f"QT-M-{uuid.uuid4().hex[:6]}", title="mismatch",
              status="draft", subtotal=100, tax=0, discount=0, total=50, org_id=ORG),
        # past valid_until but still open
        Quote(client_id=c.id, quote_number=f"QT-E-{uuid.uuid4().hex[:6]}", title="expired",
              status="sent", subtotal=100, tax=0, discount=0, total=100, valid_until=past, org_id=ORG),
        # job dated in the past, still open
        Job(client_id=c.id, property_id=p.id, title="Past job", scheduled_date=past, status="scheduled", org_id=ORG),
        # orphaned client reference (nonexistent client id)
        Job(client_id=999_000_111, property_id=p.id, title="Orphan job", status="scheduled", org_id=ORG),
        # duplicate client emails
        Client(name="Dup A", status="active", email="dupe@example.com", org_id=ORG),
        Client(name="Dup B", status="active", email="DUPE@example.com", org_id=ORG),
    ]
    db.add_all(rows); db.commit()
    ids = {"client": c.id, "property": p.id, "quotes": [r.id for r in rows[:3]],
           "jobs": [r.id for r in rows[3:5]], "dups": [r.id for r in rows[5:]]}

    before = (db.query(Quote).count(), db.query(Job).count(), db.query(Client).count())
    try:
        report = run_data_scan(db, org_id=ORG)
        codes = _codes(report)
        assert "quote_negative_money" in codes
        assert "quote_total_mismatch" in codes
        assert "quote_expired_still_open" in codes
        assert "job_past_not_closed" in codes
        assert "orphan_job_client" in codes
        assert "duplicate_client_email" in codes
        assert report["healthy"] is False
        assert "scan_check_failed" not in codes  # no check blew up

        # Read-only: the scan must not have inserted/updated/deleted anything.
        after = (db.query(Quote).count(), db.query(Job).count(), db.query(Client).count())
        assert after == before
    finally:
        db.query(Job).filter(Job.id.in_(ids["jobs"])).delete(synchronize_session=False)
        db.query(Quote).filter(Quote.id.in_(ids["quotes"])).delete(synchronize_session=False)
        db.query(Client).filter(Client.org_id == ORG).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == ids["property"]).delete(synchronize_session=False)
        db.commit(); db.close()


def test_clean_workspace_is_healthy():
    db = SessionLocal()
    c = Client(name="Clean Owner", status="active", org_id=CLEAN_ORG)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(name="2 Clean Rd", address="2 Clean Rd", client_id=c.id, org_id=CLEAN_ORG)
    db.add(p); db.commit(); db.refresh(p)
    q = Quote(client_id=c.id, quote_number=f"QT-OK-{uuid.uuid4().hex[:6]}", title="ok",
              status="draft", subtotal=100, tax=5, discount=0, total=105, org_id=CLEAN_ORG)
    db.add(q); db.commit(); db.refresh(q)
    try:
        report = run_data_scan(db, org_id=CLEAN_ORG)
        # A scoped clean workspace has no error/warn findings of its own.
        # (null_org_rows only runs on an all-workspaces sweep, so it can't fire here.)
        assert report["healthy"] is True, report["findings"]
    finally:
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_admin_endpoint_returns_report():
    r = client.get("/api/admin/data-health")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "findings" in body and "summary" in body and "healthy" in body
