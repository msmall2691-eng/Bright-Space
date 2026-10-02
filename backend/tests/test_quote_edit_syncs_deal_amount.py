"""The Pipeline deal amount must follow the quote it's attached to.

`opportunity.amount` is seeded once — from the intake estimate, then from the
quote total at quote-create time — and used to be left to drift. Editing a
quote's line items recomputed the quote total but never the deal, so the board
could show a deal at $150 while its attached quote read $135 (exactly what a
qty-0'd laundry line does to an STR turnover quote). These cover the sync that
`patch_quote`/`send_quote` now run, plus the helper itself.
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Opportunity, Quote
from modules.quoting.router import patch_quote
from schemas.quotes import QuoteUpdate
from utils.opportunity_helper import sync_opportunity_amount


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Drift Co", email="drift@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    # Deal seeded at the intake estimate ($150) before the quote firmed up.
    opp = Opportunity(client_id=c.id, title="STR turnover", stage="quoted", amount=150)
    db.add(opp); db.commit(); db.refresh(opp)
    # A quote whose total ($200) doesn't match the stale deal amount yet.
    q = Quote(
        client_id=c.id, quote_number="QT-DRIFT-1", title="STR / Vacation Rental",
        service_type="str",
        items=[
            {"name": "Airbnb / VRBO turnover", "qty": 1, "unit_price": 135},
            {"name": "On-site laundry (best effort)", "qty": 1, "unit_price": 40},
            {"name": "Off-site laundry service", "qty": 1, "unit_price": 25},
        ],
        subtotal=200, tax_rate=0, tax=0, discount=0, total=200,
        status="draft", opportunity_id=opp.id,
    )
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, opp, q
    db.rollback()
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_editing_line_items_down_resyncs_the_deal_amount(ctx):
    db, c, opp, q = ctx
    # Zero out the two laundry lines — the STR quote that drops to $135.
    patch_quote(q.id, QuoteUpdate(items=[
        {"name": "Airbnb / VRBO turnover", "qty": 1, "unit_price": 135},
        {"name": "On-site laundry (best effort)", "qty": 0, "unit_price": 40},
        {"name": "Off-site laundry service", "qty": 0, "unit_price": 25},
    ]), db=db)
    db.refresh(q); db.refresh(opp)
    assert q.total == 135.0                       # backend recomputes correctly
    assert opp.amount == 135.0, "deal amount stayed stale after the quote was edited down"


def test_status_only_patch_repairs_prior_drift(ctx):
    # A quote created before this fix left the deal at $150 while the quote is
    # $200; even a patch that doesn't touch pricing should close the gap.
    db, c, opp, q = ctx
    patch_quote(q.id, QuoteUpdate(internal_notes="just a note"), db=db)
    db.refresh(opp)
    assert opp.amount == 200.0


def test_helper_is_a_noop_without_a_linked_deal(ctx):
    db, c, opp, q = ctx
    q.opportunity_id = None
    db.commit()
    # Must not raise and must not touch the (now-unlinked) deal.
    assert sync_opportunity_amount(db, q) is None
    db.refresh(opp)
    assert opp.amount == 150
