"""BB-FIND-02: the Requests "Converted" filter must find converted leads.

A lead's inbox status is DERIVED (utils.deal_stage.lead_display_status): once its
quote becomes a job the lead reads as "converted", even though the stored
`status` column is never advanced to that value. The list endpoint filtered the
stored column, so GET /api/intake?status=converted matched zero rows — the
Converted tab was always empty and every converted lead sat mislabeled under
Quoted. This filters on the derived display status instead.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Quote, LeadIntake
from modules.intake.router import get_intakes


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Lead Co", email=f"lead-{uuid.uuid4().hex[:6]}@example.com", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    made = {"client": c.id, "quotes": [], "intakes": []}
    yield db, c, made
    db.rollback()
    db.query(LeadIntake).filter(LeadIntake.id.in_(made["intakes"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(made["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _converted_lead(db, c, made):
    # A quote that became a job (status "converted") + a lead pointing at it,
    # whose STORED status is still "quoted" — exactly the real shape.
    q = Quote(client_id=c.id, quote_number=f"QT-{uuid.uuid4().hex[:6]}", title="T",
              service_type="residential", items=[], subtotal=100, tax_rate=0, tax=0,
              discount=0, total=100, status="converted", org_id=1)
    db.add(q); db.commit(); db.refresh(q); made["quotes"].append(q.id)
    lead = LeadIntake(name="Converted Lead", email=f"c-{uuid.uuid4().hex[:6]}@example.com",
                      source="website", status="quoted", converted_quote_id=q.id,
                      client_id=c.id, org_id=1)
    db.add(lead); db.commit(); db.refresh(lead); made["intakes"].append(lead.id)
    return lead


def test_converted_filter_returns_the_converted_lead(ctx):
    db, c, made = ctx
    lead = _converted_lead(db, c, made)
    ids = [r["id"] for r in get_intakes(status="converted", db=db, org_id=1, limit=200, offset=0)]
    assert lead.id in ids, "the Converted tab did not find a converted lead"


def test_a_converted_lead_no_longer_hides_under_quoted(ctx):
    db, c, made = ctx
    lead = _converted_lead(db, c, made)
    # Its display status is "converted", so the Quoted tab must NOT show it.
    ids = [r["id"] for r in get_intakes(status="quoted", db=db, org_id=1, limit=200, offset=0)]
    assert lead.id not in ids


def test_a_plain_new_lead_still_shows_under_new(ctx):
    db, c, made = ctx
    lead = LeadIntake(name="Fresh Lead", email=f"n-{uuid.uuid4().hex[:6]}@example.com",
                      source="website", status="new", org_id=1)
    db.add(lead); db.commit(); db.refresh(lead); made["intakes"].append(lead.id)
    ids = [r["id"] for r in get_intakes(status="new", db=db, org_id=1, limit=200, offset=0)]
    assert lead.id in ids
