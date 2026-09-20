"""The gated quote-edit path (track A, part 2).

Meg chose the approval gate: the assistant never saves a quote directly. It
DRAFTS an `edit_quote` ProposedAction; a human approves it; approval runs the
real quoting write path (patch_quote), so totals recompute and the executed
result carries the true saved total — not whatever the draft implied.

Under test:
  - propose_quote_edit queues a pending proposal and does NOT touch the quote.
  - it is gated: withheld unless the caller may run operations, and refuses a
    cross-org / unknown quote id.
  - approving it edits the quote through patch_quote — items replaced, total
    recomputed — and the result reports the real numbers.
  - payload validation refuses a proposal that would be a guaranteed failure.
  - a proposal whose org can't see the quote fails cleanly (status='failed'),
    never a 500, and never touches another workspace's quote.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Quote, ProposedAction
from services.proposals import create_proposal, execute_proposal, _validate_payload
from agents.tools import execute_tool


class _Decider:
    id = None  # maps to NULL decided_by — a decision that isn't user-attributed


@pytest.fixture
def quote_ctx():
    made = {"clients": [], "quotes": [], "proposals": []}
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"EQ {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    made["clients"].append(c.id)
    q = Quote(
        client_id=c.id, org_id=1, quote_number=f"QT-EQ-{tag}",
        title="STR turnover", service_type="str",
        items=[{"name": "Turnover", "qty": 1, "unit_price": 135},
               {"name": "On-site laundry", "qty": 1, "unit_price": 40},
               {"name": "Off-site laundry", "qty": 1, "unit_price": 25}],
        subtotal=200, tax_rate=0, tax=0, discount=0, total=200, status="draft",
    )
    db.add(q); db.commit(); db.refresh(q)
    made["quotes"].append(q.id)
    yield db, c, q, made
    db.query(ProposedAction).filter(ProposedAction.id.in_(made["proposals"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(made["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


# ── The tool only drafts ─────────────────────────────────────────────────────

def test_propose_quote_edit_drafts_a_proposal_and_leaves_the_quote_alone(quote_ctx):
    db, c, q, made = quote_ctx
    out = execute_tool("propose_quote_edit", {
        "quote_id": q.id,
        "items": [{"name": "Turnover", "qty": 1, "unit_price": 135},
                  {"name": "On-site laundry", "qty": 0, "unit_price": 40},
                  {"name": "Off-site laundry", "qty": 0, "unit_price": 25}],
        "note": "zero out the laundry lines",
    }, "scout", org_id=1, allow_operations=True)
    assert out["proposed"] is True and out["saved"] is False
    made["proposals"].append(out["proposal_id"])
    # A pending proposal exists...
    prop = db.query(ProposedAction).filter(ProposedAction.id == out["proposal_id"]).first()
    assert prop is not None and prop.kind == "edit_quote" and prop.status == "pending"
    # ...and the quote itself is untouched until approval.
    db.refresh(q)
    assert q.total == 200


def test_propose_quote_edit_is_gated_to_operations(quote_ctx):
    db, c, q, made = quote_ctx
    out = execute_tool("propose_quote_edit", {
        "quote_id": q.id, "items": [{"name": "Turnover", "qty": 1, "unit_price": 135}],
    }, "scout", org_id=1)  # allow_operations defaults False
    assert "error" in out and "not available" in out["error"].lower()


def test_propose_quote_edit_refuses_a_quote_outside_the_workspace(quote_ctx):
    db, c, q, made = quote_ctx
    out = execute_tool("propose_quote_edit", {
        "quote_id": q.id, "items": [{"name": "X", "qty": 1, "unit_price": 1}],
    }, "scout", org_id=2, allow_operations=True)  # different org
    assert "error" in out


# ── Approval applies it through the real write path ──────────────────────────

def test_approving_the_proposal_edits_the_quote_and_recomputes_the_total(quote_ctx):
    db, c, q, made = quote_ctx
    prop = create_proposal(
        db, org_id=1, agent_id="scout", kind="edit_quote",
        title="Update", detail="zero the laundry",
        payload={"quote_id": q.id, "items": [
            {"name": "Turnover", "qty": 1, "unit_price": 135},
            {"name": "On-site laundry", "qty": 0, "unit_price": 40},
            {"name": "Off-site laundry", "qty": 0, "unit_price": 25}]},
    )
    made["proposals"].append(prop.id)
    done = execute_proposal(db, prop, _Decider())
    assert done.status == "executed"
    # The executed result carries the REAL recomputed total, not the draft's.
    assert done.result["total"] == 135.0
    # And the quote is actually changed through patch_quote.
    db.refresh(q)
    assert q.total == 135.0
    assert len(q.items) == 3


def test_a_proposal_for_another_orgs_quote_fails_cleanly(quote_ctx):
    db, c, q, made = quote_ctx
    # org 2 proposal targeting an org 1 quote: patch_quote 404s, execution
    # records 'failed' rather than raising, and the quote is untouched.
    prop = create_proposal(
        db, org_id=2, agent_id="scout", kind="edit_quote",
        title="Update", detail="x",
        payload={"quote_id": q.id, "items": [{"name": "X", "qty": 1, "unit_price": 1}]},
    )
    made["proposals"].append(prop.id)
    done = execute_proposal(db, prop, _Decider())
    assert done.status == "failed"
    db.refresh(q)
    assert q.total == 200  # untouched


# ── Validation ───────────────────────────────────────────────────────────────

def test_validate_payload_rejects_bad_edit_quote():
    with pytest.raises(ValueError):
        _validate_payload("edit_quote", {"items": [{"name": "X", "qty": 1, "unit_price": 1}]})  # no quote_id
    with pytest.raises(ValueError):
        _validate_payload("edit_quote", {"quote_id": 5, "items": []})  # empty
    with pytest.raises(ValueError):
        _validate_payload("edit_quote", {"quote_id": 5, "items": [{"qty": 1, "unit_price": 1}]})  # no name
