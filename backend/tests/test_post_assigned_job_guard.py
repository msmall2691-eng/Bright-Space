"""An offer is a vacancy. A job with somebody on it is not one.

Review finding 6, both halves — they compose into the bug and either alone
leaves it reachable:

  * posting was gated only on `status == "scheduled"`, so an ALREADY-ASSIGNED
    job could go on the board;
  * approval APPENDS to cleaner_ids rather than replacing.

Post a job at $80 → assign Maria directly → forget to close the offer → Dan
asks → approve Dan → the job now has Maria AND Dan, and nothing said that
approving added a second person rather than filling a vacancy. Before migration
106 it also paid both of them $80.

It no longer double-pays. The composition is still wrong: work priced for one
person, quietly staffed with two. What is pinned here is the refusal at both
ends, and — the part that stops this being a nuisance — that the ordinary ways
of posting a job still work.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, JobClaimRequest, Property, User
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today


class _Office:
    id, org_id, role, status, active = 9701, 1, "admin", "active", True
    email, full_name, cleaner_id = "post-guard@example.com", "The Office", None


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Office()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield m
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_job(m, *, cleaner_ids=()):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Guard {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Guard Rd", city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Clean",
            scheduled_date=business_today() + timedelta(days=2),
            start_time=dtime(9, 0), end_time=dtime(12, 0), status="scheduled",
            cleaner_ids=list(cleaner_ids))
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


# ── half one: you cannot post an assigned job ──────────────────────────────

def test_posting_an_assigned_job_is_refused(made):
    job = _mk_job(made, cleaner_ids=["CT-MARIA"])
    r = _api().patch(f"/api/jobs/{job}", json={"open_for_claims": True})
    assert r.status_code == 409, r.text
    assert "already assigned" in r.text.lower()

    db = SessionLocal()
    assert db.get(Job, job).open_for_claims is not True, "it posted anyway"
    db.close()


def test_an_unassigned_job_still_posts(made):
    """The control. A guard that stopped ordinary posting would be a worse bug
    than the one it fixes — this is the marketplace's whole front door."""
    job = _mk_job(made)
    r = _api().patch(f"/api/jobs/{job}", json={"open_for_claims": True,
                                              "posted_rate": 150.0})
    assert r.status_code == 200, r.text
    db = SessionLocal()
    row = db.get(Job, job)
    assert row.open_for_claims is True and row.posted_rate == 150.0
    db.close()


def test_clearing_the_assignment_and_posting_in_one_request_is_allowed(made):
    """Checked against the POST-update assignment, not the prior one. Wanting
    to take somebody off and offer it out is coherent; only the silent version
    is the bug."""
    job = _mk_job(made, cleaner_ids=["CT-MARIA"])
    r = _api().patch(f"/api/jobs/{job}",
                     json={"cleaner_ids": [], "open_for_claims": True})
    assert r.status_code == 200, r.text
    db = SessionLocal()
    assert db.get(Job, job).open_for_claims is True
    db.close()


def test_taking_a_job_off_the_board_is_never_blocked(made):
    """Closing an offer must not be gated on anything. If it were, an assigned
    job that somehow got posted could never be un-posted."""
    job = _mk_job(made)
    assert _api().patch(f"/api/jobs/{job}", json={"open_for_claims": True}).status_code == 200
    db = SessionLocal()
    db.get(Job, job).cleaner_ids = ["CT-SOMEONE"]
    db.commit(); db.close()
    assert _api().patch(f"/api/jobs/{job}", json={"open_for_claims": False}).status_code == 200


# ── half two: approval never adds a second person ──────────────────────────

def test_approving_a_request_on_an_assigned_job_is_refused(made):
    """The composition the posting guard alone does not close: a job posted
    while free, then assigned directly while a request sits pending."""
    from services.claim_approval import ClaimApprovalError, approve

    job = _mk_job(made)
    db = SessionLocal()
    j = db.get(Job, job)
    j.open_for_claims, j.posted_rate = True, 80.0
    req = JobClaimRequest(job_id=job, cleaner_id="CT-DAN", org_id=1,
                          status="pending", requested_rate=None)
    db.add(req); db.commit(); db.refresh(req)
    # Maria gets assigned directly while Dan's request is pending.
    j.cleaner_ids = ["CT-MARIA"]
    db.commit()

    with pytest.raises(ClaimApprovalError) as e:
        approve(db, j, req, org_id=1, actor_user_id=9701,
                find_conflicts=lambda *a, **k: [],
                conflict_detail=lambda c: "", log_activity=lambda *a, **k: None)
    assert e.value.status == 409
    db.refresh(j)
    assert j.cleaner_ids == ["CT-MARIA"], "the requester was appended anyway"
    db.close()


def test_approving_on_a_free_job_still_works(made):
    """The control for the other half."""
    from services.claim_approval import approve

    job = _mk_job(made)
    db = SessionLocal()
    j = db.get(Job, job)
    j.open_for_claims, j.posted_rate = True, 80.0
    req = JobClaimRequest(job_id=job, cleaner_id="CT-DAN", org_id=1,
                          status="pending", requested_rate=None)
    db.add(req); db.commit(); db.refresh(req)

    approve(db, j, req, org_id=1, actor_user_id=9701,
            find_conflicts=lambda *a, **k: [],
            conflict_detail=lambda c: "", log_activity=lambda *a, **k: None)
    db.refresh(j)
    assert j.cleaner_ids == ["CT-DAN"]
    assert j.agreed_rate == 80.0
    assert j.agreed_cleaner_id == "CT-DAN"
    db.close()


def test_re_approving_the_same_person_is_not_blocked_by_their_own_name(made):
    """The guard looks for OTHER people. Somebody already on the job asking for
    it — a re-open, a re-request — must not be refused because they are on it."""
    from services.claim_approval import approve

    job = _mk_job(made, cleaner_ids=["CT-DAN"])
    db = SessionLocal()
    j = db.get(Job, job)
    j.open_for_claims, j.posted_rate = True, 80.0
    req = JobClaimRequest(job_id=job, cleaner_id="CT-DAN", org_id=1,
                          status="pending", requested_rate=None)
    db.add(req); db.commit(); db.refresh(req)

    approve(db, j, req, org_id=1, actor_user_id=9701,
            find_conflicts=lambda *a, **k: [],
            conflict_detail=lambda c: "", log_activity=lambda *a, **k: None)
    db.refresh(j)
    assert j.cleaner_ids == ["CT-DAN"]
    db.close()
