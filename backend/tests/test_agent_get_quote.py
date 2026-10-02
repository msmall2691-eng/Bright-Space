"""The AI can READ a quote — the read half of the truthfulness fix.

Before this, the assistant had no quote tool at all, so it narrated the numbers
it *meant* to set ("saved and verified, $30, total $175") with nothing able to
contradict it. get_quote returns the SAVED quote — the real line items with a
per-line amount and the real total — and is org-scoped like every other agent
read, so it can't reach another workspace's quote.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Quote
from agents.tools import execute_tool


@pytest.fixture
def quotes():
    made = {"clients": [], "quotes": []}
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Belcher {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    made["clients"].append(c.id)
    # The STR quote from the incident: turnover $135, both laundry lines qty 0.
    mine = Quote(
        client_id=c.id, org_id=1, quote_number=f"QT-GQ-{tag}",
        title="STR / Vacation Rental", service_type="str",
        items=[
            {"name": "Airbnb / VRBO turnover", "qty": 1, "unit_price": 135},
            {"name": "On-site laundry (best effort)", "qty": 0, "unit_price": 40},
            {"name": "Off-site laundry service", "qty": 0, "unit_price": 25},
        ],
        subtotal=135, tax_rate=0, tax=0, discount=0, total=135, status="sent",
    )
    # A quote in ANOTHER org that must be invisible to org 1's assistant.
    theirs = Quote(
        client_id=c.id, org_id=2, quote_number=f"QT-GQX-{tag}",
        title="Someone else's", service_type="residential",
        items=[{"name": "Clean", "qty": 1, "unit_price": 999}],
        subtotal=999, tax_rate=0, tax=0, discount=0, total=999, status="draft",
    )
    db.add_all([mine, theirs]); db.commit()
    db.refresh(mine); db.refresh(theirs)
    made["quotes"] += [mine.id, theirs.id]
    ids = (mine.id, theirs.id, mine.quote_number)
    db.close()
    yield ids
    db = SessionLocal()
    db.query(Quote).filter(Quote.id.in_(made["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_get_quote_returns_the_saved_numbers_with_per_line_amounts(quotes):
    mine_id, _, _ = quotes
    out = execute_tool("get_quote", {"quote_id": mine_id}, "scout", org_id=1)
    assert out["total"] == 135
    assert out["status"] == "sent"
    amounts = {i["name"]: i["amount"] for i in out["items"]}
    # A qty-0 line is $0, not the unit price — the exact confusion from the bug.
    assert amounts["Airbnb / VRBO turnover"] == 135.0
    assert amounts["On-site laundry (best effort)"] == 0.0
    assert amounts["Off-site laundry service"] == 0.0


def test_get_quote_by_number(quotes):
    _, _, qnum = quotes
    out = execute_tool("get_quote", {"quote_number": qnum}, "finn", org_id=1)
    assert out["quote_number"] == qnum
    assert out["total"] == 135


def test_get_quote_cannot_reach_another_org(quotes):
    _, theirs_id, _ = quotes
    out = execute_tool("get_quote", {"quote_id": theirs_id}, "scout", org_id=1)
    assert "error" in out and "999" not in repr(out), "read another org's quote"


def test_get_quote_needs_an_identifier(quotes):
    out = execute_tool("get_quote", {}, "scout", org_id=1)
    assert "error" in out
