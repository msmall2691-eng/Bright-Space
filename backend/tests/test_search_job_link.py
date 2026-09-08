"""BB-FIND-01: global search must lead to a job you can actually open.

Every job result used to carry path="/schedule". The schedule is a calendar
keyed by date, so a job with a NULL scheduled_date — what a quote converted
without a date becomes ("unscheduled") — never renders there. Search found the
job and then sent the operator to a page it wasn't on: a dead end for precisely
the records most likely to be forgotten. The fix points each job result at its
own detail page, /jobs/{id}, which renders any job regardless of schedule.
"""
from datetime import date, time

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.search import global_search


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Findable Co", email="find@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="H", address="1 Find Rd",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _find_job(db, term, job_id):
    for r in global_search(term, limit=25, db=db)["results"]:
        if r["type"] == "job" and r["id"] == job_id:
            return r
    return None


def test_an_unscheduled_job_links_to_its_own_detail_page(ctx):
    db, c, p = ctx
    j = Job(client_id=c.id, property_id=p.id, title="Zephyr Unscheduled Clean",
            job_type="residential", status="unscheduled", scheduled_date=None,
            cleaner_ids=[])
    db.add(j); db.commit(); db.refresh(j)

    hit = _find_job(db, "zephyr unscheduled", j.id)
    assert hit is not None, "the unscheduled job was not found by search"
    assert hit["path"] == f"/jobs/{j.id}", (
        "search sent the operator to %r, not the job's own page" % hit["path"]
    )
    assert hit["path"] != "/schedule"          # never the calendar it isn't on


def test_a_scheduled_job_also_links_to_its_detail_page(ctx):
    db, c, p = ctx
    j = Job(client_id=c.id, property_id=p.id, title="Zephyr Scheduled Clean",
            job_type="residential", status="scheduled", scheduled_date=date.today(),
            start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=[])
    db.add(j); db.commit(); db.refresh(j)

    hit = _find_job(db, "zephyr scheduled", j.id)
    assert hit is not None
    assert hit["path"] == f"/jobs/{j.id}"
