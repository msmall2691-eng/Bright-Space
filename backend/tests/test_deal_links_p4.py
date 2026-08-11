"""P4 PR-2: the deal-spine link fixes.

Two things:
  1. A recurring schedule created from a quote inherits the quote's
     opportunity_id and advances the deal to "won".
  2. reconcile_lead_quote_links() makes the two lead↔quote links agree in
     both directions, idempotently.
"""
from datetime import datetime

import pytest

from database.db import SessionLocal
from database.models import (
    Client, Quote, LeadIntake, Opportunity, RecurringSchedule,
)
from modules.recurring.router import create_schedule, ScheduleCreate
from modules.auth.router import resolve_org_id
from utils.opportunity_helper import reconcile_lead_quote_links


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


def _client(db, **kw):
    c = Client(name=kw.pop("name", "Recur Co"), status="active", **kw)
    db.add(c); db.commit(); db.refresh(c)
    return c


def test_recurring_from_quote_inherits_opportunity_and_wins(db):
    client = _client(db, email="recur@example.com")
    opp = Opportunity(client_id=client.id, stage="quoted", title="Deal", amount=400)
    db.add(opp); db.commit(); db.refresh(opp)
    quote = Quote(
        client_id=client.id, opportunity_id=opp.id, quote_number=f"QT-T-{client.id}",
        status="accepted", items=[], subtotal=400, total=400, tax=0, tax_rate=0,
    )
    db.add(quote); db.commit(); db.refresh(quote)

    out = create_schedule(
        ScheduleCreate(
            client_id=client.id, job_type="residential", title="Biweekly",
            address="1 Loop Rd", frequency="biweekly", interval_weeks=2,
            days_of_week=[0], start_time="09:00", end_time="11:00",
            quote_id=quote.id,
        ),
        db=db, org_id=resolve_org_id(None, db),
    )
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == out["id"]).first()
    assert sched.opportunity_id == opp.id
    db.refresh(quote); db.refresh(opp)
    assert quote.status == "converted"       # existing behavior preserved
    assert opp.stage == "won"                # deal advanced

    # cleanup
    db.query(RecurringSchedule).filter(RecurringSchedule.id == sched.id).delete()
    db.query(Quote).filter(Quote.id == quote.id).delete()
    db.query(Opportunity).filter(Opportunity.id == opp.id).delete()
    from database.models import Job
    db.query(Job).filter(Job.client_id == client.id).delete()
    db.query(Client).filter(Client.id == client.id).delete()
    db.commit()


def test_ad_hoc_recurring_has_no_opportunity(db):
    client = _client(db, email="adhoc@example.com")
    out = create_schedule(
        ScheduleCreate(
            client_id=client.id, job_type="residential", title="Weekly",
            address="2 Loop Rd", frequency="weekly", days_of_week=[1],
            start_time="10:00", end_time="12:00",
        ),
        db=db, org_id=resolve_org_id(None, db),
    )
    sched = db.query(RecurringSchedule).filter(RecurringSchedule.id == out["id"]).first()
    assert sched.opportunity_id is None
    db.query(RecurringSchedule).filter(RecurringSchedule.id == sched.id).delete()
    from database.models import Job
    db.query(Job).filter(Job.client_id == client.id).delete()
    db.query(Client).filter(Client.id == client.id).delete()
    db.commit()


def test_reconcile_fills_both_directions_and_is_idempotent(db):
    client = _client(db, email="recon@example.com")
    # Case A: quote points at lead, lead's converted_quote_id is NULL.
    leadA = LeadIntake(name="A", status="new")
    db.add(leadA); db.commit(); db.refresh(leadA)
    qA = Quote(client_id=client.id, intake_id=leadA.id, quote_number=f"QT-A-{client.id}",
               status="draft", items=[], subtotal=0, total=0, tax=0, tax_rate=0)
    db.add(qA); db.commit(); db.refresh(qA)

    # Case B: lead points at quote, quote's intake_id is NULL.
    qB = Quote(client_id=client.id, quote_number=f"QT-B-{client.id}",
               status="draft", items=[], subtotal=0, total=0, tax=0, tax_rate=0)
    db.add(qB); db.commit(); db.refresh(qB)
    leadB = LeadIntake(name="B", status="quoted", converted_quote_id=qB.id)
    db.add(leadB); db.commit(); db.refresh(leadB)

    report = reconcile_lead_quote_links(db)
    db.commit()
    db.refresh(leadA); db.refresh(qB)
    assert leadA.converted_quote_id == qA.id   # filled from the quote side
    assert qB.intake_id == leadB.id            # filled from the lead side

    # Idempotent: a second pass changes nothing.
    before = (leadA.converted_quote_id, qB.intake_id)
    reconcile_lead_quote_links(db); db.commit()
    db.refresh(leadA); db.refresh(qB)
    assert (leadA.converted_quote_id, qB.intake_id) == before
    assert "leads_linked" in report and "quotes_linked" in report

    # cleanup
    db.query(Quote).filter(Quote.id.in_([qA.id, qB.id])).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id.in_([leadA.id, leadB.id])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete()
    db.commit()


def test_earliest_quote_wins_when_a_lead_has_several(db):
    client = _client(db, email="multi@example.com")
    lead = LeadIntake(name="Multi", status="new")
    db.add(lead); db.commit(); db.refresh(lead)
    q1 = Quote(client_id=client.id, intake_id=lead.id, quote_number=f"QT-1-{client.id}",
               status="draft", items=[], subtotal=0, total=0, tax=0, tax_rate=0)
    db.add(q1); db.commit(); db.refresh(q1)
    q2 = Quote(client_id=client.id, intake_id=lead.id, quote_number=f"QT-2-{client.id}",
               status="draft", items=[], subtotal=0, total=0, tax=0, tax_rate=0)
    db.add(q2); db.commit(); db.refresh(q2)

    reconcile_lead_quote_links(db); db.commit()
    db.refresh(lead)
    assert lead.converted_quote_id == min(q1.id, q2.id)

    db.query(Quote).filter(Quote.id.in_([q1.id, q2.id])).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id == lead.id).delete()
    db.query(Client).filter(Client.id == client.id).delete()
    db.commit()
