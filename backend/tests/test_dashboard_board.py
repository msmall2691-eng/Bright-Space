"""GET /api/dashboard/board returns the unified Ops Board payload.

Verified by delta (like test_dashboard_summary): snapshot the board, seed a
known unassigned-today job, an overdue invoice, a new lead and an open
awaiting-reply conversation, then assert the stat tiles moved by exactly that
much — robust against whatever else lives in the shared test DB. Also asserts
the payload's structural contract (sections, stats, integrations, filters).
"""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Property, Job, Invoice, LeadIntake, Conversation,
)
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today, business_now


class _Admin:
    id, org_id, role, status, active = 7402, 1, "admin", "active", True
    email = "board-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "properties": [], "jobs": [], "invoices": [], "leads": [], "convs": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id.in_(ids["leads"] or [0])).delete(synchronize_session=False)
    db.query(Conversation).filter(Conversation.id.in_(ids["convs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(ids):
    db = SessionLocal()
    c = Client(name=f"Board {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def _mk_property(ids, cid):
    db = SessionLocal()
    p = Property(client_id=cid, name="12 Test Lane", address="12 Test Lane",
                 property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id); pid = p.id; db.close()
    return pid


def _mk_unassigned_job_today(ids, cid, pid):
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type="str_turnover",
            title="Turnover", scheduled_date=business_today(),
            start_time=time(10, 0), end_time=time(13, 0),
            cleaner_ids=[], status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id); jid = j.id; db.close()
    return jid


def _mk_overdue_invoice(ids, cid):
    db = SessionLocal()
    inv = Invoice(client_id=cid, invoice_number=f"INV-{uuid.uuid4().hex[:8]}",
                  status="overdue", total=250.0,
                  due_date=(business_today() - timedelta(days=10)).isoformat(),
                  org_id=1)
    db.add(inv); db.commit(); db.refresh(inv)
    ids["invoices"].append(inv.id); iid = inv.id; db.close()
    return iid


def _mk_new_lead(ids):
    db = SessionLocal()
    li = LeadIntake(name=f"Lead {uuid.uuid4().hex[:6]}", status="new", org_id=1)
    db.add(li); db.commit(); db.refresh(li)
    ids["leads"].append(li.id); db.close()


def _mk_waiting_conv(ids, cid):
    db = SessionLocal()
    conv = Conversation(client_id=cid, channel="email", status="open",
                        priority="normal", last_inbound_at=business_now().replace(tzinfo=None),
                        first_response_at=None, org_id=1)
    db.add(conv); db.commit(); db.refresh(conv)
    ids["convs"].append(conv.id); db.close()


def test_board_shape_and_stat_deltas(client):
    api, ids = client

    before = api.get("/api/dashboard/board").json()

    # Structural contract.
    assert set(before) >= {"company", "refreshed_at", "stats", "integrations", "filters", "sections"}
    sec_keys = [s["key"] for s in before["sections"]]
    assert sec_keys == ["needs_today", "jobs_on_deck", "money", "people_waiting", "systems", "safe_to_ignore"]
    assert set(before["filters"]) == {"all", "urgent", "watch", "info", "good", "recurring"}
    stat_keys = {s["key"] for s in before["stats"]}
    assert stat_keys == {"unassigned", "weekend", "overdue", "waiting", "leads", "collected"}
    int_keys = {c["key"] for c in before["integrations"]}
    assert int_keys == {"gmail", "calendar", "connecteam", "square", "twilio"}
    # Every item is well-formed.
    for s in before["sections"]:
        for it in s["items"]:
            assert set(it) >= {"id", "severity", "title", "tags"}
            assert it["severity"] in {"urgent", "watch", "info", "good", "recurring"}

    # Seed one of each signal.
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    jid = _mk_unassigned_job_today(ids, cid, pid)
    iid = _mk_overdue_invoice(ids, cid)
    _mk_new_lead(ids)
    _mk_waiting_conv(ids, cid)

    after = api.get("/api/dashboard/board").json()

    def stat(payload, key):
        return int(next(s["value"] for s in payload["stats"] if s["key"] == key))

    # Stat tiles use uncapped aggregate counts → exact deltas.
    assert stat(after, "unassigned") - stat(before, "unassigned") == 1
    assert stat(after, "overdue") - stat(before, "overdue") == 1
    assert stat(after, "leads") - stat(before, "leads") == 1
    assert stat(after, "waiting") - stat(before, "waiting") == 1

    # Items actually render into sections.
    after_ids = {it["id"] for s in after["sections"] for it in s["items"]}
    assert f"job:{jid}" in after_ids                 # unassigned-today → Needs You Today
    assert "money:outstanding" in after_ids          # overdue invoice → Money summary card
    assert after["filters"]["all"] > before["filters"]["all"]
