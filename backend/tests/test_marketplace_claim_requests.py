"""Office review of job-claim requests (marketplace pivot, migration 097).

A sub's request never touches the schedule by itself (see test_job_claims.py)
— these endpoints are where the office actually decides. Covers: approving
one request assigns the sub at the AGREED rate (their counter if they made
one, else the posted rate) and auto-declines every other pending request on
the same job; declining a single request leaves the job open for others;
approval re-checks for a double-booking conflict at decide-time, not just
request-time; approval is refused outright when nobody has named a rate; and
only admin/manager can reach any of this.
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, JobClaimRequest
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9960, 1, "admin", "active", True
    email = "admin2@example.com"
    full_name = "The Office"
    cleaner_id = None


class _Viewer:
    id, org_id, role, status, active = 9961, 1, "viewer", "active", True
    email = "viewer2@example.com"
    full_name = "Read Only"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_open_job(ids, posted_rate=80.0, start=time(9, 0), end=time(11, 0), org_id=1):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Market {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"12 Pine {tag}", address=f"12 Pine {tag}", org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=f"Clean {tag}",
            scheduled_date=business_today(), start_time=start, end_time=end,
            cleaner_ids=[], status="scheduled", org_id=org_id,
            open_for_claims=True, posted_rate=posted_rate)
    db.add(j); db.commit(); db.refresh(j)
    ids["clients"].append(c.id); ids["properties"].append(p.id); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _job_state(jid):
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    out = {"cleaner_ids": list(j.cleaner_ids or []), "open": bool(j.open_for_claims),
           "agreed_rate": j.agreed_rate}
    db.close()
    return out


def test_approving_a_counter_offer_sets_agreed_rate_and_declines_the_rest(ids):
    jid = _mk_open_job(ids, posted_rate=80.0)
    try:
        # Two subs request the same job — one at the posted rate, one countering higher.
        a = _as(_Cleaner(9910, "CT-910")); a.post(f"/api/crew/jobs/{jid}/claim")
        _clear()
        b = _as(_Cleaner(9911, "CT-911"))
        b.post(f"/api/crew/jobs/{jid}/claim",
               json={"requested_rate": 95.0, "message": "I bring my own supplies"})
        _clear()

        office = _as(_Admin())
        listed = office.get(f"/api/jobs/{jid}/claim-requests").json()
        assert listed["posted_rate"] == 80.0
        assert {r["cleaner_id"]: r["requested_rate"] for r in listed["requests"]} == {
            "CT-910": None, "CT-911": 95.0}
        b_req_id = next(r["id"] for r in listed["requests"] if r["cleaner_id"] == "CT-911")

        r = office.post(f"/api/jobs/{jid}/claim-requests/{b_req_id}/approve")
        assert r.status_code == 200, r.text
        assert r.json() == {"status": "approved", "job_id": jid,
                            "cleaner_id": "CT-911", "agreed_rate": 95.0}

        state = _job_state(jid)
        assert state["cleaner_ids"] == ["CT-911"]
        assert state["agreed_rate"] == 95.0     # the winner's counter, not the posted rate
        assert state["open"] is False

        after = office.get(f"/api/jobs/{jid}/claim-requests").json()
        by_cid = {r["cleaner_id"]: r["status"] for r in after["requests"]}
        assert by_cid == {"CT-910": "declined", "CT-911": "approved"}   # loser auto-declined
    finally:
        _clear()


def test_approving_at_posted_rate_when_no_counter_was_made(ids):
    jid = _mk_open_job(ids, posted_rate=75.0)
    try:
        api = _as(_Cleaner(9912, "CT-912"))
        api.post(f"/api/crew/jobs/{jid}/claim")   # no counter — accepts posted rate
        _clear()

        office = _as(_Admin())
        req_id = office.get(f"/api/jobs/{jid}/claim-requests").json()["requests"][0]["id"]
        r = office.post(f"/api/jobs/{jid}/claim-requests/{req_id}/approve")
        assert r.json()["agreed_rate"] == 75.0
    finally:
        _clear()


def test_approval_refused_when_nobody_named_a_rate(ids):
    """Fix: never schedule someone onto a job for an unstated amount.

    The crew app blocks the rate-less request, so the only way to reach this
    state is the office clearing posted_rate after the request came in. The
    approval has to catch it too — otherwise agreed_rate lands as NULL, the
    sub works, and payroll has no number to pay them from.
    """
    jid = _mk_open_job(ids, posted_rate=70.0)
    try:
        api = _as(_Cleaner(9918, "CT-918"))
        api.post(f"/api/crew/jobs/{jid}/claim")   # takes the posted rate
        _clear()

        db = SessionLocal()                        # office clears the price
        db.query(Job).filter(Job.id == jid).update({"posted_rate": None})
        db.commit(); db.close()

        office = _as(_Admin())
        req_id = office.get(f"/api/jobs/{jid}/claim-requests").json()["requests"][0]["id"]
        r = office.post(f"/api/jobs/{jid}/claim-requests/{req_id}/approve")
        assert r.status_code == 409
        assert "No rate agreed" in r.json()["detail"]

        state = _job_state(jid)
        assert state["cleaner_ids"] == []      # nobody assigned
        assert state["agreed_rate"] is None
        assert state["open"] is True           # a refused approval leaves the offer up
    finally:
        _clear()


def test_declining_one_request_leaves_job_open_for_others(ids):
    jid = _mk_open_job(ids)
    try:
        api = _as(_Cleaner(9913, "CT-913")); api.post(f"/api/crew/jobs/{jid}/claim")
        _clear()

        office = _as(_Admin())
        req_id = office.get(f"/api/jobs/{jid}/claim-requests").json()["requests"][0]["id"]
        r = office.post(f"/api/jobs/{jid}/claim-requests/{req_id}/decline")
        assert r.status_code == 200

        state = _job_state(jid)
        assert state["open"] is True            # still open — nobody approved
        assert state["cleaner_ids"] == []

        # A second sub can still request it.
        _clear()
        second = _as(_Cleaner(9914, "CT-914"))
        assert second.post(f"/api/crew/jobs/{jid}/claim").status_code == 200
    finally:
        _clear()


def test_approval_refused_when_it_would_double_book_the_winner(ids):
    """The request itself was conflict-free at request time, but the sub
    picked up something else in the meantime — approval must re-check."""
    conflicting = _mk_open_job(ids, posted_rate=50.0, start=time(9, 0), end=time(11, 0))
    offer = _mk_open_job(ids, posted_rate=60.0, start=time(10, 0), end=time(12, 0))
    try:
        api = _as(_Cleaner(9915, "CT-915"))
        api.post(f"/api/crew/jobs/{offer}/claim")
        _clear()

        # CT-915 gets assigned to the conflicting job directly by the office
        # (not through the marketplace) in between the request and approval.
        office = _as(_Admin())
        r = office.patch(f"/api/jobs/{conflicting}", json={"cleaner_ids": ["CT-915"]})
        assert r.status_code == 200, r.text

        req_id = office.get(f"/api/jobs/{offer}/claim-requests").json()["requests"][0]["id"]
        r2 = office.post(f"/api/jobs/{offer}/claim-requests/{req_id}/approve")
        assert r2.status_code == 409
        assert _job_state(offer)["open"] is True   # refused approval doesn't close the offer
    finally:
        _clear()


def test_a_second_approval_on_the_same_job_cannot_add_a_second_winner(ids):
    """Fix (scheduling-invariants R5): approving is the step that assigns the
    job and fixes the money, so it re-reads open_for_claims under a row lock.

    Serial proof of the invariant the lock protects — two office taps, one
    winner. The lock is what makes it hold when those taps overlap instead of
    queueing (Postgres SELECT ... FOR UPDATE; SQLite serializes writers).
    """
    jid = _mk_open_job(ids, posted_rate=80.0)
    try:
        a = _as(_Cleaner(9919, "CT-919")); a.post(f"/api/crew/jobs/{jid}/claim")
        _clear()
        b = _as(_Cleaner(9920, "CT-920"))
        b.post(f"/api/crew/jobs/{jid}/claim", json={"requested_rate": 99.0})
        _clear()

        office = _as(_Admin())
        reqs = {r["cleaner_id"]: r["id"]
                for r in office.get(f"/api/jobs/{jid}/claim-requests").json()["requests"]}
        assert office.post(f"/api/jobs/{jid}/claim-requests/{reqs['CT-919']}/approve").status_code == 200

        # The second request was auto-declined by the first approval, and the
        # job is no longer open — either check alone is enough to refuse.
        r2 = office.post(f"/api/jobs/{jid}/claim-requests/{reqs['CT-920']}/approve")
        assert r2.status_code == 409

        state = _job_state(jid)
        assert state["cleaner_ids"] == ["CT-919"]   # exactly one winner
        assert state["agreed_rate"] == 80.0         # not overwritten by the loser's 99
    finally:
        _clear()


def test_approving_or_declining_an_already_decided_request_is_refused(ids):
    jid = _mk_open_job(ids)
    try:
        api = _as(_Cleaner(9916, "CT-916")); api.post(f"/api/crew/jobs/{jid}/claim")
        _clear()
        office = _as(_Admin())
        req_id = office.get(f"/api/jobs/{jid}/claim-requests").json()["requests"][0]["id"]
        office.post(f"/api/jobs/{jid}/claim-requests/{req_id}/approve")

        r = office.post(f"/api/jobs/{jid}/claim-requests/{req_id}/decline")
        assert r.status_code == 409
    finally:
        _clear()


def test_crew_and_viewer_roles_cannot_review_or_decide_claims(ids):
    jid = _mk_open_job(ids)
    try:
        for user in (_Cleaner(9917, "CT-917"), _Viewer()):
            api = _as(user)
            assert api.get(f"/api/jobs/{jid}/claim-requests").status_code == 403
            assert api.post(f"/api/jobs/{jid}/claim-requests/1/approve").status_code == 403
            assert api.post(f"/api/jobs/{jid}/claim-requests/1/decline").status_code == 403
            _clear()
    finally:
        _clear()


def test_another_orgs_posted_job_is_not_reachable(ids):
    """MT-3: job ids are guessable, and a claim request records who wants
    which job at what price. The org scope on the job is the gate; RLS on
    job_claim_requests (TENANT_TABLES, migration 097) is the backstop."""
    jid = _mk_open_job(ids, org_id=99999)
    try:
        office = _as(_Admin())     # resolves to org 1
        assert office.get(f"/api/jobs/{jid}/claim-requests").status_code == 404
        assert office.post(f"/api/jobs/{jid}/claim-requests/1/approve").status_code == 404
        assert office.post(f"/api/jobs/{jid}/claim-requests/1/decline").status_code == 404
    finally:
        _clear()


def test_job_claim_requests_is_covered_by_row_level_security():
    """The table carries org_id, so it must be in TENANT_TABLES or Postgres
    enforces nothing on it. Migration 095 exists because two tables sat
    org-scoped-but-unprotected for months; this asserts 097 didn't repeat it."""
    from database.rls import TENANT_TABLES
    assert "job_claim_requests" in TENANT_TABLES
