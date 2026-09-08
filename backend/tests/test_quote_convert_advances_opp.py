"""BB-PIPE-01: booking a job from a quote marks the deal WON.

Every quote→job path flips the quote to "converted", but only the unscheduled
direct-insert path advanced the linked opportunity to "won". The two paths that
run through scheduling.create_job — the operator's SCHEDULED convert and the
public SELF-SCHEDULE page — flipped the quote and returned before any
advance_for_quote, so the opportunity sat in its old stage. The work was booked;
the pipeline still showed the deal as open. This puts create_job at parity: when
it converts a quote, it advances the opportunity too (idempotent, never
regresses).
"""
from datetime import date, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Quote, Job, Opportunity
from modules.scheduling.router import create_job, JobCreate


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Pipe Co", email="pipe@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="H", address="1 Pipe Rd",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    opp = Opportunity(client_id=c.id, title="Pipe deal", stage="quoted")
    db.add(opp); db.commit(); db.refresh(opp)
    q = Quote(client_id=c.id, quote_number="QT-PIPE-1", title="T", service_type="residential",
              items=[{"name": "Clean", "qty": 1, "unit_price": 100}], subtotal=100,
              tax_rate=0, tax=0, discount=0, total=100, status="accepted",
              opportunity_id=opp.id)
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, p, opp, q
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _payload(p, q):
    d = (date.today() + timedelta(days=4)).isoformat()
    return JobCreate(
        client_id=q.client_id, title="Clean", job_type="residential",
        scheduled_date=d, start_time="09:00", end_time="12:00",
        address="1 Pipe Rd", property_id=p.id, quote_id=q.id, cleaner_ids=[],
    )


def test_scheduling_a_quote_advances_its_opportunity_to_won(ctx):
    db, c, p, opp, q = ctx
    assert opp.stage == "quoted"
    create_job(_payload(p, q), db=db)
    db.refresh(opp)
    assert opp.stage == "won", "the deal was booked but the opportunity never advanced"
    db.refresh(q)
    assert q.status == "converted"      # unchanged: the quote still converts


def test_advancing_is_idempotent_on_a_second_schedule(ctx):
    # Second create_job for the same quote returns the existing job and must not
    # regress or error; the opp stays won.
    db, c, p, opp, q = ctx
    create_job(_payload(p, q), db=db)
    create_job(_payload(p, q), db=db)
    db.refresh(opp)
    assert opp.stage == "won"
