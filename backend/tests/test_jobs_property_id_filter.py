"""Issue #91 regression: /api/jobs?property_id=N must actually filter server-side.

The Property Detail page relied on this filter; when the handler ignored it
the page happily rendered every job in the workspace and misled the operator
into thinking jobs belonged to a property that they didn't. Pin the filter so
a future refactor can't silently drop it again.
"""
from datetime import date, time

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import get_jobs


@pytest.fixture
def two_props():
    db = SessionLocal()
    c = Client(name="Prop Filter Test", email="propfilter@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)

    p1 = Property(client_id=c.id, name="Pier House",
                  address="1 Pier St", property_type="residential", active=True)
    p2 = Property(client_id=c.id, name="Kerryman Circle",
                  address="18 Kerryman Cir", property_type="residential", active=True)
    db.add_all([p1, p2]); db.commit(); db.refresh(p1); db.refresh(p2)

    j1 = Job(client_id=c.id, property_id=p1.id, title="Turnover",
             job_type="str_turnover", scheduled_date=date.today(),
             start_time=time(10, 0), end_time=time(13, 0),
             status="scheduled", cleaner_ids=[])
    j2 = Job(client_id=c.id, property_id=p2.id, title="Monthly",
             job_type="residential", scheduled_date=date.today(),
             start_time=time(14, 0), end_time=time(16, 0),
             status="scheduled", cleaner_ids=[])
    db.add_all([j1, j2]); db.commit(); db.refresh(j1); db.refresh(j2)

    yield db, c, p1, p2, j1, j2

    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_property_id_filter_isolates_that_property(two_props):
    db, _c, p1, _p2, j1, j2 = two_props
    rows = get_jobs(property_id=p1.id, db=db, org_id=None)
    ids = {r["id"] for r in rows}
    assert j1.id in ids
    assert j2.id not in ids


def test_no_property_id_returns_both(two_props):
    db, _c, _p1, _p2, j1, j2 = two_props
    rows = get_jobs(db=db, org_id=None)
    ids = {r["id"] for r in rows}
    assert j1.id in ids and j2.id in ids
