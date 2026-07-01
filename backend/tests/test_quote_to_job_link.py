"""P1-A: scheduling a job from an accepted quote must link the job back and
convert the quote — idempotently, so a second attempt can't create a duplicate.

Regression for jobs landing with quote_id=null and quotes stuck at "accepted"
(the revenue→job link from docs/audit-2026-04-23.md, reappearing on the
"Set up schedule" wizard path which posts to POST /api/jobs).
"""
from datetime import date, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Quote, Job
from modules.scheduling.router import create_job, JobCreate


@pytest.fixture
def quote_ctx():
    db = SessionLocal()
    c = Client(name="Link Test", email="link@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    q = Quote(client_id=c.id, quote_number="QT-LINK-1", title="T", service_type="residential",
              address="1 St", notes="", items=[], subtotal=100, tax_rate=0, tax=0,
              discount=0, total=100, status="accepted")
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, p, q
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _job_payload(p, q):
    d = (date.today() + timedelta(days=5)).isoformat()
    return JobCreate(
        client_id=q.client_id, title="Clean", job_type="residential",
        scheduled_date=d, start_time="09:00", end_time="12:00",
        address="1 St", property_id=p.id, quote_id=q.id, cleaner_ids=[],
    )


def _jobs_for(db, q):
    return {j.id for j in db.query(Job).filter(Job.quote_id == q.id)}


def test_scheduling_accepted_quote_links_and_converts(quote_ctx):
    db, c, p, q = quote_ctx
    before = _jobs_for(db, q)
    out = create_job(_job_payload(p, q), db=db)
    assert out["quote_id"] == q.id              # revenue→job link kept
    assert _jobs_for(db, q) - before == {out["id"]}  # exactly one new linked job
    db.refresh(q)
    assert q.status == "converted"
    assert q.converted_at is not None


def test_second_schedule_attempt_is_idempotent(quote_ctx):
    db, c, p, q = quote_ctx
    create_job(_job_payload(p, q), db=db)
    after_first = _jobs_for(db, q)
    # A second "Set up schedule" click (quote now converted) must not duplicate.
    second = create_job(_job_payload(p, q), db=db)
    assert _jobs_for(db, q) == after_first      # no new job created
    assert second["id"] in after_first          # returned an existing linked job
