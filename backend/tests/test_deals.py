"""The unified deal read-model (/api/deals, P4 PR-3).

Pins: inbox leads + opportunities union into one card list; triaged/archived
leads drop out of the inbox; quote_status/job_state enrichment; the stage and
search filters; and org isolation (an org-2 row is invisible to an org-1
caller).
"""
import uuid
from datetime import date
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote, Opportunity, Job, LeadIntake, User, Property
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7401, 1, "admin", "active", True
    email = "deals-admin@example.com"


@pytest.fixture
def ctx():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    db = SessionLocal()
    if not db.query(User).filter(User.id == _Admin.id).first():
        db.add(User(id=_Admin.id, email=_Admin.email, role=_Admin.role,
                     org_id=_Admin.org_id, status=_Admin.status, active=_Admin.active))
        db.commit()
    db.close()
    api = TestClient(app)
    ids = {"clients": [], "leads": [], "opps": [], "quotes": [], "jobs": [], "props": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["props"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id.in_(ids["leads"] or [0])).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.id.in_(ids["opps"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id == _Admin.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(ids, org_id=1):
    db = SessionLocal()
    c = Client(name=f"Deal {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    db.close()
    return c.id


def _mk_lead(ids, org_id=1, **kw):
    db = SessionLocal()
    l = LeadIntake(name=kw.pop("name", "Web Lead"), org_id=org_id, **kw)
    db.add(l); db.commit(); db.refresh(l)
    ids["leads"].append(l.id)
    db.close()
    return l.id


def _mk_opp(ids, client_id, org_id=1, stage="new", **kw):
    db = SessionLocal()
    o = Opportunity(client_id=client_id, org_id=org_id, stage=stage,
                    title=kw.pop("title", "Deal"), **kw)
    db.add(o); db.commit(); db.refresh(o)
    ids["opps"].append(o.id)
    db.close()
    return o.id


def _get(api, **params):
    r = api.get("/api/deals", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_unions_inbox_leads_and_deals(ctx):
    api, ids = ctx
    lead_id = _mk_lead(ids, status="new", service_type="residential",
                       estimate_min=200, estimate_max=300)
    cid = _mk_client(ids)
    opp_id = _mk_opp(ids, cid, stage="qualified", amount=500)

    cards = _get(api)
    by_id = {c["id"]: c for c in cards}
    assert f"lead-{lead_id}" in by_id and f"deal-{opp_id}" in by_id

    lead_card = by_id[f"lead-{lead_id}"]
    assert lead_card["kind"] == "lead" and lead_card["stage"] == "inbox"
    assert lead_card["amount"] == 250  # estimate midpoint

    deal_card = by_id[f"deal-{opp_id}"]
    assert deal_card["kind"] == "deal" and deal_card["stage"] == "qualified"


def test_triaged_and_archived_leads_are_not_inbox_cards(ctx):
    api, ids = ctx
    cid = _mk_client(ids)
    opp_id = _mk_opp(ids, cid, stage="new")
    triaged = _mk_lead(ids, status="reviewed", opportunity_id=opp_id)  # promoted → its deal represents it
    archived = _mk_lead(ids, status="archived")

    card_ids = {c["id"] for c in _get(api)}
    assert f"lead-{triaged}" not in card_ids
    assert f"lead-{archived}" not in card_ids


def test_enriches_quote_status_and_job_state(ctx):
    api, ids = ctx
    cid = _mk_client(ids)
    opp_id = _mk_opp(ids, cid, stage="won")
    db = SessionLocal()
    q = Quote(client_id=cid, opportunity_id=opp_id, org_id=1,
              quote_number=f"QT-D-{uuid.uuid4().hex[:6]}", status="converted",
              items=[], subtotal=0, total=0, tax=0, tax_rate=0)
    db.add(q); db.commit(); db.refresh(q); ids["quotes"].append(q.id)
    prop = Property(client_id=cid, org_id=1, name="Deal Site", address="1 Deal St")
    db.add(prop); db.commit(); db.refresh(prop); ids["props"].append(prop.id)
    j = Job(client_id=cid, opportunity_id=opp_id, org_id=1, title="J", property_id=prop.id,
            status="completed", scheduled_date=date(2026, 8, 1))
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    quote_id, job_id = q.id, j.id  # capture before db.close() expires attrs
    db.close()

    card = next(c for c in _get(api) if c["id"] == f"deal-{opp_id}")
    assert card["quote_status"] == "converted"
    assert card["job_state"] == "done"
    assert card["quote_id"] == quote_id
    assert card["job_id"] == job_id


def test_no_quote_or_job_yields_null_ids(ctx):
    api, ids = ctx
    cid = _mk_client(ids)
    opp_id = _mk_opp(ids, cid, stage="new")

    card = next(c for c in _get(api) if c["id"] == f"deal-{opp_id}")
    assert card["quote_status"] is None and card["quote_id"] is None
    assert card["job_state"] is None and card["job_id"] is None


def test_stage_filter_narrows_to_one_column(ctx):
    api, ids = ctx
    lead_id = _mk_lead(ids, status="new")
    cid = _mk_client(ids)
    won_id = _mk_opp(ids, cid, stage="won")

    inbox = _get(api, stage="inbox")
    assert all(c["kind"] == "lead" for c in inbox)
    assert f"lead-{lead_id}" in {c["id"] for c in inbox}

    won = _get(api, stage="won")
    assert all(c["stage"] == "won" for c in won)
    assert f"deal-{won_id}" in {c["id"] for c in won}
    assert f"lead-{lead_id}" not in {c["id"] for c in won}


def test_search_matches_title_or_client(ctx):
    api, ids = ctx
    cid = _mk_client(ids)
    opp_id = _mk_opp(ids, cid, stage="new", title="Zebra Deep Clean")
    hits = {c["id"] for c in _get(api, search="zebra")}
    assert f"deal-{opp_id}" in hits


def test_org_isolation(ctx):
    api, ids = ctx
    # An org-2 lead and deal must be invisible to the org-1 caller.
    other_lead = _mk_lead(ids, org_id=2, status="new")
    other_cid = _mk_client(ids, org_id=2)
    other_opp = _mk_opp(ids, other_cid, org_id=2, stage="new")

    card_ids = {c["id"] for c in _get(api)}
    assert f"lead-{other_lead}" not in card_ids
    assert f"deal-{other_opp}" not in card_ids
