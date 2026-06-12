"""Jobs are fully editable after creation (June 12): title, type, property,
address, status — and property_id actually persists (the edit modal always
sent it, but JobUpdate never declared it, so pydantic silently dropped it).
"""
import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import update_job, JobUpdate


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Job Edit Test", email="jobedit@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p1 = Property(client_id=c.id, name="P1", address="1 First St", property_type="residential", active=True)
    p2 = Property(client_id=c.id, name="P2", address="2 Second Ave", property_type="commercial", active=True)
    db.add_all([p1, p2]); db.commit(); db.refresh(p1); db.refresh(p2)
    j = Job(client_id=c.id, property_id=p1.id, title="Original title",
            job_type="residential", status="scheduled", address="1 First St")
    db.add(j); db.commit(); db.refresh(j)
    yield db, c, p1, p2, j
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_every_job_field_is_editable(ctx):
    db, c, p1, p2, j = ctx
    update_job(j.id, JobUpdate(
        title="Renamed — deep clean",
        job_type="commercial",
        property_id=p2.id,
        address="2 Second Ave",
        status="in_progress",
        notes="bring ladder",
    ), db=db)
    db.refresh(j)
    assert j.title == "Renamed — deep clean"          # title was display-only in the UI
    assert j.job_type == "commercial"
    assert j.property_id == p2.id                     # was silently dropped before
    assert j.address == "2 Second Ave"
    assert j.status == "in_progress"
    assert j.notes == "bring ladder"


def test_invalid_job_type_and_status_are_rejected(ctx):
    db, c, p1, p2, j = ctx
    with pytest.raises(HTTPException) as ei:
        update_job(j.id, JobUpdate(job_type="lawn_mowing"), db=db)
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        update_job(j.id, JobUpdate(status="snoozed"), db=db)
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        update_job(j.id, JobUpdate(property_id=99999999), db=db)
    assert ei.value.status_code == 404
    db.refresh(j)
    assert j.job_type == "residential" and j.status == "scheduled"  # untouched
