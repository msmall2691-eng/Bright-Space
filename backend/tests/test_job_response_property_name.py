"""GET /api/jobs must return property_name so the frontend timeline / week
view can render the property label without a second fetch. Added as part of
the Job/Visit unification (PR-B): the field used to come from
visit.property.name; jobs carries it directly now.
"""
from datetime import date, time

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import get_jobs


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Property Name Test", email="pn@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="The Blueberry House",
                 address="7 Blueberry Ln", property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Deep clean",
            job_type="residential",
            scheduled_date=date.today(),
            start_time=time(10, 0), end_time=time(13, 0),
            status="scheduled", cleaner_ids=[])
    db.add(j); db.commit(); db.refresh(j)
    yield db, c, p, j
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_get_jobs_includes_property_name(ctx):
    db, _c, p, j = ctx
    rows = get_jobs(property_id=p.id, db=db, org_id=None)
    ours = next((r for r in rows if r["id"] == j.id), None)
    assert ours is not None
    assert ours["property_id"] == p.id
    assert ours["property_name"] == "The Blueberry House"


def test_property_name_is_none_when_no_property(ctx):
    # The Job model requires property_id, so this asserts the field survives
    # a Job whose property has been unlinked at the DB level (should be
    # None, not a KeyError).
    db, _c, _p, j = ctx
    from modules.scheduling.router import job_to_dict
    j.property_id = None
    d = job_to_dict(j, effective_date=j.scheduled_date, property_name=None)
    assert d["property_name"] is None
