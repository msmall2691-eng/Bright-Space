"""A job's client must stay consistent with its property's client.

Three guards, all so job.client_id never silently disagrees with
property.client_id (which would mis-attribute the visit on the crew card,
invoices and calendar):

1. create_job rejects a supplied property that belongs to a different client
   (mirrors the guard update_job already had).
2. Reassigning a property to a new client re-points its LIVE jobs and recurring
   schedules to that client; COMPLETED/CANCELLED jobs stay put (history).
3. The Tidy Up scan flags LIVE jobs whose client disagrees with their property.
"""
from datetime import time, timedelta

import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Property, Job, RecurringSchedule
from utils.dates import business_today


@pytest.fixture
def ctx():
    db = SessionLocal()
    a = Client(name="Client A", email="a@example.com", status="active", org_id=1)
    b = Client(name="Client B", email="b@example.com", status="active", org_id=1)
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    prop = Property(client_id=a.id, org_id=1, name="1 Elm", address="1 Elm St",
                    property_type="residential", active=True)
    db.add(prop); db.commit(); db.refresh(prop)
    created = {"clients": [a.id, b.id], "props": [prop.id]}
    yield db, a, b, prop, created
    db.rollback()
    db.query(Job).filter(Job.property_id.in_(created["props"])).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.property_id.in_(created["props"])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(created["props"])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(created["clients"])).delete(synchronize_session=False)
    db.commit(); db.close()


def _job(db, client_id, property_id, status, title="Clean"):
    j = Job(client_id=client_id, property_id=property_id, job_type="residential",
            title=title, status=status, org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    return j


def test_create_job_rejects_a_property_owned_by_another_client(ctx):
    db, a, b, prop, _ = ctx  # prop belongs to A
    from modules.scheduling.router import create_job, JobCreate
    payload = JobCreate(
        client_id=b.id,                 # job is for B...
        title="Wrong owner",
        job_type="residential",
        scheduled_date=(business_today() + timedelta(days=3)).isoformat(),
        start_time="09:00", end_time="11:00",
        property_id=prop.id,            # ...but property belongs to A
    )
    with pytest.raises(HTTPException) as ei:
        create_job(payload, db=db, org_id=1)
    assert ei.value.status_code == 400
    assert "different client" in str(ei.value.detail).lower()


def test_reassign_repoints_live_work_and_keeps_history(ctx):
    db, a, b, prop, _ = ctx
    live = _job(db, a.id, prop.id, "scheduled", "Upcoming")
    done = _job(db, a.id, prop.id, "completed", "Past")
    rec = RecurringSchedule(
        client_id=a.id, property_id=prop.id, org_id=1, job_type="residential",
        title="Weekly", address="1 Elm St", frequency="weekly", day_of_week=2,
        start_time=time(9, 0), end_time=time(11, 0),
    )
    db.add(rec); db.commit(); db.refresh(rec)

    from modules.properties.router import update_property, PropertyUpdate
    result = update_property(prop.id, PropertyUpdate(client_id=b.id), db=db, org_id=1)
    assert result.get("reassigned") == {"jobs": 1, "recurring": 1}

    db.expire_all()
    assert db.query(Job).filter(Job.id == live.id).one().client_id == b.id   # live follows
    assert db.query(Job).filter(Job.id == done.id).one().client_id == a.id   # history stays
    assert db.query(RecurringSchedule).filter(RecurringSchedule.id == rec.id).one().client_id == b.id
    assert db.query(Property).filter(Property.id == prop.id).one().client_id == b.id


def test_scan_flags_live_client_property_mismatch_only(ctx):
    db, a, b, prop, _ = ctx  # prop belongs to A
    # Drifted jobs: property is A's, but these jobs say B.
    drift_live = _job(db, b.id, prop.id, "scheduled", "Drifted live")
    _job(db, b.id, prop.id, "completed", "Drifted but finished")  # excluded (history)
    _job(db, a.id, prop.id, "scheduled", "Consistent")           # not a mismatch

    from modules.cleanup.router import cleanup_scan
    out = cleanup_scan(db=db, org_id=1)
    flag = out["quality"]["client_property_mismatch"]
    ids = {s["job_id"] for s in flag["samples"]}
    assert drift_live.id in ids, "a live drifted job must be flagged"
    # The completed drift and the consistent job must NOT be flagged.
    titles = {s["title"] for s in flag["samples"]}
    assert "Drifted but finished" not in titles
    assert "Consistent" not in titles
