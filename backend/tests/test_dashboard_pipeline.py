"""GET /api/dashboard/pipeline — the lead→cash spine as one stage-grouped list.

Robust against the shared test DB: seed one known row per stage, then assert
each seeded row lands in the right stage with the right next-action link,
matched by its own item id (e.g. `accepted:{quote_id}`). We don't count — other
rows live in the DB — we check our own rows placed correctly.
"""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, Invoice, LeadIntake, Quote
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 7502, 1, "admin", "active", True
    email = "pipe-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "properties": [], "jobs": [], "invoices": [], "leads": [], "quotes": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Quote).filter(Quote.id.in_(ids["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id.in_(ids["leads"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _client_id(ids):
    db = SessionLocal()
    c = Client(name=f"Pipe {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def _by_key(payload):
    return {s["key"]: s for s in payload["stages"]}


def _ids_in(stage):
    return {it["id"] for it in stage["items"]}


def _action(stage, item_id):
    it = next(i for i in stage["items"] if i["id"] == item_id)
    return it["actions"][0]


def test_each_stage_carries_its_row_with_the_right_next_action(client):
    api, ids = client
    cid = _client_id(ids)
    db = SessionLocal()

    tag = uuid.uuid4().hex[:8]
    lead = LeadIntake(name="Walk-in", status="new", org_id=1, requested_service="Deep clean")
    sent_q = Quote(client_id=cid, status="sent", total=200.0, org_id=1, title="Sent quote",
                   quote_number=f"Q-{tag}-1")
    acc_q = Quote(client_id=cid, status="accepted", total=633.0, org_id=1, title="Accepted quote",
                  quote_number=f"Q-{tag}-2")
    prop = Property(client_id=cid, name="9 Dock Ln", address="9 Dock Ln",
                    property_type="residential", org_id=1)
    draft_inv = Invoice(client_id=cid, status="draft", total=180.0, org_id=1)
    overdue_inv = Invoice(client_id=cid, status="overdue", total=90.0, org_id=1, due_date="2020-01-01")
    db.add_all([lead, sent_q, acc_q, prop, draft_inv, overdue_inv]); db.commit()
    for obj, bucket in ((lead, "leads"), (sent_q, "quotes"), (acc_q, "quotes"),
                        (prop, "properties"), (draft_inv, "invoices"), (overdue_inv, "invoices")):
        db.refresh(obj); ids[bucket].append(obj.id)
    booked = Job(client_id=cid, property_id=prop.id, job_type="residential", title="Clean",
                 scheduled_date=business_today() + timedelta(days=3),
                 start_time=time(10, 0), end_time=time(13, 0), status="scheduled",
                 cleaner_ids=[], org_id=1)
    db.add(booked); db.commit(); db.refresh(booked); ids["jobs"].append(booked.id)
    lead_id, sent_id, acc_id, draft_id, overdue_id, job_id = (
        lead.id, sent_q.id, acc_q.id, draft_inv.id, overdue_inv.id, booked.id)
    db.close()

    r = api.get("/api/dashboard/pipeline")
    assert r.status_code == 200
    stages = _by_key(r.json())

    assert f"lead:{lead_id}" in _ids_in(stages["new"])
    assert f"quote:{sent_id}" in _ids_in(stages["quoted"])
    assert f"accepted:{acc_id}" in _ids_in(stages["accepted"])
    assert f"job:{job_id}" in _ids_in(stages["booked"])
    assert f"invoice:{draft_id}" in _ids_in(stages["to_invoice"])
    assert f"unpaid:{overdue_id}" in _ids_in(stages["unpaid"])

    # Booking the accepted quote lands on the quote's booking flow (which no
    # longer dead-ends), and an unassigned booked job is flagged for a cleaner.
    assert _action(stages["accepted"], f"accepted:{acc_id}")["href"] == f"/quotes/{acc_id}?book=1"
    # ...and a quiet Archive escape hatch to clear a dead/test quote in place.
    acc_item = next(i for i in stages["accepted"]["items"] if i["id"] == f"accepted:{acc_id}")
    archive = next(a for a in acc_item["actions"] if a.get("kind") == "api")
    assert archive["method"] == "DELETE" and archive["endpoint"] == f"/api/quotes/{acc_id}"

    # In-place actions reuse existing endpoints: draft a quote from a lead,
    # send a draft invoice (confirm-gated, outward-facing), mark an unpaid one
    # paid.
    def _api_action(stage_key, item_id):
        it = next(i for i in stages[stage_key]["items"] if i["id"] == item_id)
        return next(a for a in it["actions"] if a.get("kind") == "api")

    draft = _api_action("new", f"lead:{lead_id}")
    assert draft["method"] == "POST" and draft["endpoint"] == f"/api/ai/quote-from-lead/{lead_id}"
    assert "confirm" not in draft  # drafting is safe — fires on the first tap

    send = _api_action("to_invoice", f"invoice:{draft_id}")
    assert send["endpoint"] == f"/api/invoices/{draft_id}/send" and send["confirm"]

    paid = _api_action("unpaid", f"unpaid:{overdue_id}")
    assert paid["endpoint"] == f"/api/invoices/{overdue_id}/pay" and paid["confirm"]
    job_item = next(i for i in stages["booked"]["items"] if i["id"] == f"job:{job_id}")
    assert any(t["label"] == "Needs cleaner" for t in job_item["tags"])


def test_pipeline_is_org_scoped(client):
    api, ids = client
    cid = _client_id(ids)
    db = SessionLocal()
    acc = Quote(client_id=cid, status="accepted", total=500.0, org_id=1, title="Org-1 quote",
                quote_number=f"Q-{uuid.uuid4().hex[:8]}")
    db.add(acc); db.commit(); db.refresh(acc); ids["quotes"].append(acc.id)
    acc_id = acc.id; db.close()

    # Org 1 sees its own accepted quote...
    mine = _by_key(api.get("/api/dashboard/pipeline").json())
    assert f"accepted:{acc_id}" in _ids_in(mine.get("accepted", {"items": []}))

    # ...another org does not (the OR org IS NULL predicate still never leaks a
    # row that belongs to a specific other org).
    app.dependency_overrides[current_org_id] = lambda: 999
    other = _by_key(api.get("/api/dashboard/pipeline").json())
    assert f"accepted:{acc_id}" not in _ids_in(other.get("accepted", {"items": []}))
