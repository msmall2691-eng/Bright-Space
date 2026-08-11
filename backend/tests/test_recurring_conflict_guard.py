"""Recurring generation must not silently double-book a cleaner.

Before the fix, generate_jobs inserted each occurrence with the schedule's full
crew and skipped the conflict / time-off / capacity guards the one-off create
path runs — so a series could book a cleaner who's already busy that day every
cycle. The fix drops only the conflicting cleaner from that occurrence (the job
is still created, just unassigned, so it surfaces for reassignment — never a
skipped cleaning, per the scheduling-invariants contract R7).
"""
from datetime import time, timedelta

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, RecurringSchedule, Activity
from modules.recurring.router import generate_jobs
from utils.dates import business_today


@pytest.fixture
def ids(monkeypatch):
    # Keep the test offline + fast: neutralize the Google Calendar push that
    # generate_jobs fires for each new occurrence (function-local import, so we
    # patch the source module).
    import integrations.google_calendar as gcal
    monkeypatch.setattr(gcal, "create_event", lambda *a, **k: None)

    tracked = {"clients": [], "properties": [], "jobs": [], "scheds": []}
    yield tracked
    db = SessionLocal()
    if tracked["scheds"]:
        db.query(Job).filter(Job.recurring_schedule_id.in_(tracked["scheds"])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(tracked["jobs"] or [0])).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id.in_(tracked["scheds"] or [0])).delete(synchronize_session=False)
    db.query(Activity).filter(Activity.client_id.in_(tracked["clients"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(tracked["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(tracked["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_recurring_drops_conflicting_cleaner_keeps_clear_days(ids):
    db = SessionLocal()
    try:
        c = Client(name="Rec Guard", org_id=1)
        db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
        p = Property(client_id=c.id, name="5 Oak", address="5 Oak", property_type="residential", org_id=1)
        db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)

        today = business_today()
        tomorrow = today + timedelta(days=1)

        # Cleaner "c1" is already booked tomorrow 10:30–11:30, which overlaps the
        # series' 10:00–12:00 slot.
        conflict = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Existing",
                       scheduled_date=tomorrow, start_time=time(10, 30), end_time=time(11, 30),
                       cleaner_ids=["c1"], status="scheduled", org_id=1)
        db.add(conflict); db.commit(); db.refresh(conflict); ids["jobs"].append(conflict.id)

        sched = RecurringSchedule(
            client_id=c.id, property_id=p.id, job_type="residential", title="Daily Clean",
            address="5 Oak", frequency="daily", interval_weeks=1, day_of_week=0, days_of_week=[],
            day_of_month=None, start_time=time(10, 0), end_time=time(12, 0), cleaner_ids=["c1"],
            active=True, generate_weeks_ahead=1, anchor_date=today, series_start_date=today, org_id=1)
        db.add(sched); db.commit(); db.refresh(sched); ids["scheds"].append(sched.id)

        generate_jobs(db, sched)

        occ = {j.scheduled_date: j for j in
               db.query(Job).filter(Job.recurring_schedule_id == sched.id).all()}
        assert today in occ and tomorrow in occ, "expected occurrences for today and tomorrow"

        # Conflict day: c1 dropped → occurrence created UNASSIGNED (never skipped).
        assert list(occ[tomorrow].cleaner_ids or []) == [], "the busy cleaner should be dropped"
        assert occ[tomorrow].status == "scheduled", "the cleaning is still scheduled, just unassigned"

        # Clear day: the crew is kept.
        assert "c1" in [str(x) for x in (occ[today].cleaner_ids or [])], "a clear day keeps the crew"
    finally:
        db.close()
