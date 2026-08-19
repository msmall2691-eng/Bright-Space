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


class _Viewer:
    id, org_id, role, status, active = 7404, 1, "viewer", "active", True
    email = "board-viewer@example.com"


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


def _mk_str_property(ids, cid):
    """An STR property with turnover-relevant fields filled in, so the deck
    card's turnover-context line has something to render."""
    db = SessionLocal()
    p = Property(client_id=cid, name="9 Lakeshore Dr", address="9 Lakeshore Dr",
                 property_type="str", org_id=1,
                 check_out_time="10:00", check_in_time="16:00", house_code="4521")
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id); pid = p.id; db.close()
    return pid


def _mk_turnover_job_this_week(ids, cid, pid):
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type="str_turnover",
            title="Turnover", scheduled_date=business_today() + timedelta(days=1),
            start_time=time(10, 0), end_time=time(13, 0),
            cleaner_ids=[901], status="scheduled", org_id=1)
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
    ids["convs"].append(conv.id); conv_id = conv.id; db.close()
    return conv_id


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
    assert int_keys == {"gmail", "calendar", "square", "twilio"}
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


def test_reply_action_links_to_the_specific_conversation(client):
    """BB-CODE-03: the board's "Reply" action used to link bare `/comms` —
    no conversation id — so it always opened the inbox list instead of the
    thread the owner was trying to answer. It must carry the conversation's
    own id so Comms.jsx can open that exact thread."""
    api, ids = client
    cid = _mk_client(ids)
    conv_id = _mk_waiting_conv(ids, cid)

    board = api.get("/api/dashboard/board").json()
    waiting = next(s for s in board["sections"] if s["key"] == "people_waiting")
    item = next(it for it in waiting["items"] if it["id"] == f"wait-conv:{conv_id}")
    reply = next(a for a in item["actions"] if a["label"] == "Reply")
    assert reply["href"] == f"/comms?conversation={conv_id}"


def test_turnover_card_shows_checkout_checkin_and_code(client):
    """A Jobs-on-Deck card for an STR turnover surfaces the checkout→check-in
    window and door code in its `meta` line — visible on the board itself,
    not just after opening the job detail drawer."""
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_str_property(ids, cid)
    jid = _mk_turnover_job_this_week(ids, cid, pid)

    board = api.get("/api/dashboard/board").json()
    deck = next(s for s in board["sections"] if s["key"] == "jobs_on_deck")
    item = next(it for it in deck["items"] if it["id"] == f"deck-job:{jid}")

    assert "Out 10:00 → In 16:00" in item["meta"]
    assert "Code 4521" in item["meta"]


def test_turnover_card_omits_context_when_property_missing_data(client):
    """A non-STR job (or an STR property with no checkout/check-in/code set)
    never renders a partial or misleading turnover line."""
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)  # residential, no STR fields
    jid = _mk_unassigned_job_today(ids, cid, pid)  # job_type=str_turnover, but bare property

    board = api.get("/api/dashboard/board").json()
    all_items = [it for s in board["sections"] for it in s["items"]]
    item = next((it for it in all_items if it["id"] == f"deck-job:{jid}"), None)
    if item is not None:
        assert "Out" not in item["meta"] and "Code" not in item["meta"]


def test_viewer_board_strips_one_click_api_actions(client):
    """A read-only role sees the board but not the one-click write actions — the
    api actions (auto-assign, mark paid, resolve) are dropped server-side so the
    endpoint, not the UI, is the enforcement point. link (navigation) stays."""
    api, ids = client

    # Seed signals that generate api actions (auto-assign an unassigned job,
    # mark an overdue invoice paid).
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)
    _mk_unassigned_job_today(ids, cid, pid)
    _mk_overdue_invoice(ids, cid)

    # Admin (fixture default) gets the one-click api buttons...
    admin_board = api.get("/api/dashboard/board").json()
    admin_actions = [a for s in admin_board["sections"] for it in s["items"] for a in it["actions"]]
    assert any(a["kind"] == "api" for a in admin_actions), "admin should get one-click api actions"

    # ...a viewer sees the same board with every api action stripped.
    app.dependency_overrides[get_current_user] = lambda: _Viewer()
    viewer_board = api.get("/api/dashboard/board").json()
    viewer_items = [it for s in viewer_board["sections"] for it in s["items"]]
    assert viewer_items, "viewer should still see board items"
    for it in viewer_items:
        assert all(a["kind"] != "api" for a in it["actions"]), f"api action leaked to viewer on {it['id']}"
    # Navigation actions are preserved.
    assert any(a["kind"] == "link" for it in viewer_items for a in it["actions"])


def _mk_job_today(ids, cid, pid, status, cleaner_ids=None):
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type="residential",
            title=f"{status} job", scheduled_date=business_today(),
            start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=cleaner_ids or [], status=status, org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id); jid = j.id; db.close()
    return jid


def test_finished_visits_never_count_as_needing_a_cleaner(client):
    """Widening the board's job query to include `completed` must not leak
    finished work into the unassigned counts — those drive 'go assign
    someone', which is nonsense for a job that's already done."""
    api, ids = client
    cid = _mk_client(ids)
    pid = _mk_property(ids, cid)

    before = api.get("/api/dashboard/board").json()
    unassigned_before = int(next(s["value"] for s in before["stats"] if s["key"] == "unassigned"))

    done_id = _mk_job_today(ids, cid, pid, "completed")   # no cleaner_ids

    after = api.get("/api/dashboard/board").json()
    unassigned_after = int(next(s["value"] for s in after["stats"] if s["key"] == "unassigned"))
    assert unassigned_after == unassigned_before, \
        "a completed job must not count as an unassigned job"

    after_ids = {it["id"] for s in after["sections"] for it in s["items"]}
    assert f"job:{done_id}" not in after_ids, "completed job must not raise a Needs-You-Today card"
    assert f"deck-job:{done_id}" not in after_ids, "completed job is not upcoming work on the deck"
