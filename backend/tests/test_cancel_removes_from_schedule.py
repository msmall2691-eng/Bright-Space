"""Cancelling a job removes it from the schedule everywhere: its visits are
cancelled and its Google Calendar event is deleted (not re-pushed)."""
from datetime import date, time, timedelta
from unittest.mock import patch

from database.db import SessionLocal
from database.models import Client, Property, Job, Visit
from modules.scheduling.router import update_job, JobUpdate


def test_cancel_job_cancels_visits_and_deletes_gcal_event():
    db = SessionLocal()
    try:
        c = Client(name="Cancel Test", email="cx@example.com", status="active")
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
        db.add(p); db.commit(); db.refresh(p)
        d = date.today() + timedelta(days=3)
        job = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Clean",
                  scheduled_date=d, start_time=time(9, 0), end_time=time(12, 0),
                  status="scheduled", gcal_event_id="evt_cancel_1")
        db.add(job); db.commit(); db.refresh(job)
        visit = Visit(job_id=job.id, scheduled_date=d, start_time=time(9, 0), end_time=time(12, 0),
                      status="scheduled")
        db.add(visit); db.commit(); db.refresh(visit)

        with patch("integrations.google_calendar.delete_event", return_value=True) as del_evt:
            update_job(job.id, JobUpdate(status="cancelled"), db=db)

        db.refresh(job); db.refresh(visit)
        assert job.status == "cancelled"
        assert job.gcal_event_id is None          # event removed from Google
        assert del_evt.called                      # delete (not update) was called
        assert visit.status == "cancelled"         # visit dropped from the schedule
    finally:
        db.rollback()
        db.query(Visit).filter(Visit.job_id == job.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
