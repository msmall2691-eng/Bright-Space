"""Crew open-jobs board + claim (crew app Phase 3).

The gate under test is owner decision #2: ONLY a job the office explicitly
flagged open_for_claims is claimable — being unassigned is not enough — and
one claim closes the offer atomically (the loser of a race sees 409). A claim
is the crew app's single schedule write: it adds the claimer to cleaner_ids,
flips the flag off, and seeds an "accepted" response so the office sees a
green check on a job the cleaner chose themself.

Also covered: open listings hide access details / customer phone until the
job is actually claimed; a claim that would double-book the claimer is
refused by the same conflict engine the office assign flow uses; and the
Phase 2 cleanup — removing a cleaner from a job (office PATCH) deletes their
stale accept/decline answer so a re-add starts at "no answer yet".
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, JobResponse
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
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_job(ids, cleaner_ids, *, open_for_claims=False, start=time(9, 0), end=time(11, 0)):
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
            open_for_claims=open_for_claims)
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


def test_open_listing_hides_access_and_claim_wins_once(ids):
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
        assert row["client_phone"] is None
        assert row["open"] is True

        r = api.post(f"/api/crew/jobs/{jid}/claim")
        assert r.status_code == 200, r.text
        assert r.json()["my_response"] == {"response": "accepted", "reason": None}

        state = _job(jid)
        assert "CT-902" in state["cleaner_ids"] and "CT-901" in state["cleaner_ids"]
        assert state["open"] is False   # one claim closes the offer

        # Now it's theirs: full details flow on my-day, and it left the board.
        day = api.get("/api/crew/my-day").json()
        mine = [j for j in day["today"] if j["id"] == jid]
        assert mine and mine[0]["house_code"] == "9999"
        assert not [j for j in day["open_jobs"] if j["id"] == jid]
        _clear()

        # Second cleaner arrives late → clean 409, assignment untouched.
        late = _as(_Cleaner(9902, "CT-903"))
        r = late.post(f"/api/crew/jobs/{jid}/claim")
        assert r.status_code == 409
        assert "already claimed" in r.json()["detail"]
        assert "CT-903" not in _job(jid)["cleaner_ids"]
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
