"""Billed, paid out, and what's left (Phase 7).

The routes plan put it plainly: post a job without seeing its margin and the
margin is what you'll lose. Every price the pivot introduced — a posted rate, a
block rate, a Saturday ladder — was typed into a box with no other number
beside it.

The arithmetic is trivial. What these tests defend is the honesty of the
INPUT, because a margin computed from a guess and shown as confidently as one
computed from an invoice is a number somebody prices the next ten jobs against:

  * the source is always reported, and the order is invoice > quote > history;
  * a DRAFT invoice never counts — it can be edited or deleted and has never
    been sent to anybody;
  * no information reports as None, never as zero. "We bill nothing for this"
    and "we don't know" are different answers, and only one implies a 100%
    margin;
  * the what-if `pay` doesn't require writing the price down first — the
    number is only useful before the price is set;
  * a window reports the margin AT THE CEILING, because a ladder set in March
    is what quietly eats a July Saturday.
"""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Invoice, Job, Property, Quote, TurnoverWindow,
)
from modules.auth.router import get_current_user, current_org_id
from services import job_margin
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 9801, 1, "admin", "active", True
    email = "margin-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def m():
    made = {"clients": [], "properties": [], "jobs": [], "invoices": [],
            "quotes": [], "windows": []}
    yield made
    db = SessionLocal()
    db.query(Invoice).filter(Invoice.id.in_(made["invoices"] or [0])).delete(synchronize_session=False)
    db.query(TurnoverWindow).filter(TurnoverWindow.id.in_(made["windows"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.id.in_(made["quotes"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _house(made, org_id=1):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Margin {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); made["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"5 Margin Rd {tag}", address=f"5 Margin Rd {tag}",
                 property_type="residential", org_id=org_id)
    db.add(p); db.commit(); db.refresh(p); made["properties"].append(p.id)
    out = (c.id, p.id); db.close()
    return out


def _job(made, house, *, posted=None, agreed=None, when=None, status="scheduled",
         quote_id=None, job_type="residential", org_id=1):
    cid, pid = house
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type=job_type, title="A clean",
            scheduled_date=when or business_today(), start_time=time(9, 0),
            end_time=time(11, 0), status=status, cleaner_ids=[], org_id=org_id,
            posted_rate=posted, agreed_rate=agreed, quote_id=quote_id)
    db.add(j); db.commit(); db.refresh(j); made["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _invoice(made, house, job_id, total, status="sent", org_id=1):
    cid, _ = house
    db = SessionLocal()
    inv = Invoice(org_id=org_id, client_id=cid, job_id=job_id, total=total, status=status)
    db.add(inv); db.commit(); db.refresh(inv); made["invoices"].append(inv.id)
    iid = inv.id; db.close()
    return iid


def _margin(jid, pay=None):
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    out = job_margin.margin(db, j, 1, pay=pay)
    db.close()
    return out


# ── Where the billed number comes from ──────────────────────────────────────

def test_an_invoice_is_the_best_answer_and_says_so(m):
    house = _house(m)
    jid = _job(m, house, posted=80.0)
    _invoice(m, house, jid, 200.0)

    out = _margin(jid)
    assert out["billed"] == 200.0
    assert out["billed_source"] == "invoice"
    assert out["pay"] == 80.0
    assert out["margin"] == 120.0
    assert out["margin_pct"] == 60.0


def test_a_draft_invoice_is_not_billing(m):
    """A draft can be edited or deleted and has never been sent to anybody."""
    house = _house(m)
    jid = _job(m, house, posted=80.0)
    _invoice(m, house, jid, 999.0, status="draft")

    out = _margin(jid)
    assert out["billed"] is None
    assert out["billed_source"] == "none"
    assert out["margin"] is None


def test_the_accepted_quote_is_used_when_there_is_no_invoice_yet(m):
    house = _house(m)
    cid, _pid = house
    db = SessionLocal()
    q = Quote(org_id=1, client_id=cid, total=150.0, status="accepted",
              quote_number=f"Q-{uuid.uuid4().hex[:6]}")
    db.add(q); db.commit(); db.refresh(q); m["quotes"].append(q.id)
    qid = q.id; db.close()

    jid = _job(m, house, posted=60.0, quote_id=qid)
    out = _margin(jid)
    assert (out["billed"], out["billed_source"]) == (150.0, "quote")
    assert out["margin"] == 90.0


def test_the_invoice_beats_the_quote_when_both_exist(m):
    """What was charged beats what was agreed — they differ, and the charge is
    the one that happened."""
    house = _house(m)
    cid, _ = house
    db = SessionLocal()
    q = Quote(org_id=1, client_id=cid, total=150.0, status="accepted",
              quote_number=f"Q-{uuid.uuid4().hex[:6]}")
    db.add(q); db.commit(); db.refresh(q); m["quotes"].append(q.id)
    qid = q.id; db.close()

    jid = _job(m, house, posted=60.0, quote_id=qid)
    _invoice(m, house, jid, 175.0)
    out = _margin(jid)
    assert (out["billed"], out["billed_source"]) == (175.0, "invoice")


def test_the_houses_own_history_is_the_last_resort_and_is_labelled(m):
    """Averaged over recent invoiced visits at the same property, and named as
    a guess rather than dressed up as a fact."""
    house = _house(m)
    for total, days in ((160.0, 30), (200.0, 60)):
        past = _job(m, house, when=business_today() - timedelta(days=days),
                    status="completed")
        _invoice(m, house, past, total)

    jid = _job(m, house, posted=90.0)
    out = _margin(jid)
    assert out["billed"] == 180.0                # the average of 160 and 200
    assert out["billed_source"] == "history"
    assert out["billed_detail"] == {"visits": 2}
    assert out["margin"] == 90.0


def test_history_ignores_visits_older_than_the_window(m):
    """Pricing changes. A number from eighteen months ago isn't what this house
    bills now."""
    house = _house(m)
    old = _job(m, house, when=business_today() - timedelta(days=400),
               status="completed")
    _invoice(m, house, old, 500.0)

    assert _margin(_job(m, house, posted=90.0))["billed"] is None


def test_nothing_to_go_on_reports_none_and_not_zero(m):
    """"We bill nothing for this" and "we don't know" are different answers,
    and only one of them implies a 100% margin."""
    jid = _job(m, _house(m), posted=80.0)
    out = _margin(jid)
    assert out["billed"] is None
    assert out["margin"] is None and out["margin_pct"] is None
    assert out["pay"] == 80.0, "what it pays is still known and still reported"


# ── What it measures against ────────────────────────────────────────────────

def test_the_agreed_rate_wins_over_the_posted_one(m):
    """Once somebody has been approved, the agreed rate is real money and the
    asking price is history."""
    house = _house(m)
    jid = _job(m, house, posted=80.0, agreed=95.0)
    _invoice(m, house, jid, 200.0)
    out = _margin(jid)
    assert out["pay"] == 95.0 and out["margin"] == 105.0


def test_the_what_if_does_not_require_writing_the_price_down_first(m):
    """The number is only useful BEFORE the price is set. A margin you can only
    see after committing to a rate is one you find out about in the payroll run.
    """
    house = _house(m)
    jid = _job(m, house)                    # no posted rate at all
    _invoice(m, house, jid, 200.0)

    api = _api()
    try:
        base = api.get(f"/api/jobs/{jid}/margin").json()
        assert base["pay"] is None and base["margin"] is None

        whatif = api.get(f"/api/jobs/{jid}/margin?pay=120").json()
        assert whatif["pay"] == 120.0
        assert whatif["margin"] == 80.0 and whatif["margin_pct"] == 40.0

        # And the job itself is untouched by asking.
        assert api.get(f"/api/jobs/{jid}").json()["posted_rate"] is None
    finally:
        _clear()


def test_the_margin_endpoint_is_office_only_and_org_scoped(m):
    other = _house(m, org_id=2)
    jid = _job(m, other, posted=50.0, org_id=2)
    api = _api()          # org 1
    try:
        assert api.get(f"/api/jobs/{jid}/margin").status_code == 404
    finally:
        _clear()


# ── The ladder's ceiling ────────────────────────────────────────────────────

def test_a_window_reports_what_the_top_of_the_ladder_costs(m):
    """A ladder set once in March is what quietly eats a July Saturday, and
    without this the office finds out from the payroll run."""
    when = business_today() + timedelta(days=5)
    house_a, house_b = _house(m), _house(m)
    a = _job(m, house_a, posted=100.0, when=when, job_type="str_turnover")
    b = _job(m, house_b, posted=100.0, when=when, job_type="str_turnover")
    _invoice(m, house_a, a, 150.0)
    _invoice(m, house_b, b, 150.0)

    db = SessionLocal()
    w = TurnoverWindow(org_id=1, service_date=when, status="open", base_rate=100.0,
                       step_pct=20.0, max_steps=3, steps_taken=0)
    db.add(w); db.commit(); db.refresh(w); m["windows"].append(w.id)
    wid = w.id; db.close()

    api = _api()
    try:
        out = api.get(f"/api/turnover-windows/{wid}/margin").json()
        assert out["open_jobs"] == 2
        assert out["billed"] == 300.0
        assert out["pay_now"] == 200.0 and out["margin_now"] == 100.0
        # Three 20% steps: 160 each, 320 total, against 300 billed.
        assert out["pay_at_ceiling"] == 320.0
        assert out["margin_at_ceiling"] == -20.0
        assert out["ceiling_fits"] is False, "the ceiling costs more than the day bills"
    finally:
        _clear()


def test_a_window_says_nothing_rather_than_guessing_when_billing_is_unknown(m):
    """Half a margin is not a margin. If any open job's billing is unknown the
    total would be an undercount, and an undercount looks like good news."""
    when = business_today() + timedelta(days=5)
    house_a, house_b = _house(m), _house(m)
    a = _job(m, house_a, posted=100.0, when=when, job_type="str_turnover")
    _job(m, house_b, posted=100.0, when=when, job_type="str_turnover")
    _invoice(m, house_a, a, 150.0)      # only one of the two is known

    db = SessionLocal()
    w = TurnoverWindow(org_id=1, service_date=when, status="open", base_rate=100.0,
                       step_pct=10.0, max_steps=2, steps_taken=0)
    db.add(w); db.commit(); db.refresh(w); m["windows"].append(w.id)
    wid = w.id; db.close()

    api = _api()
    try:
        out = api.get(f"/api/turnover-windows/{wid}/margin").json()
        assert out["open_jobs"] == 2 and out["billed_known_for"] == 1
        assert out["margin_now"] is None
        assert out["ceiling_fits"] is None
    finally:
        _clear()


def test_a_claimed_turnover_is_not_priced_against_the_ladder(m):
    """It's at its agreed rate and isn't going anywhere."""
    when = business_today() + timedelta(days=5)
    house_a, house_b = _house(m), _house(m)
    a = _job(m, house_a, posted=100.0, when=when, job_type="str_turnover")
    b = _job(m, house_b, agreed=90.0, when=when, job_type="str_turnover")
    _invoice(m, house_a, a, 150.0)
    _invoice(m, house_b, b, 150.0)

    db = SessionLocal()
    j = db.query(Job).filter(Job.id == b).first()
    j.cleaner_ids = ["CT-HAS"]
    w = TurnoverWindow(org_id=1, service_date=when, status="open", base_rate=100.0,
                       step_pct=10.0, max_steps=1, steps_taken=0)
    db.add(w); db.commit(); db.refresh(w); m["windows"].append(w.id)
    wid = w.id; db.close()

    api = _api()
    try:
        out = api.get(f"/api/turnover-windows/{wid}/margin").json()
        assert out["open_jobs"] == 1, "only the unclaimed one rides the ladder"
        assert out["billed"] == 150.0
        assert out["pay_at_ceiling"] == 110.0
        assert out["ceiling_fits"] is True
    finally:
        _clear()
