"""GET /api/jobs/gcal-sync-status counts upcoming jobs not yet on Google.

Drives the Calendar page's reconcile banner.
"""
import pytest
from datetime import date, timedelta, time

from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import gcal_sync_status


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="GCal Sync Test", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _job(db, c, p, **kw):
    kw.setdefault("status", "scheduled")
    j = Job(client_id=c.id, property_id=p.id, title="J", job_type="residential",
            start_time=time(9, 0), end_time=time(11, 0), **kw)
    db.add(j); db.commit(); db.refresh(j)
    return j


def test_counts_only_unsynced_future_jobs(ctx):
    db, c, p = ctx
    future = date.today() + timedelta(days=3)
    past = date.today() - timedelta(days=3)
    before = gcal_sync_status(db=db)["unsynced_count"]  # global count; measure the delta

    _job(db, c, p, scheduled_date=future, gcal_event_id=None)          # +1 (counts)
    _job(db, c, p, scheduled_date=future, gcal_event_id="evt_x")       # already synced — skip
    _job(db, c, p, scheduled_date=past, gcal_event_id=None)            # past — skip
    _job(db, c, p, scheduled_date=future, gcal_event_id=None, status="completed")  # not scheduled — skip

    out = gcal_sync_status(db=db)
    assert out["unsynced_count"] - before == 1
    assert "configured" in out
