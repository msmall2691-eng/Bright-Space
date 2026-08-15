"""Recurring Doctor (owner screenshot, Aug 2026): the live list carried a
series titled just "biweekly", duplicate pairs, an ended series still showing,
and paused leftovers. audit_series must name each disease with a suggested
fix and never write anything.

(no_time_set is exercised in production by schema-drifted NULL times; the test
schema enforces the model's NOT NULL so that code path isn't seedable here.)
"""
import uuid
from datetime import time, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, RecurringSchedule, Job
from services.recurring_guards import audit_series
from utils.dates import business_today


@pytest.fixture
def made():
    ids = {"clients": [], "properties": [], "schedules": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id.in_(ids["schedules"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(db, made, name="Health Client"):
    c = Client(name=f"{name} {uuid.uuid4().hex[:5]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    made["clients"].append(c.id)
    return c


def _mk_prop(db, made, client_id):
    p = Property(client_id=client_id, name="1 Health St", address="1 Health St")
    db.add(p); db.commit(); db.refresh(p)
    made["properties"].append(p.id)
    return p


def _mk_sched(db, made, client_id, *, title="Residential Clean — Weekly", active=True,
              property_id=None, days=(1,), end_date=None, start=time(9, 0)):
    s = RecurringSchedule(
        client_id=client_id, job_type="residential", title=title,
        address="1 Health St", frequency="weekly", interval_weeks=1,
        day_of_week=days[0], days_of_week=list(days),
        start_time=start, end_time=time(12, 0),
        active=active, property_id=property_id, series_end_date=end_date,
    )
    db.add(s); db.commit(); db.refresh(s)
    made["schedules"].append(s.id)
    return s


def _mk_upcoming_job(db, made, sched, prop):
    j = Job(client_id=sched.client_id, property_id=prop.id, title="Visit",
            job_type="residential", status="scheduled",
            scheduled_date=business_today() + timedelta(days=3),
            recurring_schedule_id=sched.id)
    db.add(j); db.commit(); db.refresh(j)
    made["jobs"].append(j.id)
    return j


def _issue_for(report, sid):
    return next((i for i in report["issues"] if i["schedule_id"] == sid), None)


def _codes(issue):
    return {p["code"] for p in issue["problems"]} if issue else set()


def test_healthy_series_is_not_listed(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=p.id)
    _mk_upcoming_job(db, made, s, p)
    report = audit_series(db, None)
    assert _issue_for(report, s.id) is None
    assert report["healthy"] >= 1
    db.close()


def test_duplicate_pair_grouped_and_flagged(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    a = _mk_sched(db, made, c.id, property_id=p.id, days=(1, 3))
    b = _mk_sched(db, made, c.id, property_id=p.id, days=(3, 5))  # overlaps on Wed
    report = audit_series(db, None)
    assert sorted([a.id, b.id]) in report["duplicate_groups"]
    assert "duplicate" in _codes(_issue_for(report, a.id))
    assert "duplicate" in _codes(_issue_for(report, b.id))
    db.close()


def test_ended_but_active_and_junk_title(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=p.id, title="biweekly",
                  end_date=business_today() - timedelta(days=7))
    report = audit_series(db, None)
    codes = _codes(_issue_for(report, s.id))
    assert "ended_but_active" in codes
    assert "junk_title" in codes
    # Ended series must NOT read as a live duplicate of anything.
    assert all(s.id not in g for g in report["duplicate_groups"])
    # The rename suggestion leads with the client's actual name.
    prob = next(p_ for p_ in _issue_for(report, s.id)["problems"] if p_["code"] == "junk_title")
    assert c.name.split()[0] in prob["suggestion"]
    db.close()


def test_active_no_upcoming_and_stale_paused(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    stalled = _mk_sched(db, made, c.id, property_id=p.id)              # active, 0 upcoming
    leftover = _mk_sched(db, made, c.id, property_id=p.id, days=(5,), active=False)
    report = audit_series(db, None)
    assert "active_no_upcoming" in _codes(_issue_for(report, stalled.id))
    lo = _issue_for(report, leftover.id)
    assert "stale_paused" in _codes(lo)
    stale = next(p_ for p_ in lo["problems"] if p_["code"] == "stale_paused")
    assert stale["destructive"] is True  # UI must escalate the confirm
    db.close()


def test_missing_property_link_is_flagged_info(made):
    db = SessionLocal()
    c = _mk_client(db, made)
    p = _mk_prop(db, made, c.id)
    s = _mk_sched(db, made, c.id, property_id=None)
    _mk_upcoming_job(db, made, s, p)
    report = audit_series(db, None)
    issue = _issue_for(report, s.id)
    assert "no_property" in _codes(issue)
    prob = next(p_ for p_ in issue["problems"] if p_["code"] == "no_property")
    assert prob["severity"] == "info" and prob["destructive"] is False
    db.close()
