"""Crew open-jobs board + request-to-claim (marketplace pivot, migration 097).

The gate under test is owner decision #2: ONLY a job the office explicitly
flagged open_for_claims is claimable — being unassigned is not enough.
Claiming FILES A REQUEST (optionally countering the office's posted_rate) —
it does not assign the job or close the offer; several subs can request the
same open job, and the office picks who gets it (see
test_marketplace_claim_requests.py for the approve/decline side). A request
is refused as a 409 if it would double-book the requester against a job
they're already assigned to — the same conflict engine the office's assign
flow uses.

Also covered: open listings hide access details / customer phone until the
job is actually approved; and the Phase 2 cleanup — removing a cleaner from
a job (office PATCH) deletes their stale accept/decline answer so a re-add
starts at "no answer yet".
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, JobClaimRequest, JobResponse
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9950, 1, "admin", "active", True
    email = "admin@example.com"
    full_name = "The Office"
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
    db.query(JobResponse).filter(JobResponse.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_job(ids, cleaner_ids, *, open_for_claims=False, start=time(9, 0), end=time(11, 0),
            posted_rate=80.0):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Claim {tag}", status="active", org_id=1, phone="207-555-0100")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"7 Elm {tag}", address=f"7 Elm {tag}", org_id=1,
                 house_code="9999", access_notes="Key under mat")
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=f"Clean {tag}",
            scheduled_date=business_today(), start_time=start, end_time=end,
            cleaner_ids=cleaner_ids, status="scheduled", org_id=1,
            open_for_claims=open_for_claims, posted_rate=posted_rate)
    db.add(j); db.commit(); db.refresh(j)
    ids["clients"].append(c.id); ids["properties"].append(p.id); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _job(jid):
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    out = {"cleaner_ids": list(j.cleaner_ids or []), "open": bool(j.open_for_claims)}
    db.close()
    return out


def test_open_listing_hides_access_and_request_stays_open_for_others(ids):
    """Marketplace pivot (migration 097): claiming files a REQUEST, it
    doesn't assign the job or close the offer — a second sub can still
    request the same job. Access details stay hidden until the sub is
    actually approved, same as before."""
    jid = _mk_job(ids, ["CT-901"], open_for_claims=True)
    try:
        api = _as(_Cleaner(9901, "CT-902"))
        day = api.get("/api/crew/my-day").json()
        listing = [j for j in day["open_jobs"] if j["id"] == jid]
        assert listing, "open job missing from board"
        row = listing[0]
        # An offer, not a work order: access details + customer phone hidden.
        assert row["house_code"] is None
        assert row["access_notes"] is None
        assert "client_phone" not in row          # numbers never reach crew
        assert row["can_text_client"] is False    # offers can't text either
        assert row["open"] is True
        assert row["my_claim_request"] is None    # haven't asked yet

        r = api.post(f"/api/crew/jobs/{jid}/claim", json={"requested_rate": 90.0,
                                                         "message": "I can do this one"})
        assert r.status_code == 200, r.text
        assert r.json() == {"job_id": jid, "status": "pending",
                            "requested_rate": 90.0, "message": "I can do this one"}

        # Not assigned yet — still just a request. Office decides.
        state = _job(jid)
        assert "CT-902" not in state["cleaner_ids"]
        assert state["open"] is True

        # My own listing now shows my pending request instead of letting me
        # request twice blind.
        day = api.get("/api/crew/my-day").json()
        listing = [j for j in day["open_jobs"] if j["id"] == jid]
        assert listing[0]["my_claim_request"] == {
            "status": "pending", "requested_rate": 90.0, "message": "I can do this one"}

        # A second sub can ALSO request the same still-open job.
        _clear()
        second = _as(_Cleaner(9902, "CT-903"))
        r2 = second.post(f"/api/crew/jobs/{jid}/claim")   # accepts posted rate, no counter
        assert r2.status_code == 200, r2.text
        assert r2.json()["requested_rate"] is None
        assert _job(jid)["open"] is True   # still open — office hasn't picked
    finally:
        _clear()


def test_a_job_with_no_posted_rate_cannot_be_requested_blind(ids):
    """Fix: a sub must not end up working for an unstated amount.

    posted_rate is nullable by design (a re-opened job may not carry a new
    price), and a request with no counter means "I'll take your rate" — so
    both being NULL is nobody having named a number. Refused here, while the
    sub is still looking at the offer, rather than at approval time where the
    error would surface to the office instead of to the person it concerns.
    """
    jid = _mk_job(ids, [], open_for_claims=True, posted_rate=None)
    try:
        api = _as(_Cleaner(9903, "CT-904"))
        r = api.post(f"/api/crew/jobs/{jid}/claim")
        assert r.status_code == 422
        assert "name your price" in r.json()["detail"]

        # Naming a price is exactly how you take an unpriced job.
        r2 = api.post(f"/api/crew/jobs/{jid}/claim", json={"requested_rate": 120.0})
        assert r2.status_code == 200, r2.text
        assert r2.json()["requested_rate"] == 120.0
    finally:
        _clear()


def test_unopened_job_is_not_claimable_even_if_unassigned(ids):
    jid = _mk_job(ids, [], open_for_claims=False)
    try:
        api = _as(_Cleaner(9903, "CT-904"))
        assert not [j for j in api.get("/api/crew/my-day").json()["open_jobs"] if j["id"] == jid]
        assert api.post(f"/api/crew/jobs/{jid}/claim").status_code == 409
    finally:
        _clear()


def test_claim_refused_when_it_would_double_book(ids):
    mine = _mk_job(ids, ["CT-905"], start=time(9, 0), end=time(11, 0))
    offer = _mk_job(ids, [], open_for_claims=True, start=time(10, 0), end=time(12, 0))
    try:
        api = _as(_Cleaner(9905, "CT-905"))
        r = api.post(f"/api/crew/jobs/{offer}/claim")
        assert r.status_code == 409
        assert _job(offer)["open"] is True   # offer survives the refused claim
    finally:
        _clear()


def test_office_roles_cannot_claim(ids):
    jid = _mk_job(ids, [], open_for_claims=True)
    try:
        office = _as(_Admin())
        assert office.post(f"/api/crew/jobs/{jid}/claim").status_code == 403
    finally:
        _clear()


def test_office_unassign_clears_stale_response(ids):
    jid = _mk_job(ids, ["CT-906", "CT-907"])
    try:
        api = _as(_Cleaner(9906, "CT-906"))
        api.post(f"/api/crew/jobs/{jid}/respond", json={"response": "declined", "reason": "sick"})
        _clear()

        office = _as(_Admin())
        r = office.patch(f"/api/jobs/{jid}", json={"cleaner_ids": ["CT-907"]})
        assert r.status_code == 200, r.text
        db = SessionLocal()
        rows = db.query(JobResponse).filter(JobResponse.job_id == jid).all()
        db.close()
        # The removed cleaner's answer is gone; a later re-add starts fresh.
        assert [x.cleaner_id for x in rows] == []
    finally:
        _clear()
