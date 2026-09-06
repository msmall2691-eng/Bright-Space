"""A subcontractor can bring their own helper — migration 107.

THIS IS ONE OF THE FIVE MAINE CRITERIA, not a convenience feature. Part 1 of
Maine's unified employment standard has five conditions and ALL FIVE must hold;
#4 is "hires, pays and supervises their own assistants, if any". BrightBase
modelled exactly one cleaner per claim, so a sub could not bring anyone —
`.claude/skills/brightbase-marketplace` has carried this as a live gap since
migration 104, and Part 1 is the half with no partial credit.

What is pinned here is mostly what the feature MUST NOT DO, because every one
of those is a way of building it that would satisfy the letter and invert the
substance:

  * the office cannot add a helper — that is the office staffing the job, and
    a sub requests or accepts, never gets assigned;
  * a helper is not a user — no account, no login, no vetting file. Onboarding
    and clearing them makes them TMCC's worker, not the sub's assistant;
  * a helper is not paid by the app — the sub is paid `agreed_rate` and pays
    them out of it. A helper the app pays is a person TMCC pays;
  * a sub speaks only for their own helpers, and only on their own jobs.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, JobHelper, Property, SubPayout, User
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today

DAN, MARIA = "CT-DAN-H", "CT-MARIA-H"


class _Sub:
    id, org_id, role, status, active = 9971, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "dan-helper@example.com", "Dan Rowe", DAN


class _OtherSub:
    id, org_id, role, status, active = 9972, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "maria-helper@example.com", "Maria Lund", MARIA


class _Office:
    id, org_id, role, status, active = 9973, 1, "admin", "active", True
    email, full_name, cleaner_id = "office-helper@example.com", "The Office", None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": []}
    yield m
    db = SessionLocal()
    db.query(JobHelper).filter(JobHelper.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(SubPayout).filter(SubPayout.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _job(m, *, cleaners=(DAN,), status="scheduled"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Helper {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Helper Way", city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Deep clean",
            scheduled_date=business_today() + timedelta(days=2),
            start_time=dtime(9, 0), end_time=dtime(14, 0), status=status,
            cleaner_ids=list(cleaners), agreed_rate=180.0, agreed_cleaner_id=DAN)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


# ── the criterion itself ───────────────────────────────────────────────────

def test_a_sub_can_bring_somebody_to_their_own_job(made):
    job = _job(made)
    r = _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers",
                         json={"name": "Sam Reed", "phone": "207-555-0134"})
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "Sam Reed"
    listed = _as(_Sub()).get(f"/api/crew/jobs/{job}/helpers").json()["helpers"]
    assert [h["name"] for h in listed] == ["Sam Reed"]


def test_they_can_change_their_mind(made):
    job = _job(made)
    api = _as(_Sub())
    hid = api.post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"}).json()["id"]
    assert api.delete(f"/api/crew/jobs/{job}/helpers/{hid}").status_code == 204
    assert _as(_Sub()).get(f"/api/crew/jobs/{job}/helpers").json()["helpers"] == []


def test_the_office_can_see_who_is_going_to_be_in_the_house(made):
    """The honest reason the name is recorded at all. Read-only — see below."""
    job = _job(made)
    _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"})
    rows = _as(_Office()).get("/api/jobs", params={"limit": 500}).json()
    row = next(r for r in (rows if isinstance(rows, list) else rows["items"]) if r["id"] == job)
    assert [h["name"] for h in row["helpers"]] == ["Sam Reed"]
    assert row["helpers"][0]["sub_cleaner_id"] == DAN, "a helper with nobody responsible for them"


# ── the four things it must not become ─────────────────────────────────────

def test_the_office_cannot_put_somebody_on_a_job(made):
    """No office write path, at all. Choosing who else works a job would be the
    office staffing it — and a sub requests or accepts, never gets assigned."""
    job = _job(made)
    r = _as(_Office()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"})
    assert r.status_code in (403, 404), r.text
    db = SessionLocal()
    assert db.query(JobHelper).filter(JobHelper.job_id == job).count() == 0
    db.close()


def test_a_helper_is_not_a_user(made):
    """No account, no login, no vetting file. The moment TMCC onboards and
    clears the helper, the helper is TMCC's worker and the sub is no longer
    hiring their own assistant — the criterion inverted."""
    job = _job(made)
    before = SessionLocal()
    n_users = before.query(User).count(); before.close()
    _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers",
                     json={"name": "Sam Reed", "phone": "207-555-0134"})
    db = SessionLocal()
    assert db.query(User).count() == n_users, "adding a helper minted an account"
    assert db.query(User).filter(User.full_name == "Sam Reed").first() is None
    row = db.query(JobHelper).filter(JobHelper.job_id == job).first()
    assert not hasattr(row, "user_id"), "a helper row must not reference a user"
    db.close()


def test_a_helper_is_never_paid_by_the_app(made):
    """The sub is paid the job's agreed_rate and pays their helper out of it.
    A helper the app pays is a person TMCC pays."""
    job = _job(made)
    _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"})
    db = SessionLocal()
    assert db.query(SubPayout).filter(SubPayout.job_id == job).count() == 0
    row = db.query(JobHelper).filter(JobHelper.job_id == job).first()
    cols = {c.name for c in row.__table__.columns}
    assert not (cols & {"rate", "amount", "pay", "payout_id", "user_id"}), cols
    db.close()


def test_a_helper_does_not_change_what_the_sub_is_paid(made):
    """The number on the job is the number, whoever the sub brings. This is the
    same shape as the bug migration 106 fixed — a second person on the job
    turning one agreed rate into two."""
    job = _job(made)
    _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"})
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == job).first()
    assert j.agreed_rate == 180.0 and j.agreed_cleaner_id == DAN
    assert j.cleaner_ids == [DAN], "a helper was added to the assignment list"
    db.close()


# ── whose helper, and whose job ────────────────────────────────────────────

def test_a_sub_cannot_add_somebody_to_a_job_that_is_not_theirs(made):
    job = _job(made, cleaners=(DAN,))
    r = _as(_OtherSub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Gate Crasher"})
    assert r.status_code == 403, r.text


def test_on_a_shared_job_each_sub_sees_and_removes_only_their_own(made):
    """Two subs, two sets of assistants, two separate responsibilities. Maria
    withdrawing Dan's helper would be Maria deciding who Dan brings."""
    job = _job(made, cleaners=(DAN, MARIA))
    dans = _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"}).json()
    _as(_OtherSub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Jo Park"})

    assert [h["name"] for h in _as(_Sub()).get(f"/api/crew/jobs/{job}/helpers").json()["helpers"]] == ["Sam Reed"]
    assert [h["name"] for h in _as(_OtherSub()).get(f"/api/crew/jobs/{job}/helpers").json()["helpers"]] == ["Jo Park"]
    assert _as(_OtherSub()).delete(f"/api/crew/jobs/{job}/helpers/{dans['id']}").status_code == 404

    # The office, who needs to know everyone in the house, sees both.
    rows = _as(_Office()).get("/api/jobs", params={"limit": 500}).json()
    row = next(r for r in (rows if isinstance(rows, list) else rows["items"]) if r["id"] == job)
    assert sorted(h["name"] for h in row["helpers"]) == ["Jo Park", "Sam Reed"]


# ── the ordinary guards ────────────────────────────────────────────────────

def test_a_finished_job_takes_nobody_new(made):
    job = _job(made, status="completed")
    r = _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"})
    assert r.status_code == 409, r.text


def test_a_nameless_helper_is_refused(made):
    job = _job(made)
    r = _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers", json={"name": "   "})
    assert r.status_code == 422, r.text


def test_the_same_person_is_not_added_twice(made):
    job = _job(made)
    api = _as(_Sub())
    assert api.post(f"/api/crew/jobs/{job}/helpers", json={"name": "Sam Reed"}).status_code == 201
    assert api.post(f"/api/crew/jobs/{job}/helpers", json={"name": "sam reed"}).status_code == 409


def test_there_is_a_ceiling(made):
    """Three is a crew; a sub subcontracting the whole job to five people they
    hired is a different arrangement, and one the office should hear about in
    words rather than discover in a row count."""
    from modules.crew.router import MAX_HELPERS_PER_SUB
    job = _job(made)
    api = _as(_Sub())
    for i in range(MAX_HELPERS_PER_SUB):
        assert api.post(f"/api/crew/jobs/{job}/helpers", json={"name": f"Helper {i}"}).status_code == 201
    assert api.post(f"/api/crew/jobs/{job}/helpers", json={"name": "One too many"}).status_code == 409


def test_the_tenant_table_is_registered(made):
    """brightbase-marketplace's trap: being on TENANT_TABLES does nothing by
    itself, and being off it means no backstop at all. Migration 107 calls
    apply_org_rls itself; test_migrations_from_scratch proves the policy landed."""
    from database.rls import TENANT_TABLES
    assert "job_helpers" in TENANT_TABLES


def test_a_sub_cannot_enumerate_other_subs_helpers_through_the_office_api(made):
    """The same side door `strip_office_only_for_crew` was written to close for
    rates — and worse here, because a helper's name and MOBILE NUMBER belong to
    somebody with no account who never agreed to anything with TMCC. A sub
    reads their own helpers from the crew endpoint; nothing else needs to hand
    them everyone else's."""
    job = _job(made, cleaners=(DAN, MARIA))
    _as(_Sub()).post(f"/api/crew/jobs/{job}/helpers",
                     json={"name": "Sam Reed", "phone": "207-555-0134"})

    rows = _as(_OtherSub()).get("/api/jobs", params={"limit": 500}).json()
    rows = rows if isinstance(rows, list) else rows["items"]
    mine = next((r for r in rows if r["id"] == job), None)
    if mine is not None:                       # crew may not see the list at all
        assert "helpers" not in mine, mine.get("helpers")
    blob = str(rows)
    assert "207-555-0134" not in blob and "Sam Reed" not in blob

    # And the office, who does need it, still gets it.
    off = _as(_Office()).get("/api/jobs", params={"limit": 500}).json()
    off = off if isinstance(off, list) else off["items"]
    row = next(r for r in off if r["id"] == job)
    assert [h["name"] for h in row["helpers"]] == ["Sam Reed"]
