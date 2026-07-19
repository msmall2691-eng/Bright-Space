"""Off-cadence cleanup: _off_phase_future_jobs must target exactly the
biweekly-drift leftovers — future visits on an OFF cadence week — and never
touch on-phase, past, completed, or reschedule-target visits.

Pure DB reads on SQLite (no generate_jobs, so no ISO-string-into-Date issue).
"""
import uuid
from datetime import date, time, timedelta

import pytest

from database.db import SessionLocal, engine
from database.models import (
    Base, Client, Property, RecurringSchedule, Job, RecurrenceException,
)
from modules.recurring.router import _off_phase_future_jobs
from utils.dates import business_today


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.create_all(bind=engine)
    yield


def _client_property(db):
    c = Client(name=f"Cleanup {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Home", address="1 A St",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    return c, p


def _job(db, client_id, property_id, sched_id, d, status="scheduled"):
    j = Job(
        client_id=client_id, property_id=property_id, recurring_schedule_id=sched_id,
        job_type="residential", title="Clean", scheduled_date=d, start_time=time(9, 0),
        end_time=time(11, 0), status=status,
    )
    db.add(j); db.commit(); db.refresh(j)
    return j


def test_off_phase_future_jobs_targets_only_drift_leftovers():
    db = SessionLocal()
    made = []
    try:
        c, p = _client_property(db)
        today = business_today()
        anchor = today - timedelta(days=today.weekday())  # a Monday = on-phase week

        s = RecurringSchedule(
            client_id=c.id, property_id=p.id, job_type="residential", title="Biweekly Monday",
            address="1 A St", frequency="biweekly", interval_weeks=2,
            days_of_week=[0], day_of_week=0, start_time=time(9, 0), end_time=time(11, 0),
            active=True,
        )
        s.anchor_date = anchor
        db.add(s); db.commit(); db.refresh(s)

        on_phase = _job(db, c.id, p.id, s.id, anchor + timedelta(weeks=2))   # future, on-phase → keep
        off1 = _job(db, c.id, p.id, s.id, anchor + timedelta(weeks=1))       # future, off-week → FLAG
        off2 = _job(db, c.id, p.id, s.id, anchor + timedelta(weeks=3))       # future, off-week → FLAG
        past_off = _job(db, c.id, p.id, s.id, anchor - timedelta(weeks=1))   # past → keep (history)
        done_off = _job(db, c.id, p.id, s.id, anchor + timedelta(weeks=5),
                        status="completed")                                 # terminal → keep
        made = [on_phase, off1, off2, past_off, done_off]

        flagged = {j.id for j in _off_phase_future_jobs(db, s)}
        assert flagged == {off1.id, off2.id}

        # A reschedule exception whose target is an off-week date must protect it.
        ex = RecurrenceException(
            recurring_schedule_id=s.id,
            exception_date=anchor + timedelta(weeks=6),
            exception_type="reschedule",
            rescheduled_date=off1.scheduled_date,
        )
        db.add(ex); db.commit()
        made.append(ex)
        flagged2 = {j.id for j in _off_phase_future_jobs(db, s)}
        assert off1.id not in flagged2
        assert off2.id in flagged2
    finally:
        # Clean up rows this test created.
        for m in made:
            db.delete(m)
        db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_plain_weekly_series_is_never_flagged():
    """Weekly (interval 1) has no off-weeks, so the cleanup must skip it
    entirely even if a stray job sits on an unusual date."""
    db = SessionLocal()
    made = []
    try:
        c, p = _client_property(db)
        today = business_today()
        anchor = today - timedelta(days=today.weekday())
        s = RecurringSchedule(
            client_id=c.id, property_id=p.id, job_type="residential", title="Weekly Monday",
            address="2 B St", frequency="weekly", interval_weeks=1,
            days_of_week=[0], day_of_week=0, start_time=time(9, 0), end_time=time(11, 0),
            active=True,
        )
        s.anchor_date = anchor
        db.add(s); db.commit(); db.refresh(s)
        made.append(_job(db, c.id, p.id, s.id, anchor + timedelta(weeks=1)))
        made.append(_job(db, c.id, p.id, s.id, anchor + timedelta(weeks=2)))
        assert _off_phase_future_jobs(db, s) == []
    finally:
        for m in made:
            db.delete(m)
        db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
