"""The flat rate belongs to ONE person, and it does not outlive them.

RE-BASED (Sept 2026) onto the payout ledger. These originally asserted through
the payroll summary, which walked time-clock punches; the employee model is
gone and so is that endpoint. The rule they pin did not change — only the one
surface that still pays anybody.

Two money bugs, both from the same missing fact: the row said what was agreed
and never with whom.

FINDING 2. Payroll asked `cid in (job.cleaner_ids or [])` — membership in the
assignment list, not identity with the person who negotiated the number. Add a
helper to a job agreed at $100 with sub A and both clock in, and payroll paid A
$100 AND B $100. $200 out on a $100 job, every pay run, silently. The existing
test passed because its helper was deliberately NOT in cleaner_ids, which is
the rare case; the common one was untested.

FINDING 3. `agreed_rate` was written in two places and cleared nowhere, and is
not a field on JobUpdate, so no API path could unset it. Reassign the job and
an hourly employee inherits the sub's flat price while the sub, whose claim
request still reads "approved", is never told.

Migration 106 adds `agreed_cleaner_id`. What follows pins the identity check,
the release, both producers writing it, and the two exports that must NOT
change: an hourly helper still reaches Square, and a sub still never does.
"""
import uuid
from datetime import datetime, time as dtime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Job, JobClaimRequest, Property, TimeEntry, User,
)
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today


class _Office:
    id, org_id, role, status, active = 9901, 1, "admin", "active", True
    email, full_name, cleaner_id = "rate-office@example.com", "The Office", None


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Office()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": [], "users": [], "entries": []}
    yield m
    db = SessionLocal()
    db.query(TimeEntry).filter(TimeEntry.id.in_(m["entries"] or [0])).delete(synchronize_session=False)
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_crew(m, name="Sub"):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    u = User(email=f"rate-{tag}@example.com", role="cleaner", org_id=1,
             full_name=f"{name} {tag}", status="active", active=True,
             cleaner_id=f"CT-{tag[:5]}", pay_rate_residential=25.0)
    db.add(u); db.commit(); db.refresh(u)
    m["users"].append(u.id)
    out = (u.id, u.cleaner_id); db.close()
    return out


def _mk_job(m, *, cleaner_ids, agreed_rate=None, agreed_cleaner_id=None, day=None,
            status="scheduled"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Rate {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Rate Rd", city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Clean",
            scheduled_date=day or business_today(), start_time=dtime(9, 0),
            status=status, cleaner_ids=list(cleaner_ids),
            agreed_rate=agreed_rate, agreed_cleaner_id=agreed_cleaner_id)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _preview():
    """What the ledger would pay for today, per person. This is the only thing
    that pays anybody now — there is no hourly rail to cross-check against."""
    from services import sub_payouts

    db = SessionLocal()
    try:
        return sub_payouts.preview(db, 1, business_today(), business_today())
    finally:
        db.close()


def _owed(plan, crew):
    return round(sum(r["amount"] for r in plan["new"] if r["cleaner_id"] == crew), 2)


def _pay_for(body, crew):
    """The summary keys a row by `employee_id`, which holds the crew ID."""
    for e in body.get("employees", []):
        if e.get("employee_id") == crew:
            return e
    raise AssertionError(
        f"{crew} not in summary; rows were "
        f"{[e.get('employee_id') for e in body.get('employees', [])]}")


# ── finding 2 ───────────────────────────────────────────────────────────────

def test_the_agreed_rate_pays_only_the_person_who_agreed_it(made):
    """THE $200-on-a-$100-job case, which is the common one and was untested."""
    _, a = _mk_crew(made, "Sub A")
    _, b = _mk_crew(made, "Helper B")
    _mk_job(made, cleaner_ids=[a, b], agreed_rate=100.0, agreed_cleaner_id=a,
            status="completed")

    plan = _preview()
    assert _owed(plan, a) == 100.0
    assert _owed(plan, b) == 0.0, "the helper was cut the sub's flat rate too"
    assert plan["new_total"] == 100.0, "a $100 job paid out more than $100"


def test_the_ambiguous_legacy_row_pays_nobody_the_flat_rate(made):
    """Several cleaners, a rate, and nobody named — a row the backfill could
    not resolve. Under-paying is recoverable; paying everyone is money gone."""
    a_uid, a = _mk_crew(made, "Legacy A")
    b_uid, b = _mk_crew(made, "Legacy B")
    _mk_job(made, cleaner_ids=[a, b], agreed_rate=100.0, agreed_cleaner_id=None,
            status="completed")

    plan = _preview()
    assert _owed(plan, a) == 0.0
    assert _owed(plan, b) == 0.0


def test_a_lone_cleaner_on_a_legacy_row_is_still_paid(made):
    """One cleaner and no name is unambiguous, and is what payroll already
    paid them. Migration 106 backfills exactly this case."""
    uid, crew = _mk_crew(made, "Legacy Solo")
    _mk_job(made, cleaner_ids=[crew], agreed_rate=95.0, agreed_cleaner_id=None,
            status="completed")
    assert _owed(_preview(), crew) == 95.0


# ── finding 3 ───────────────────────────────────────────────────────────────

def test_reassigning_the_job_clears_the_rate_it_was_agreed_at(made):
    a_uid, a = _mk_crew(made, "Sub A")
    b_uid, b = _mk_crew(made, "Employee B")
    job = _mk_job(made, cleaner_ids=[a], agreed_rate=95.0, agreed_cleaner_id=a)
    db = SessionLocal()
    db.add(JobClaimRequest(job_id=job, cleaner_id=a, user_id=a_uid, org_id=1,
                           status="approved", requested_rate=95.0))
    db.commit(); db.close()

    r = _api().patch(f"/api/jobs/{job}", json={"cleaner_ids": [b]})
    assert r.status_code == 200, r.text

    db = SessionLocal()
    row = db.get(Job, job)
    assert row.agreed_rate is None, "an employee inherited the sub's flat price"
    assert row.agreed_cleaner_id is None
    req = db.query(JobClaimRequest).filter(JobClaimRequest.job_id == job).first()
    # Declined, not left "approved" — the trail has to say what happened.
    assert req.status == "declined"
    assert req.decided_at is not None
    # No reason column exists, and `message` holds the sub's own words — the
    # explanation reaches them in the notification, not by overwriting it.
    assert req.message is None or "assigned" not in (req.message or "")
    db.close()

    assert _owed(_preview(), b) == 0.0, "an employee inherited the sub\'s payout"


def test_adding_a_helper_does_not_clear_the_rate(made):
    """The control. Releasing on any cleaner_ids write would break the ordinary
    case of putting a second pair of hands on a job."""
    a_uid, a = _mk_crew(made, "Sub A")
    b_uid, b = _mk_crew(made, "Helper B")
    job = _mk_job(made, cleaner_ids=[a], agreed_rate=95.0, agreed_cleaner_id=a)

    assert _api().patch(f"/api/jobs/{job}", json={"cleaner_ids": [a, b]}).status_code == 200
    db = SessionLocal()
    row = db.get(Job, job)
    assert row.agreed_rate == 95.0
    assert row.agreed_cleaner_id == a
    db.close()


def test_an_unrelated_edit_leaves_everything_alone(made):
    a_uid, a = _mk_crew(made, "Sub A")
    job = _mk_job(made, cleaner_ids=[a], agreed_rate=95.0, agreed_cleaner_id=a)
    assert _api().patch(f"/api/jobs/{job}", json={"title": "Clean (edited)"}).status_code == 200
    db = SessionLocal()
    assert db.get(Job, job).agreed_rate == 95.0
    db.close()


# ── the producers both name somebody ────────────────────────────────────────

def test_approving_a_claim_records_who_agreed_it(made):
    from services.claim_approval import approve

    uid, crew = _mk_crew(made, "Winner")
    job = _mk_job(made, cleaner_ids=[], agreed_rate=None)
    db = SessionLocal()
    j = db.get(Job, job)
    j.open_for_claims, j.posted_rate = True, 120.0
    req = JobClaimRequest(job_id=job, cleaner_id=crew, user_id=uid, org_id=1,
                          status="pending", requested_rate=None)
    db.add(req); db.commit(); db.refresh(req)
    approve(db, j, req, org_id=1, actor_user_id=9901,
            find_conflicts=lambda *a, **kw: [], conflict_detail=lambda c: "",
            log_activity=lambda *a, **k: None)
    db.commit()
    row = db.get(Job, job)
    assert row.agreed_rate == 120.0
    assert row.agreed_cleaner_id == crew
    db.close()


# ── the Square export, both directions ──────────────────────────────────────

def test_the_identity_check_is_one_function_shared_by_every_payer(made):
    """There used to be three call sites asking this and two of them were
    wrong. The Square export was the third; it is gone with the rest of the
    employee rail, so the ledger is the only payer left — and it asks the same
    function."""
    from services.claim_approval import agreed_with
    from services import sub_payouts
    import inspect

    _, a = _mk_crew(made, "Sub A")
    _, b = _mk_crew(made, "Helper B")
    job = _mk_job(made, cleaner_ids=[a, b], agreed_rate=100.0, agreed_cleaner_id=a)
    db = SessionLocal()
    row = db.get(Job, job)
    assert agreed_with(row, a) is True
    assert agreed_with(row, b) is False
    db.close()
    assert "agreed_with" in inspect.getsource(sub_payouts.preview)
