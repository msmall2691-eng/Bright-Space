"""A price on every job — what we CHARGE, kept apart from what we PAY.

THE GAP. `Job` carried `posted_rate` and `agreed_rate` (what a subcontractor
is offered, and what they settled for) and nothing for what the customer is
billed. `services/job_margin.py` inferred the billed amount from an invoice
raised later, the quote it came from, or what the house usually bills — never
from somebody stating the price when the work was booked. Two symptoms, both
visible from the owner's phone: "invoice this job" produced a $0.00 invoice
for anything without a quote (every rental turnover), and every open job on
the crew's screen read "No price set".

What is pinned here is mostly the arithmetic of NOT getting it wrong:

  * the two numbers never merge. A price is not a rate;
  * NULL is "we don't know", 0 is "this bills nothing", and they are not the
    same answer — only one of them implies a 100% margin;
  * inheritance is a SEED, not a link. A price copied onto a visit at creation
    must never move afterwards because the house default changed, and moving
    a visit must not silently reprice it.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, Quote, RecurringSchedule
from modules.auth.router import current_org_id, get_current_user
from services.job_margin import billed_amount
from services.job_pricing import resolve_new_job_price
from utils.dates import business_today


class _Office:
    id, org_id, role, status, active = 9991, 1, "admin", "active", True
    email, full_name, cleaner_id = "office-price@example.com", "The Office", None


def _as(user=_Office()):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": [], "quotes": [], "scheds": []}
    yield m
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(
        RecurringSchedule.id.in_(m["scheds"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(m["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _house(m, *, default_price=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Price {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Cove Rd", city="Camden", state="ME",
                 default_price=default_price)
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    out = (c.id, p.id); db.close()
    return out


def _create_job(m, client_id, property_id, **extra):
    body = {"client_id": client_id, "property_id": property_id,
            "title": "Clean", "scheduled_date": str(business_today() + timedelta(days=3)),
            "start_time": "09:00", "end_time": "12:00"}
    body.update(extra)
    r = _as().post("/api/jobs", json=body)
    assert r.status_code in (200, 201), r.text
    jid = r.json()["id"]
    m["jobs"].append(jid)
    return jid


def _job(jid):
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    price, rate = j.price, j.posted_rate
    db.close()
    return price, rate


# ── the thing itself ───────────────────────────────────────────────────────

def test_a_job_takes_the_price_you_type(made):
    cid, pid = _house(made, default_price=150.0)
    assert _job(_create_job(made, cid, pid, price=225.0))[0] == 225.0


def test_a_job_inherits_the_house_price_when_you_type_nothing(made):
    """The whole point: work booked without anyone thinking about money still
    arrives priced."""
    cid, pid = _house(made, default_price=150.0)
    assert _job(_create_job(made, cid, pid))[0] == 150.0


def test_a_house_with_no_usual_price_leaves_the_job_unpriced_not_free(made):
    cid, pid = _house(made)
    assert _job(_create_job(made, cid, pid))[0] is None


def test_the_asking_rate_for_crew_is_settable_at_creation(made):
    """It was only reachable from JobDetail after the fact, which is why every
    open job on the crew's screen read "No price set". An undeclared field is
    silently dropped by pydantic, so this asserts it actually lands."""
    cid, pid = _house(made)
    assert _job(_create_job(made, cid, pid, posted_rate=90.0))[1] == 90.0


def test_the_two_numbers_do_not_touch(made):
    cid, pid = _house(made, default_price=150.0)
    price, rate = _job(_create_job(made, cid, pid, price=200.0, posted_rate=90.0))
    assert (price, rate) == (200.0, 90.0)


def test_you_can_change_a_price_after_the_fact(made):
    cid, pid = _house(made, default_price=150.0)
    jid = _create_job(made, cid, pid)
    assert _as().patch(f"/api/jobs/{jid}", json={"price": 175.0}).status_code == 200
    assert _job(jid)[0] == 175.0


def test_a_recurring_series_prices_every_visit_it_generates(made):
    """The case nobody types a price for, once per occurrence, forever."""
    cid, pid = _house(made, default_price=150.0)
    r = _as().post("/api/recurring", json={
        "client_id": cid, "property_id": pid, "title": "Weekly clean",
        "job_type": "residential", "address": "12 Cove Rd, Camden ME",
        "frequency": "weekly", "interval_weeks": 1, "days_of_week": [2],
        "start_time": "09:00", "end_time": "12:00", "generate_weeks_ahead": 3,
        "price": 185.0,
    })
    assert r.status_code in (200, 201), r.text
    sched_id = r.json()["id"]
    made["scheds"].append(sched_id)
    db = SessionLocal()
    jobs = db.query(Job).filter(Job.recurring_schedule_id == sched_id).all()
    made["jobs"].extend(j.id for j in jobs)
    prices = {j.price for j in jobs}
    db.close()
    assert jobs, "the series generated nothing"
    assert prices == {185.0}, f"occurrences priced {prices}"


# ── the distinctions that must not blur ────────────────────────────────────

def test_null_is_not_zero():
    """"We don't know what this bills" and "this bills nothing" are different
    answers, and only one of them means a 100% margin."""
    assert resolve_new_job_price() is None
    assert resolve_new_job_price(explicit=0) == 0.0


def test_a_typed_price_outranks_the_quote_and_the_house():
    class Q: total = 300.0
    class P: default_price = 150.0
    assert resolve_new_job_price(explicit=225.0, quote=Q(), prop=P()) == 225.0
    assert resolve_new_job_price(quote=Q(), prop=P()) == 300.0
    assert resolve_new_job_price(prop=P()) == 150.0


def test_a_zero_total_quote_falls_through_to_the_house():
    """A quote totalling nothing is a draft somebody never filled in, not a
    free job — stamping its zero would look like a decision."""
    class Q: total = 0.0
    class P: default_price = 150.0
    assert resolve_new_job_price(quote=Q(), prop=P()) == 150.0


def test_changing_the_house_price_does_not_move_a_booked_visit(made):
    """A seed, not a link. Some of these visits have been invoiced, and a
    price moving under an invoice already sent is found by the customer
    first."""
    cid, pid = _house(made, default_price=150.0)
    jid = _create_job(made, cid, pid)
    assert _as().patch(f"/api/properties/{pid}", json={"default_price": 400.0}).status_code == 200
    assert _job(jid)[0] == 150.0


def test_moving_a_visit_does_not_reprice_it(made):
    """A rescheduled occurrence is a REPLACEMENT row, so its price has to be
    carried across. Re-seeding it from the series would silently reprice work
    the customer already agreed to whenever the series price had changed since
    — and the only person who would notice is the one paying the invoice."""
    cid, pid = _house(made, default_price=150.0)
    r = _as().post("/api/recurring", json={
        "client_id": cid, "property_id": pid, "title": "Weekly clean",
        "job_type": "residential", "address": "12 Cove Rd, Camden ME",
        "frequency": "weekly", "interval_weeks": 1, "days_of_week": [2],
        "start_time": "09:00", "end_time": "12:00", "generate_weeks_ahead": 4,
        "price": 185.0,
    })
    assert r.status_code in (200, 201), r.text
    sched_id = r.json()["id"]
    made["scheds"].append(sched_id)

    db = SessionLocal()
    occ = (db.query(Job).filter(Job.recurring_schedule_id == sched_id)
           .order_by(Job.scheduled_date).first())
    assert occ is not None
    made["jobs"].append(occ.id)
    # This visit was negotiated down after it was generated.
    occ.price = 120.0
    db.commit()
    occ_date, occ_id = str(occ.scheduled_date), occ.id
    db.close()

    # ...and the series price rises afterwards.
    assert _as().patch(f"/api/recurring/{sched_id}",
                       json={"price": 260.0}).status_code == 200

    moved_to = str(business_today() + timedelta(days=30))
    r = _as().post(f"/api/recurring/{sched_id}/reschedule", json={
        "exception_date": occ_date, "rescheduled_date": moved_to,
        "rescheduled_start_time": "13:00", "rescheduled_end_time": "16:00",
        "allow_conflicts": True,
    })
    assert r.status_code in (200, 201), r.text

    db = SessionLocal()
    moved = (db.query(Job).filter(Job.recurring_schedule_id == sched_id,
                                  Job.scheduled_date == business_today() + timedelta(days=30))
             .first())
    if moved is not None:
        made["jobs"].append(moved.id)
    price = moved.price if moved is not None else None
    db.close()
    assert moved is not None, "the move produced no visit"
    assert price == 120.0, f"moving the visit repriced it to {price}"


# ── what the margin believes ───────────────────────────────────────────────

def test_a_price_on_the_job_outranks_every_guess(made):
    """job_margin inferred from a quote or from history. A number somebody
    typed for THIS visit beats both, and says so in `source`."""
    cid, pid = _house(made)
    jid = _create_job(made, cid, pid, price=210.0)
    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    got = billed_amount(db, job, 1)
    db.close()
    assert got["amount"] == 210.0
    assert got["source"] == "job"


def test_a_job_billed_nothing_reports_zero_not_unknown(made):
    """A make-good or warranty re-clean is a real answer, and the one place
    `amount: 0.0` may legitimately come back."""
    cid, pid = _house(made)
    jid = _create_job(made, cid, pid, price=0)
    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    got = billed_amount(db, job, 1)
    db.close()
    assert got["amount"] == 0.0 and got["source"] == "job"


def test_an_unpriced_job_still_falls_back_to_what_it_always_did(made):
    """Existing jobs were not backfilled, so the invoice/quote/history chain
    has to keep working underneath the new source."""
    cid, pid = _house(made)
    jid = _create_job(made, cid, pid)
    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    got = billed_amount(db, job, 1)
    db.close()
    assert got["amount"] is None and got["source"] == "none"
