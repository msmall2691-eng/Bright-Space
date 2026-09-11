"""BB-FIND-03: the Requests derived-status tabs must not full-table-scan.

new/reviewed/quoted/converted are DERIVED from a lead's quote/opportunity
(utils.deal_stage.lead_display_status), not stored, so the list endpoint loaded
EVERY non-archived lead, batch-loaded their quotes, derived each and sliced in
Python — a full scan on every tap. `lead_display_status_candidate_filter` now
prunes the scan in SQL to a SUPERSET of the rows that could match, while the
Python derivation still makes the exact call.

The one thing that can break with a SQL superset is a false NEGATIVE: a row the
prefilter wrongly excludes vanishes from its tab. So this is an EQUIVALENCE
test — for a lead of every display-status shape (including the ones that derive
from the stored status alone, and a 'received' row that belongs to no tab), the
optimized endpoint must return it under exactly the tab its derivation says, and
under no other. If the superset ever drops a true match, one of these fails.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Opportunity, Quote, LeadIntake
from modules.intake.router import get_intakes


TABS = ("new", "reviewed", "quoted", "converted")


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Derive Co", email=f"d-{uuid.uuid4().hex[:6]}@example.com",
               status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    made = {"quotes": [], "intakes": [], "opps": []}
    yield db, c, made
    db.rollback()
    db.query(LeadIntake).filter(LeadIntake.id.in_(made["intakes"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(made["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.id.in_(made["opps"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _opportunity(db, c, made):
    o = Opportunity(client_id=c.id, title="Rev", stage="new", org_id=1)
    db.add(o); db.commit(); db.refresh(o); made["opps"].append(o.id)
    return o


def _quote(db, c, made, status):
    q = Quote(client_id=c.id, quote_number=f"QT-{uuid.uuid4().hex[:6]}", title="T",
              service_type="residential", items=[], subtotal=100, tax_rate=0, tax=0,
              discount=0, total=100, status=status, org_id=1)
    db.add(q); db.commit(); db.refresh(q); made["quotes"].append(q.id)
    return q


def _lead(db, made, **kw):
    lead = LeadIntake(name="L", email=f"l-{uuid.uuid4().hex[:8]}@example.com",
                      source="website", org_id=1, **kw)
    db.add(lead); db.commit(); db.refresh(lead); made["intakes"].append(lead.id)
    return lead


def test_pruned_scan_matches_a_full_scan_on_every_tab(ctx):
    db, c, made = ctx

    # One lead of every display-status shape, including the stored-status-only
    # paths the superset has to reach, plus a 'received' (a stored value that
    # derives to no tab) and an 'archived' (never in a non-archived tab).
    q_sent = _quote(db, c, made, "sent")
    q_conv = _quote(db, c, made, "converted")
    opp = _opportunity(db, c, made)   # a real row, so an FK-enforcing DB is happy

    leads = {
        "new_stored":       _lead(db, made, status="new").id,
        "new_null":         _lead(db, made, status=None).id,
        "reviewed_opp":     _lead(db, made, status="new", opportunity_id=opp.id).id,
        "reviewed_stored":  _lead(db, made, status="reviewed").id,
        "quoted_quote":     _lead(db, made, status="quoted", converted_quote_id=q_sent.id).id,
        "quoted_stored":    _lead(db, made, status="quoted").id,
        "converted_quote":  _lead(db, made, status="quoted", converted_quote_id=q_conv.id).id,
        "converted_stored": _lead(db, made, status="converted").id,
        "received_orphan":  _lead(db, made, status="received").id,
        "archived_row":     _lead(db, made, status="archived").id,
    }
    # The tab each seeded lead must land under (None = none of the four).
    expected_tab = {
        "new_stored": "new", "new_null": "new",
        "reviewed_opp": "reviewed", "reviewed_stored": "reviewed",
        "quoted_quote": "quoted", "quoted_stored": "quoted",
        "converted_quote": "converted", "converted_stored": "converted",
        "received_orphan": None, "archived_row": None,
    }

    for tab in TABS:
        got = {r["id"] for r in get_intakes(status=tab, db=db, org_id=1, limit=200, offset=0)}
        for key, lead_id in leads.items():
            if expected_tab[key] == tab:
                assert lead_id in got, f"{key} missing from the {tab} tab (superset dropped it?)"
            else:
                assert lead_id not in got, f"{key} wrongly showed under {tab}"
