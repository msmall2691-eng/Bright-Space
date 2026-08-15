"""Access details (door codes, access notes, wifi passwords) are the crown
jewels — they must only reach a cleaner through their own assigned jobs.

BB-SEC-11: GET /api/properties/{id} returns the full property dict (codes and
wifi_password included) and previously had NO role gate — any authenticated
cleaner could read every property's codes by id. Office roles only now.

BB-SEC-12: GET /api/jobs/{id}/details allowed the cleaner role and served
property.house_code + access_notes for ANY org job with no assignment check.
Cleaners now get those two fields only on jobs they're assigned to; office
roles are unchanged.
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _User:
    def __init__(self, uid, role, cleaner_id=None):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, role, "active", True
        self.email = f"{role}-{uid}@example.com"
        self.full_name = f"{role.title()} {uid}"
        self.cleaner_id = cleaner_id


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def made():
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_job(made, *, cleaner_ids):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    c = Client(name=f"Gate {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    made["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"House {tag}", address=f"1 Gate St {tag}",
                 org_id=1, house_code="7734", access_notes="Lockbox on the rail")
    db.add(p); db.commit(); db.refresh(p)
    made["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title=f"Gate clean {tag}", scheduled_date=business_today(),
            start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=cleaner_ids, status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    jid, pid = j.id, p.id
    made["jobs"].append(jid)
    db.close()
    return jid, pid


def test_job_details_blanks_codes_for_unassigned_cleaner(made):
    jid, _pid = _mk_job(made, cleaner_ids=["CT-gate-1"])
    try:
        # The assigned cleaner sees the code on their own job.
        r = _as(_User(9981, "cleaner", "CT-gate-1")).get(f"/api/jobs/{jid}/details")
        assert r.status_code == 200
        assert r.json()["property"]["house_code"] == "7734"

        # A different cleaner gets the job, but the access fields are blank.
        r = _as(_User(9982, "cleaner", "CT-gate-2")).get(f"/api/jobs/{jid}/details")
        assert r.status_code == 200
        prop = r.json()["property"]
        assert prop["house_code"] is None and prop["access_notes"] is None

        # Office roles are unchanged.
        r = _as(_User(9983, "admin")).get(f"/api/jobs/{jid}/details")
        assert r.status_code == 200
        assert r.json()["property"]["house_code"] == "7734"
    finally:
        _clear()


def test_property_by_id_is_office_only(made):
    _jid, pid = _mk_job(made, cleaner_ids=["CT-gate-1"])
    try:
        # Even the assigned cleaner can't pull the raw property record —
        # the crew app serves access details on the job payload instead.
        r = _as(_User(9984, "cleaner", "CT-gate-1")).get(f"/api/properties/{pid}")
        assert r.status_code == 403

        r = _as(_User(9985, "admin")).get(f"/api/properties/{pid}")
        assert r.status_code == 200
        assert r.json()["house_code"] == "7734"
    finally:
        _clear()
