"""Opportunity record-page backend: /details aggregation + note logging.

Covers the bug fix where /details iterated a non-existent Opportunity.quotes
relationship (500), now a client/opp-scoped Quote query, plus the new
POST /{id}/notes that anchors a NOTE_ADDED activity to the deal's timeline.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Opportunity, Quote, Activity
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7001, 1, "admin", "active", True
    email = "deal-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    created = {"clients": [], "opps": [], "quotes": []}
    yield api, created
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Activity).filter(Activity.opportunity_id.in_(created["opps"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(created["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.id.in_(created["opps"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(created["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seed(created):
    db = SessionLocal()
    c = Client(name=f"Deal Co {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    o = Opportunity(client_id=c.id, title="Big Deal", stage="qualified", amount=5000, org_id=1)
    db.add(o); db.commit(); db.refresh(o)
    q = Quote(client_id=c.id, opportunity_id=o.id, quote_number=f"Q-{uuid.uuid4().hex[:8]}",
              status="sent", total=5000, org_id=1)
    db.add(q); db.commit(); db.refresh(q)
    created["clients"].append(c.id); created["opps"].append(o.id); created["quotes"].append(q.id)
    db.close()
    return c.id, o.id, q.id


def test_details_aggregates_linked_quotes(client):
    api, created = client
    _, oid, qid = _seed(created)
    r = api.get(f"/api/opportunities/{oid}/details")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == oid
    assert body["client_name"]
    assert body["quotes_count"] == 1
    assert [q["id"] for q in body["quotes"]] == [qid]   # linked via opportunity_id, no 500
    assert "timeline" in body and "jobs" in body and "invoices" in body


def test_details_404_for_missing(client):
    api, _ = client
    assert api.get("/api/opportunities/999999/details").status_code == 404


def test_add_note_lands_on_timeline(client):
    api, created = client
    _, oid, _ = _seed(created)
    r = api.post(f"/api/opportunities/{oid}/notes", json={"body": "Called, very interested"})
    assert r.status_code == 201, r.text
    assert r.json()["summary"] == "Called, very interested"
    # Note shows up in the deal timeline.
    tl = api.get(f"/api/opportunities/{oid}/details").json()["timeline"]
    assert any(a["summary"] == "Called, very interested" for a in tl)
    # And is filterable via the activities feed by opportunity.
    acts = api.get(f"/api/activities?opportunity_id={oid}").json()
    assert any(a["summary"] == "Called, very interested" for a in acts)


def test_blank_note_rejected(client):
    api, created = client
    _, oid, _ = _seed(created)
    assert api.post(f"/api/opportunities/{oid}/notes", json={"body": "   "}).status_code == 400
