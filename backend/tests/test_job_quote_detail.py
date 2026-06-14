"""Job + Quote record-page backends: /details aggregation, job notes, and the
new job_id filter on the activities feed.
"""
import uuid
import datetime as dt
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Quote, Invoice, Opportunity, Activity, Property
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7101, 1, "admin", "active", True
    email = "jq-admin@example.com"


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
    db.query(Activity).filter(Activity.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.id.in_(ids["opps"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["props"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seed(ids):
    db = SessionLocal()
    c = Client(name=f"JQ Co {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    opp = Opportunity(client_id=c.id, title="Deal", stage="quoted", org_id=1)
    db.add(opp); db.commit(); db.refresh(opp)
    q = Quote(client_id=c.id, opportunity_id=opp.id, quote_number=f"Q-{uuid.uuid4().hex[:8]}",
              status="accepted", total=900, items=[{"name": "Deep clean", "qty": 1, "unit_price": 900}], org_id=1)
    db.add(q); db.commit(); db.refresh(q)
    prop = Property(client_id=c.id, name="Unit A", address="1 Main St", org_id=1)
    db.add(prop); db.commit(); db.refresh(prop)
    ids["props"].append(prop.id)
    j = Job(client_id=c.id, quote_id=q.id, opportunity_id=opp.id, property_id=prop.id, title="Clean job",
            status="scheduled", scheduled_date=dt.date(2026, 7, 1), org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    inv = Invoice(client_id=c.id, job_id=j.id, invoice_number=f"INV-{uuid.uuid4().hex[:6]}",
                  status="draft", total=900, org_id=1)
    db.add(inv); db.commit(); db.refresh(inv)
    ids["clients"].append(c.id); ids["opps"].append(opp.id); ids["quotes"].append(q.id)
    ids["jobs"].append(j.id); ids["invoices"].append(inv.id)
    out = (c.id, opp.id, q.id, j.id, inv.id)
    db.close()
    return out


def test_job_details_aggregates(client):
    api, ids = client
    _, opp_id, q_id, j_id, inv_id = _seed(ids)
    body = api.get(f"/api/jobs/{j_id}/details").json()
    assert body["id"] == j_id
    assert body["opportunity"]["id"] == opp_id
    assert body["quote"]["id"] == q_id
    assert [i["id"] for i in body["invoices"]] == [inv_id]
    assert "timeline" in body


def test_job_note_and_job_id_filter(client):
    api, ids = client
    _, _, _, j_id, _ = _seed(ids)
    r = api.post(f"/api/jobs/{j_id}/notes", json={"body": "Bring extra supplies"})
    assert r.status_code == 201, r.text
    # Lands on the job timeline...
    tl = api.get(f"/api/jobs/{j_id}/details").json()["timeline"]
    assert any(a["summary"] == "Bring extra supplies" for a in tl)
    # ...and the activities feed now filters by job_id.
    feed = api.get(f"/api/activities?job_id={j_id}").json()
    assert any(a["summary"] == "Bring extra supplies" for a in feed)


def test_job_note_blank_rejected_and_404(client):
    api, ids = client
    _, _, _, j_id, _ = _seed(ids)
    assert api.post(f"/api/jobs/{j_id}/notes", json={"body": "  "}).status_code == 400
    assert api.get("/api/jobs/999999/details").status_code == 404


def test_quote_details_aggregates(client):
    api, ids = client
    _, opp_id, q_id, j_id, _ = _seed(ids)
    body = api.get(f"/api/quotes/{q_id}/details").json()
    assert body["id"] == q_id
    assert len(body["items"]) == 1
    assert body["opportunity"]["id"] == opp_id
    assert body["job"]["id"] == j_id          # converted-job back-link via Job.quote_id
    assert api.get("/api/quotes/999999/details").status_code == 404
