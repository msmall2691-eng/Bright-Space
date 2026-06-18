"""GET /api/dashboard/summary computes the quote funnel, pipeline value, new-lead
count and active-client count with SQL aggregates. Verified by delta: snapshot
the summary, seed known rows, and assert the summary moved by exactly that much
(robust against whatever else lives in the shared test DB).
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote, LeadIntake
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7401, 1, "admin", "active", True
    email = "dash-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "quotes": [], "leads": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id.in_(ids["leads"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(ids, status="active"):
    db = SessionLocal()
    c = Client(name=f"Dash {uuid.uuid4().hex[:6]}", status=status, org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    cid = c.id
    db.close()
    return cid


def _mk_quote(ids, cid, status, total):
    db = SessionLocal()
    q = Quote(client_id=cid, quote_number=f"Q-{uuid.uuid4().hex[:8]}",
              status=status, total=total, org_id=1)
    db.add(q); db.commit(); db.refresh(q)
    ids["quotes"].append(q.id)
    db.close()


def _mk_lead(ids, status):
    db = SessionLocal()
    li = LeadIntake(name=f"Lead {uuid.uuid4().hex[:6]}", status=status, org_id=1)
    db.add(li); db.commit(); db.refresh(li)
    ids["leads"].append(li.id)
    db.close()


def test_dashboard_summary_aggregates(client):
    api, ids = client

    before = api.get("/api/dashboard/summary").json()

    cid = _mk_client(ids, status="active")          # +1 active client
    _mk_quote(ids, cid, "sent", 100.0)              # awaiting, quoted, pipeline
    _mk_quote(ids, cid, "viewed", 50.0)             # awaiting, quoted
    _mk_quote(ids, cid, "changes_requested", 0.0)   # changes, quoted
    _mk_quote(ids, cid, "accepted", 200.0)          # to_schedule, accepted
    _mk_quote(ids, cid, "converted", 999.0)         # won
    _mk_quote(ids, cid, "draft", 30.0)              # pipeline only
    _mk_lead(ids, "new")                            # +1 new lead
    _mk_lead(ids, "reviewed")                        # NOT a new lead

    after = api.get("/api/dashboard/summary").json()

    bq, aq = before["quotes"], after["quotes"]
    assert aq["sent"] - bq["sent"] == 1
    assert aq["draft"] - bq["draft"] == 1
    assert aq["awaiting"] - bq["awaiting"] == 2          # sent + viewed
    assert aq["changes"] - bq["changes"] == 1
    assert aq["to_schedule"] - bq["to_schedule"] == 1
    assert aq["quoted"] - bq["quoted"] == 3             # sent + viewed + changes
    assert aq["accepted"] - bq["accepted"] == 1
    assert aq["won"] - bq["won"] == 1
    # pipeline = Σ total where status in (sent, draft) = 100 + 30
    assert round(aq["pipeline_value"] - bq["pipeline_value"], 2) == 130.0
    assert after["new_leads"] - before["new_leads"] == 1
    assert after["active_clients"] - before["active_clients"] == 1
