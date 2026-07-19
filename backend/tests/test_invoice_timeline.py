"""Invoices now write to the client activity timeline (created + paid), which
was previously missing entirely — the money story never showed up next to the
client's quotes/jobs.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Invoice, Activity
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7641, 1, "admin", "active", True
    email = "inv-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _activity_types(db, client_id):
    return {a.activity_type for a in db.query(Activity).filter(Activity.client_id == client_id).all()}


def test_invoice_create_and_pay_write_timeline_events(api):
    db = SessionLocal()
    try:
        c = Client(name=f"InvTL {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        cid = c.id

        r = api.post("/api/invoices", json={
            "client_id": cid,
            "items": [{"name": "Deep clean", "qty": 1, "unit_price": 300}],
        })
        assert r.status_code == 201, r.text
        inv_id = r.json()["id"]

        db.expire_all()
        assert "invoice_created" in _activity_types(db, cid)

        # Pay it → a paid event appears, exactly once.
        r2 = api.post(f"/api/invoices/{inv_id}/pay", json={})
        assert r2.status_code == 200, r2.text
        db.expire_all()
        paid = [a for a in db.query(Activity).filter(Activity.client_id == cid).all()
                if a.activity_type == "invoice_paid"]
        assert len(paid) == 1

        # Paying again must NOT double-log.
        api.post(f"/api/invoices/{inv_id}/pay", json={})
        db.expire_all()
        paid2 = [a for a in db.query(Activity).filter(Activity.client_id == cid).all()
                 if a.activity_type == "invoice_paid"]
        assert len(paid2) == 1, "already-paid invoice should not re-log a paid event"
    finally:
        db.query(Activity).filter(Activity.client_id == cid).delete(synchronize_session=False)
        db.query(Invoice).filter(Invoice.client_id == cid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
        db.commit(); db.close()
