"""Pipeline population: the lead → quote → job funnel keeps an Opportunity in
sync (so the kanban isn't empty), and backfill_opportunities() seeds deals for
pre-existing clients.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote, Opportunity, Job, LeadIntake
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7301, 1, "admin", "active", True
    email = "pipe-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    cids = ids["clients"] or [0]
    db.query(Job).filter(Job.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(cids)).delete(synchronize_session=False)
    db.commit(); db.close()


def _client(ids, name=None):
    db = SessionLocal()
    c = Client(name=name or f"Pipe {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    cid = c.id
    db.close()
    return cid


def _opp_for(cid):
    db = SessionLocal()
    o = db.query(Opportunity).filter(Opportunity.client_id == cid).order_by(Opportunity.id.desc()).first()
    db.expunge_all(); db.close()
    return o


def test_quote_create_opens_deal_at_quoted(client):
    api, ids = client
    cid = _client(ids)
    r = api.post("/api/quotes", json={"client_id": cid, "items": [{"name": "Clean", "qty": 1, "unit_price": 250}]})
    assert r.status_code in (200, 201), r.text
    quote = r.json()
    opp = _opp_for(cid)
    assert opp is not None and opp.stage == "quoted"
    assert quote["opportunity_id"] == opp.id        # quote linked to the deal
    assert opp.amount == quote["total"]


def test_decline_moves_deal_to_lost(client):
    api, ids = client
    cid = _client(ids)
    q = api.post("/api/quotes", json={"client_id": cid, "items": [{"name": "X", "qty": 1, "unit_price": 100}]}).json()
    assert api.post(f"/api/quotes/{q['id']}/decline").status_code == 200
    assert _opp_for(cid).stage == "lost"


def test_convert_to_job_wins_deal(client):
    api, ids = client
    cid = _client(ids)
    q = api.post("/api/quotes", json={"client_id": cid, "items": [{"name": "X", "qty": 1, "unit_price": 100}]}).json()
    api.post(f"/api/quotes/{q['id']}/accept")
    r = api.post(f"/api/quotes/{q['id']}/convert-to-job")
    assert r.status_code in (200, 201), r.text
    assert _opp_for(cid).stage == "won"


def test_second_quote_reuses_same_active_deal(client):
    api, ids = client
    cid = _client(ids)
    api.post("/api/quotes", json={"client_id": cid, "items": [{"name": "A", "qty": 1, "unit_price": 100}]})
    api.post("/api/quotes", json={"client_id": cid, "items": [{"name": "B", "qty": 1, "unit_price": 200}]})
    db = SessionLocal()
    n = db.query(Opportunity).filter(Opportunity.client_id == cid).count()
    db.close()
    assert n == 1, "a second quote should reuse the client's active deal, not spawn another"


def test_backfill_seeds_and_is_idempotent(client):
    api, ids = client
    from utils.opportunity_helper import backfill_opportunities
    # Seed a client with a quote but NO opportunity (simulating legacy data).
    cid = _client(ids)
    db = SessionLocal()
    q = Quote(client_id=cid, quote_number=f"Q-{uuid.uuid4().hex[:8]}", status="sent", total=300, org_id=1)
    db.add(q); db.commit()
    # No opp yet.
    assert db.query(Opportunity).filter(Opportunity.client_id == cid).count() == 0
    rep1 = backfill_opportunities(db); db.commit()
    rep2 = backfill_opportunities(db); db.commit()
    opps = db.query(Opportunity).filter(Opportunity.client_id == cid).all()
    linked = db.query(Quote).filter(Quote.client_id == cid).first().opportunity_id
    db.close()
    assert len(opps) == 1 and opps[0].stage == "quoted"   # sent → quoted
    assert linked == opps[0].id
    assert rep1["created"] >= 1 and rep2["created"] == 0    # idempotent
