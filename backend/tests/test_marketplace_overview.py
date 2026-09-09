"""The Marketplace hub's one read.

The bench shipped as five surfaces bolted onto other pages and could not be
found. This endpoint gathers them. What is pinned:

  * a job somebody has ALREADY been given never shows as open. It is the one
    error on this page that would cost real money — two people turning up, or
    the office re-posting work that is spoken for;
  * `due` and `sent` are both still owed. The manual rail marks a payout sent
    when the paperwork is produced, not when money lands, so collapsing them
    into "paid" is exactly the error the ledger exists to prevent;
  * people waiting on an answer are counted and surfaced, because they are the
    only ones on this page blocked on the office rather than the reverse;
  * it is org-scoped and office-only. The bench, what is owed, and who is
    still un-vetted are internal operating facts.
"""
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (Client, Job, JobClaimRequest, Property,
                             SubApplication, SubPayout, User)
from modules.auth.router import current_org_id, get_current_user
from services import marketplace_overview

TODAY = date(2026, 3, 10)


class _Admin:
    id, org_id, role, status, active = 9501, 1, "admin", "active", True
    email, full_name, cleaner_id = "mk-admin@example.com", "The Office", None


class _Cleaner:
    id, org_id, role, status, active = 9502, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "mk-sub@example.com", "A Sub", "CT-MK"


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "users": [], "apps": []}
    yield ids
    db = SessionLocal()
    db.query(JobClaimRequest).filter(
        JobClaimRequest.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(SubPayout).filter(
        SubPayout.user_id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.query(SubApplication).filter(
        SubApplication.id.in_(ids["apps"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(
        Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(
        Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_job(ids, *, org_id=1, open_for_claims=True, agreed_cleaner_id=None,
            when=None, status="scheduled", posted_rate=140.0, city="Rockport"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Hub {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"1 Hub {tag}", address=f"1 Hub {tag}",
                 city=city, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title=f"Clean {tag}", scheduled_date=when or (TODAY + timedelta(days=2)),
            status=status, cleaner_ids=[], org_id=org_id,
            open_for_claims=open_for_claims, posted_rate=posted_rate,
            agreed_cleaner_id=agreed_cleaner_id)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _ask(ids, job_id, *, cleaner_id="CT-MK", status="pending", org_id=1):
    db = SessionLocal()
    r = JobClaimRequest(org_id=org_id, job_id=job_id, cleaner_id=cleaner_id,
                        status=status)
    db.add(r); db.commit(); db.close()


def _mk_payout(ids, *, amount, status, org_id=1, earned_on=None):
    db = SessionLocal()
    u = User(email=f"p-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="Payee", org_id=org_id, active=True, status="active",
             cleaner_id=f"CT-{uuid.uuid4().hex[:6]}")
    db.add(u); db.commit(); db.refresh(u); ids["users"].append(u.id)
    db.add(SubPayout(org_id=org_id, user_id=u.id, cleaner_id=u.cleaner_id,
                     amount=amount, status=status,
                     earned_on=earned_on or TODAY))
    db.commit(); db.close()


def _build(org_id=1):
    db = SessionLocal()
    try:
        return marketplace_overview.build(db, org_id, today=TODAY)
    finally:
        db.close()


def _api(user=None):
    app.dependency_overrides[get_current_user] = lambda: (user or _Admin())
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


# ── Waiting on you, triageable at a glance (BB-MKT-01) ──────────────────────
#
# "2 people asked for X" made the office open every job to see who and at what
# price. The waiting rows now carry the askers so the page can be triaged.

def test_waiting_jobs_carry_who_asked_and_at_what_price(ids):
    jid = _mk_job(ids, posted_rate=100.0)
    db = SessionLocal()
    u = User(email="amy-mk@example.com", role="cleaner", full_name="Amy Stone",
             org_id=1, active=True, status="active", cleaner_id="CT-AMY")
    db.add(u); db.commit(); ids["users"].append(u.id)
    # Amy takes the posted price (no counter); Bob bids well over it.
    db.add(JobClaimRequest(org_id=1, job_id=jid, cleaner_id="CT-AMY", status="pending"))
    db.add(JobClaimRequest(org_id=1, job_id=jid, cleaner_id="CT-BOB", status="pending",
                           requested_rate=200.0))
    db.commit(); db.close()

    out = _build()
    job = next(j for j in out["waiting"]["jobs"] if j["job_id"] == jid)
    by_name = {a["name"]: a for a in job["askers"]}

    assert by_name["Amy Stone"]["rate"] == 100.0        # the posted price
    assert by_name["Amy Stone"]["countered"] is False
    assert by_name["Amy Stone"]["high_bid"] is False
    # Bob bid 200 on a 100 job — 100% over the default 20% line → flagged.
    assert by_name["CT-BOB"]["rate"] == 200.0
    assert by_name["CT-BOB"]["countered"] is True
    assert by_name["CT-BOB"]["high_bid"] is True


def test_an_open_job_nobody_asked_for_has_no_askers(ids):
    jid = _mk_job(ids, posted_rate=120.0)
    out = _build()
    job = next(j for j in out["open_jobs"] if j["job_id"] == jid)
    assert job["askers"] == []
    assert job["asked"] == 0


# ── Open means open ─────────────────────────────────────────────────────────

def test_a_job_somebody_already_has_is_not_open(ids):
    """The one error here that costs money: two cleaners turning up, or the
    office re-posting work that is already spoken for."""
    free = _mk_job(ids)
    taken = _mk_job(ids, agreed_cleaner_id="CT-MK")

    out = _build()

    open_ids = [j["job_id"] for j in out["open_jobs"]]
    assert free in open_ids
    assert taken not in open_ids


def test_yesterdays_open_job_is_not_offered_today(ids):
    past = _mk_job(ids, when=TODAY - timedelta(days=1))
    soon = _mk_job(ids, when=TODAY + timedelta(days=1))

    open_ids = [j["job_id"] for j in _build()["open_jobs"]]
    assert soon in open_ids and past not in open_ids


def test_a_cancelled_job_is_not_open_work(ids):
    dead = _mk_job(ids, status="cancelled")
    assert dead not in [j["job_id"] for j in _build()["open_jobs"]]


# ── Who is blocked on the office ────────────────────────────────────────────

def test_jobs_people_are_waiting_on_are_counted_and_surfaced(ids):
    asked = _mk_job(ids)
    quiet = _mk_job(ids)
    _ask(ids, asked, cleaner_id="CT-A")
    _ask(ids, asked, cleaner_id="CT-B")
    # A decided request is not somebody waiting.
    _ask(ids, quiet, cleaner_id="CT-C", status="declined")

    out = _build()

    assert out["waiting"]["job_count"] == 1
    assert out["waiting"]["people_waiting"] == 2
    assert out["waiting"]["jobs"][0]["job_id"] == asked
    # And the open board agrees with itself about the same number.
    board = {j["job_id"]: j["asked"] for j in out["open_jobs"]}
    assert board[asked] == 2 and board[quiet] == 0


def test_an_application_nobody_finished_reviewing_still_counts(ids):
    """`reviewing` is the state that goes quiet for a week — somebody opened
    it and did not decide. A queue that only counts untouched rows hides it."""
    # Measured as a DELTA. The shared test database carries applications from
    # other suites, so an absolute count here passes alone and fails in the
    # full run — which is worse than no test, because it only shows up once
    # somebody else adds a fixture.
    before = _build()["waiting"]["application_count"]

    db = SessionLocal()
    for status in ("new", "reviewing", "approved", "declined"):
        a = SubApplication(org_id=1, name=f"App {status}",
                           email=f"{status}-{uuid.uuid4().hex[:4]}@x.com",
                           status=status)
        db.add(a); db.commit(); db.refresh(a); ids["apps"].append(a.id)
    db.close()

    # new + reviewing, not approved or declined.
    assert _build()["waiting"]["application_count"] - before == 2


# ── Money ───────────────────────────────────────────────────────────────────

def test_sent_is_still_owed(ids):
    """The manual rail marks a payout SENT when the paperwork is produced, not
    when money lands. Counting it as paid is the error the ledger exists to
    prevent."""
    _mk_payout(ids, amount=100.0, status="due")
    _mk_payout(ids, amount=60.0, status="sent")
    _mk_payout(ids, amount=250.0, status="paid")
    _mk_payout(ids, amount=999.0, status="void")

    money = _build()["money"]

    assert money["owed"] == 160.0, "due + sent"
    assert money["paid_ytd"] == 250.0
    assert money["year"] == TODAY.year


def test_last_years_payment_is_not_this_years_total(ids):
    _mk_payout(ids, amount=500.0, status="paid",
               earned_on=date(TODAY.year - 1, 12, 20))
    _mk_payout(ids, amount=75.0, status="paid", earned_on=TODAY)

    assert _build()["money"]["paid_ytd"] == 75.0


# ── Scope ───────────────────────────────────────────────────────────────────

def test_another_org_is_invisible(ids):
    mine = _mk_job(ids, org_id=1)
    theirs = _mk_job(ids, org_id=2)

    open_ids = [j["job_id"] for j in _build(org_id=1)["open_jobs"]]
    assert mine in open_ids and theirs not in open_ids


def test_a_cleaner_cannot_read_the_office_view(ids):
    """The bench, what is owed and who is still un-vetted are internal facts.
    A cleaner's own side of this is My Day, built from /api/crew/*."""
    r = _api(_Cleaner()).get("/api/marketplace")
    assert r.status_code == 403, r.text


def test_the_office_gets_the_whole_page_in_one_call(ids):
    _mk_job(ids)
    r = _api().get("/api/marketplace")
    assert r.status_code == 200, r.text
    body = r.json()
    # Four sections, one request — the hub must not cost more than the pages
    # it gathers.
    for key in ("waiting", "open_jobs", "bench", "money"):
        assert key in body, key
    assert {"people", "can_work", "direct_deposit"} <= set(body["bench"])
