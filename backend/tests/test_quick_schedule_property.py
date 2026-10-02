"""Tests for property defaulting on POST /api/jobs (Quick-schedule support).

The one-screen booking flow lets the user skip Property. create_job resolves to
the client's existing property, or auto-creates one from the client's/job's
address (workflow guardrail — a job always hangs off a property). A client with
no property AND no address now 422s instead of silently making an empty-address
property; that case is covered in test_require_property.py.
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import create_job, JobCreate


@pytest.fixture
def bare_client():
    db = SessionLocal()
    # Has an address but no Property yet — the real quick-schedule case, where
    # create_job auto-creates the property from that address.
    c = Client(name="Quick Sched Test", email="quick@example.com", status="active",
               address="100 Quick St", org_id=None)
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit()
    db.close()


def _payload(client_id):
    return JobCreate(
        client_id=client_id, title="Quick Clean", job_type="residential",
        scheduled_date="2026-12-15", start_time="09:00", end_time="12:00",
    )


def test_creates_default_property_when_none(bare_client):
    db, c = bare_client
    out = create_job(_payload(c.id), db=db, org_id=None)
    assert out["property_id"] is not None
    prop = db.query(Property).filter(Property.id == out["property_id"]).first()
    assert prop is not None and prop.client_id == c.id


def test_reuses_existing_property(bare_client):
    db, c = bare_client
    out1 = create_job(_payload(c.id), db=db, org_id=None)
    out2 = create_job(_payload(c.id), db=db, org_id=None)
    # Second booking reuses the property created by the first — no duplicate.
    assert out1["property_id"] == out2["property_id"]
    props = db.query(Property).filter(Property.client_id == c.id).count()
    assert props == 1
