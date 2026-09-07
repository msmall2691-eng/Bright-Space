"""The two numbers that say whether this business is working.

Labour as a share of revenue, and whether customers come back. Both added
after a research pass on how managed home-services businesses actually fail,
and the DEFINITIONS are the part worth pinning — the arithmetic is trivial and
the choices underneath it are not:

  * revenue is INVOICED, not collected. An invoice sent in March for March's
    work belongs to March whether the cheque clears in May. Otherwise the
    ratio swings on how promptly customers pay, which says nothing about how
    efficiently the work was staffed.
  * labour is `earned_on`, which the payout ledger already defines as when the
    work happened. The two therefore line up on the month of the cleaning,
    which is the only basis on which their ratio means anything.
  * the repeat window is CLOSED. Jobs completed last week cannot have had 60
    days to produce a return visit, so counting them would read as "didn't
    come back" and drag the number down by exactly the amount of recent
    business — the most flattering possible error inverted into the most
    discouraging one.
  * a ratio with no denominator is null, never zero. A month with no invoices
    is not a month with 0% labour cost, and coverage is reported so a
    percentage computed off half the jobs can be recognised as such.

Homejoy raised $40M and died with 15-20% of customers rebooking within a
month. Molly Maid franchisees run 91%. Nothing in BrightBase said it out loud.
"""
import uuid
from datetime import date, datetime, time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Invoice, Job, Property, SubPayout, User
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today


class _Office:
    id, org_id, role, status, active = 9981, 1, "admin", "active", True
    email, full_name, cleaner_id = "health@example.com", "The Office", None


class _Viewer(_Office):
    id, role = 9982, "viewer"


def _api(user=None):
    app.dependency_overrides[get_current_user] = lambda: (user or _Office())
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": [], "invoices": [], "payouts": [], "users": []}
    yield m
    db = SessionLocal()
    db.query(Invoice).filter(Invoice.id.in_(m["invoices"] or [0])).delete(synchronize_session=False)
    db.query(SubPayout).filter(SubPayout.id.in_(m["payouts"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _client(m, name=None):
    db = SessionLocal()
    c = Client(name=name or f"H {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name="House", address="1 Health Rd",
                 city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    ids = (c.id, p.id); db.close()
    return ids


def _job(m, client_id, prop_id, when, *, status="completed", recurring_id=None):
    db = SessionLocal()
    j = Job(client_id=client_id, property_id=prop_id, org_id=1, title="Clean",
            scheduled_date=when, start_time=dtime(9, 0), end_time=dtime(12, 0),
            status=status, cleaner_ids=[], recurring_schedule_id=recurring_id)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _invoice(m, client_id, job_id, total, created, *, status="sent"):
    db = SessionLocal()
    inv = Invoice(client_id=client_id, job_id=job_id, org_id=1, total=total,
                  status=status, invoice_number=f"H-{uuid.uuid4().hex[:8]}",
                  created_at=created)
    db.add(inv); db.commit(); db.refresh(inv); m["invoices"].append(inv.id)
    db.close()


def _payout(m, job_id, amount, earned, *, status="paid"):
    db = SessionLocal()
    u = User(org_id=1, email=f"sub-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="A Sub", cleaner_id=f"CT-{uuid.uuid4().hex[:4]}",
             password_hash="x", active=True, status="active")
    db.add(u); db.commit(); db.refresh(u); m["users"].append(u.id)
    p = SubPayout(org_id=1, user_id=u.id, cleaner_id=u.cleaner_id, job_id=job_id,
                  amount=amount, status=status, earned_on=earned)
    db.add(p); db.commit(); db.refresh(p); m["payouts"].append(p.id)
    db.close()


def _get(months=6, user=None):
    r = _api(user).get("/api/dashboard/operating-health", params={"months": months})
    assert r.status_code == 200, r.text
    return r.json()


def _month(payload, when):
    key = when.isoformat()[:7]
    return next(m for m in payload["labour"]["months"] if m["month"] == key)


# ── labour share ───────────────────────────────────────────────────────────

def test_labour_share_is_labour_over_revenue_for_the_month_the_work_happened(made):
    c, p = _client(made)
    today = business_today()
    job = _job(made, c, p, today)
    _invoice(made, c, job, 1000.0, datetime.combine(today, dtime(12, 0)))
    _payout(made, job, 420.0, today)

    row = _month(_get(), today)
    assert row["revenue"] == 1000.0 and row["labour"] == 420.0
    assert row["labour_pct"] == 42.0


def test_when_the_cheque_clears_does_not_move_the_ratio(made):
    """Revenue is invoiced, not collected. The control that keeps this an
    OPERATING ratio rather than a cash-flow one."""
    c, p = _client(made)
    today = business_today()
    job = _job(made, c, p, today)
    # Invoiced today, paid (as far as this ratio is concerned) never.
    _invoice(made, c, job, 1000.0, datetime.combine(today, dtime(12, 0)), status="overdue")
    _payout(made, job, 420.0, today)
    assert _month(_get(), today)["labour_pct"] == 42.0


def test_a_draft_invoice_is_not_revenue(made):
    c, p = _client(made)
    today = business_today()
    job = _job(made, c, p, today)
    _invoice(made, c, job, 5000.0, datetime.combine(today, dtime(12, 0)), status="draft")
    _payout(made, job, 420.0, today)
    row = _month(_get(), today)
    assert row["revenue"] == 0.0
    # And with no denominator the answer is "we don't know", not 0%.
    assert row["labour_pct"] is None


def test_a_void_payout_is_not_labour(made):
    c, p = _client(made)
    today = business_today()
    job = _job(made, c, p, today)
    _invoice(made, c, job, 1000.0, datetime.combine(today, dtime(12, 0)))
    _payout(made, job, 420.0, today, status="void")
    assert _month(_get(), today)["labour"] == 0.0


def test_coverage_says_how_much_of_the_work_carries_an_invoice(made):
    """The ratio is only as honest as this. Half the cleanings uninvoiced means
    a half-size denominator and a percentage about double the truth — so the
    payload reports it rather than quietly being wrong."""
    before = _get()["labour"]
    c, p = _client(made)
    today = business_today()
    invoiced = _job(made, c, p, today)
    _job(made, c, p, today)          # completed, never invoiced
    _invoice(made, c, invoiced, 1000.0, datetime.combine(today, dtime(12, 0)))

    # DELTAS, not absolutes. `jobs_completed` counts every completed job in
    # the period, so the moment a neighbouring test also finishes one this
    # read 4 rather than 2 — the assertion was about the whole database, not
    # about the two jobs this test created. What it is actually pinning is
    # that an uninvoiced cleaning still lands in the denominator.
    lab = _get()["labour"]
    assert lab["jobs_completed"] - before["jobs_completed"] == 2
    assert lab["jobs_invoiced"] - before["jobs_invoiced"] == 1
    # ...and the coverage percentage is that ratio, computed from the same
    # two totals rather than assumed to be a clean 50%.
    expected = round(lab["jobs_invoiced"] / lab["jobs_completed"] * 100, 1)
    assert lab["coverage_pct"] == expected


def test_the_benchmark_travels_with_the_number(made):
    """45% good / 55% trouble is the published band for residential cleaning.
    A percentage with nothing to compare it against is trivia."""
    _client(made)
    assert _get()["labour"]["benchmark"] == {"good_max": 45, "warn_max": 55}


# ── do they come back ──────────────────────────────────────────────────────

def test_a_customer_who_booked_again_inside_the_window_counts_as_returned(made):
    c, p = _client(made)
    today = business_today()
    first = today - timedelta(days=120)
    _job(made, c, p, first)
    _job(made, c, p, first + timedelta(days=30))

    rep = _get()["repeat"]
    # The second job is itself inside the closed window and had no follow-up,
    # so one of the two counts as returned.
    assert rep["considered"] == 2 and rep["returned"] == 1
    assert rep["rate_pct"] == 50.0


def test_a_gap_longer_than_the_window_is_not_a_return(made):
    c, p = _client(made)
    today = business_today()
    first = today - timedelta(days=200)
    _job(made, c, p, first)
    _job(made, c, p, first + timedelta(days=90))     # 90 days later — too late

    rep = _get()["repeat"]
    assert rep["returned"] == 0 and rep["rate_pct"] == 0.0


def test_last_weeks_cleanings_are_not_counted_as_never_came_back(made):
    """The window is CLOSED. A job finished on Tuesday has not had 60 days to
    produce a second visit, and counting it as a failure would drag the number
    down by exactly the amount of recent business."""
    c, p = _client(made)
    today = business_today()
    _job(made, c, p, today - timedelta(days=3))
    assert _get()["repeat"]["considered"] == 0


def test_recurring_customers_are_split_out(made):
    """A 95% rate that is entirely recurring says the schedule generator works,
    not that the cleaning is winning anyone over. The number worth steering by
    is whether people NOT on a standing schedule choose to come back."""
    today = business_today()
    first = today - timedelta(days=120)

    rc, rp = _client(made)
    _job(made, rc, rp, first, recurring_id=4242)
    _job(made, rc, rp, first + timedelta(days=14), recurring_id=4242)

    oc, op = _client(made)
    _job(made, oc, op, first)                       # one-off, never came back

    rep = _get()["repeat"]
    assert rep["considered"] == 3 and rep["returned"] == 1
    assert rep["one_off_considered"] == 1 and rep["one_off_returned"] == 0
    assert rep["one_off_rate_pct"] == 0.0


def test_no_history_reports_no_rate_rather_than_zero_percent(made):
    """A brand-new book is not a book with 0% retention."""
    _client(made)
    rep = _get()["repeat"]
    assert rep["considered"] == 0 and rep["rate_pct"] is None


# ── who may see it ─────────────────────────────────────────────────────────

def test_a_viewer_cannot_see_the_cost_side(made):
    r = _api(_Viewer()).get("/api/dashboard/operating-health")
    assert r.status_code == 403, r.text
