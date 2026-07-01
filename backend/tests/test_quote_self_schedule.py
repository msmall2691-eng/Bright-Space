"""PR3 — customer self-scheduling on accept + auto-convert.

Covers the availability sweep (Sundays closed, all-cleaners-off days blocked),
the schedule endpoint (accept + dated job + convert, idempotent), and
auto-convert-on-accept (only when the quote has a property).
"""
from datetime import date, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Quote, Job, CleanerTimeOff
from modules.quoting.router import (
    public_quote_availability, public_schedule_quote, public_accept_quote,
    PublicScheduleRequest, PublicAcceptRequest,
)


def _next_weekday(base=None):
    """A near-future Mon–Sat date (availability excludes Sundays)."""
    d = (base or date.today()) + timedelta(days=2)
    while d.weekday() == 6:
        d += timedelta(days=1)
    return d


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Sched Test", email="sched@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_quote(db, c, token, status="sent", property_id=None):
    q = Quote(client_id=c.id, quote_number=f"QT-SS-{token[:5]}", title="T",
              service_type="residential", address="1 St", notes="", items=[],
              subtotal=100, tax_rate=0, tax=0, discount=0, total=100, status=status,
              public_token=token, property_id=property_id,
              valid_until=date.today() + timedelta(days=30))
    db.add(q); db.commit(); db.refresh(q)
    return q


# ---- availability ----------------------------------------------------------

def test_availability_offers_business_days_no_sunday(ctx):
    db, c = ctx
    _mk_quote(db, c, "availtok01")
    out = public_quote_availability("availtok01", db=db)
    assert {w["key"] for w in out["windows"]} == {"morning", "afternoon"}
    assert out["dates"] and all(date.fromisoformat(x["date"]).weekday() != 6 for x in out["dates"])
    # With no cleaner roster on record, every offered business day is available.
    assert all(x["available"] for x in out["dates"])


def test_availability_blocks_day_when_all_cleaners_off(ctx):
    db, c = ctx
    # One cleaner in the roster (derived from a real assignment)...
    p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    d = _next_weekday()
    job = Job(client_id=c.id, property_id=p.id, job_type="residential", title="J",
              scheduled_date=d, start_time=None, end_time=None, status="scheduled",
              cleaner_ids=["cleaner-1"])
    db.add(job); db.commit()
    # ...who is off on day d → that day is unavailable.
    db.add(CleanerTimeOff(cleaner_id="cleaner-1", start_date=d, end_date=d, reason="vacation"))
    db.commit()
    _mk_quote(db, c, "availtok02")
    out = public_quote_availability("availtok02", db=db)
    by_date = {x["date"]: x["available"] for x in out["dates"]}
    assert by_date.get(d.isoformat()) is False


# ---- schedule --------------------------------------------------------------

def test_schedule_accepts_dates_and_converts(ctx):
    db, c = ctx
    q = _mk_quote(db, c, "schedtok01")
    d = _next_weekday()
    out = public_schedule_quote("schedtok01", PublicScheduleRequest(
        date=d.isoformat(), window="morning", name="Megan", email="megan@example.com"), db=db)
    assert out["scheduled"] is True and out["window"] == "morning"
    db.refresh(q)
    assert q.status == "converted"
    assert q.accepted_by_name == "Megan"
    job = db.query(Job).filter(Job.quote_id == q.id).one()
    assert str(job.scheduled_date) == d.isoformat()
    assert job.id == out["job_id"]


def test_schedule_is_idempotent_no_duplicate_job(ctx):
    db, c = ctx
    q = _mk_quote(db, c, "schedtok02")
    d1, d2 = _next_weekday(), _next_weekday(date.today() + timedelta(days=5))
    first = public_schedule_quote("schedtok02", PublicScheduleRequest(date=d1.isoformat(), window="morning"), db=db)
    second = public_schedule_quote("schedtok02", PublicScheduleRequest(date=d2.isoformat(), window="afternoon"), db=db)
    assert db.query(Job).filter(Job.quote_id == q.id).count() == 1   # re-dated, not duplicated
    assert second["job_id"] == first["job_id"]
    job = db.query(Job).filter(Job.quote_id == q.id).one()
    assert str(job.scheduled_date) == d2.isoformat()                  # re-dated to the new pick


def test_schedule_rejects_past_date(ctx):
    db, c = ctx
    _mk_quote(db, c, "schedtok03")
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        public_schedule_quote("schedtok03", PublicScheduleRequest(
            date=(date.today() - timedelta(days=1)).isoformat()), db=db)
    assert exc.value.status_code == 400


# ---- auto-convert on accept ------------------------------------------------

def test_accept_auto_converts_when_property_present(ctx):
    db, c = ctx
    p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    q = _mk_quote(db, c, "accepttok1", property_id=p.id)
    public_accept_quote("accepttok1", PublicAcceptRequest(name="Megan"), db=db)
    db.refresh(q)
    assert q.status == "converted"
    assert db.query(Job).filter(Job.quote_id == q.id).count() == 1


def test_accept_without_property_stays_accepted(ctx):
    db, c = ctx
    q = _mk_quote(db, c, "accepttok2")   # no property_id
    public_accept_quote("accepttok2", PublicAcceptRequest(), db=db)
    db.refresh(q)
    assert q.status == "accepted"
    assert db.query(Job).filter(Job.quote_id == q.id).count() == 0


def test_reaccept_does_not_revert_converted(ctx):
    db, c = ctx
    p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    q = _mk_quote(db, c, "accepttok3", property_id=p.id)
    public_accept_quote("accepttok3", PublicAcceptRequest(), db=db)
    out = public_accept_quote("accepttok3", PublicAcceptRequest(), db=db)  # double-tap
    assert out["status"] == "converted"
    db.refresh(q)
    assert q.status == "converted"
    assert db.query(Job).filter(Job.quote_id == q.id).count() == 1   # no second job
