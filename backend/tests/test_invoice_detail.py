"""Invoice record-page backend: GET /api/invoices/{id}/details aggregation.

Verifies the detail endpoint resolves the linked client, job, opportunity, and
the originating quote (reached via Job.quote_id) and 404s for a missing id.
"""
import uuid
import datetime as dt
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Quote, Invoice, Opportunity, Property
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7201, 1, "admin", "active", True
    email = "inv-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "jobs": [], "quotes": [], "invoices": [], "opps": [], "props": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Invoice).filter(Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.id.in_(ids["opps"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["props"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seed(ids):
    db = SessionLocal()
    c = Client(name=f"Inv Co {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    opp = Opportunity(client_id=c.id, title="Deal", stage="won", org_id=1)
    db.add(opp); db.commit(); db.refresh(opp)
    q = Quote(client_id=c.id, quote_number=f"Q-{uuid.uuid4().hex[:8]}", status="accepted", total=400, org_id=1)
    db.add(q); db.commit(); db.refresh(q)
    prop = Property(client_id=c.id, name="Unit B", address="2 Oak St", org_id=1)
    db.add(prop); db.commit(); db.refresh(prop)
    j = Job(client_id=c.id, quote_id=q.id, property_id=prop.id, title="Clean", status="completed",
            scheduled_date=dt.date(2026, 7, 2), org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    inv = Invoice(client_id=c.id, job_id=j.id, opportunity_id=opp.id,
                  invoice_number=f"INV-{uuid.uuid4().hex[:6]}", status="sent", total=400,
                  items=[{"name": "Clean", "qty": 1, "unit_price": 400}], org_id=1)
    db.add(inv); db.commit(); db.refresh(inv)
    for k, v in [("clients", c.id), ("opps", opp.id), ("quotes", q.id),
                 ("props", prop.id), ("jobs", j.id), ("invoices", inv.id)]:
        ids[k].append(v)
    out = (c.id, opp.id, q.id, j.id, inv.id)
    db.close()
    return out


def test_invoice_details_aggregates(client):
    api, ids = client
    c_id, opp_id, q_id, j_id, inv_id = _seed(ids)
    body = api.get(f"/api/invoices/{inv_id}/details").json()
    assert body["id"] == inv_id
    assert body["client_name"]
    assert len(body["items"]) == 1
    assert body["job"]["id"] == j_id
    assert body["opportunity"]["id"] == opp_id
    assert body["quote"]["id"] == q_id          # originating quote via Job.quote_id


def test_invoice_details_404(client):
    api, _ = client
    assert api.get("/api/invoices/999999/details").status_code == 404
