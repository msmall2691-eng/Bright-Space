"""Crew accept/decline (job_responses, crew app Phase 2).

The invariant that matters most: a response NEVER edits the schedule —
Job.cleaner_ids is byte-identical before and after a decline (owner decision:
the office decides reassignment; nothing silently falls off the calendar).

Also under test: my-day carries the caller's own answer; the office details
payload shows one entry per assigned cleaner (None until they answer); one row
per (job, cleaner) with change-of-mind updating in place; unassigned cleaners
404 (anti-probing); office roles can't answer for the crew.
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
    id, org_id, role, status, active = 9900, 1, "admin", "active", True
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
def job():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Resp {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="3 Fern St", address="3 Fern St", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Weekly clean",
            scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=["CT-801", "CT-802"], status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids = (j.id, p.id, c.id)
    db.close()
    yield ids[0]
    db = SessionLocal()
    db.query(JobResponse).filter(JobResponse.job_id == ids[0]).delete(synchronize_session=False)
    db.query(Job).filter(Job.id == ids[0]).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == ids[1]).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == ids[2]).delete(synchronize_session=False)
    db.commit(); db.close()


def _assignment(jid):
    db = SessionLocal()
    ids = db.query(Job).filter(Job.id == jid).first().cleaner_ids
    db.close()
    return list(ids or [])


def test_respond_roundtrip_and_schedule_untouched(job):
    before = _assignment(job)
    try:
        api = _as(_Cleaner(9801, "CT-801"))
        r = api.post(f"/api/crew/jobs/{job}/respond", json={"response": "accepted"})
        assert r.status_code == 200 and r.json()["response"] == "accepted"

        # my-day reflects the caller's own answer.
        mine = [j for j in api.get("/api/crew/my-day").json()["today"] if j["id"] == job]
        assert mine and mine[0]["my_response"] == {"response": "accepted", "reason": None}

        # Change of mind → decline with reason: same single row, updated.
        r = api.post(f"/api/crew/jobs/{job}/respond",
                     json={"response": "Declined", "reason": "  kid's sick  "})
        assert r.status_code == 200
        assert r.json() == {**r.json(), "response": "declined", "reason": "kid's sick"}
        db = SessionLocal()
        rows = db.query(JobResponse).filter(JobResponse.job_id == job,
                                            JobResponse.cleaner_id == "CT-801").all()
        db.close()
        assert len(rows) == 1

        # THE invariant: declining did not touch the assignment.
        assert _assignment(job) == before
        _clear()

        # Office details: one entry per assigned cleaner; the non-responder
        # shows response=None (so "no answer yet" is distinguishable).
        office = _as(_Admin())
        detail = office.get(f"/api/jobs/{job}/details").json()
        by_cid = {e["cleaner_id"]: e for e in detail["crew_responses"]}
        assert set(by_cid) == {"CT-801", "CT-802"}
        assert by_cid["CT-801"]["response"] == "declined"
        assert by_cid["CT-801"]["reason"] == "kid's sick"
        assert by_cid["CT-802"]["response"] is None
    finally:
        _clear()


def test_unassigned_cleaner_and_office_are_refused(job):
    try:
        intruder = _as(_Cleaner(9802, "CT-999"))
        assert intruder.post(f"/api/crew/jobs/{job}/respond",
                             json={"response": "accepted"}).status_code == 404
        _clear()
        office = _as(_Admin())
        # The office doesn't answer FOR the crew — cleaner-role gate.
        assert office.post(f"/api/crew/jobs/{job}/respond",
                           json={"response": "accepted"}).status_code == 403
    finally:
        _clear()


def test_bad_response_value_is_rejected(job):
    try:
        api = _as(_Cleaner(9803, "CT-801"))
        r = api.post(f"/api/crew/jobs/{job}/respond", json={"response": "maybe"})
        assert r.status_code == 422
    finally:
        _clear()
