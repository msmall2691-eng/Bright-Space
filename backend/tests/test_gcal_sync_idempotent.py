"""GCal sync must be idempotent: a poll that finds no real change writes nothing.

Regression for the string-vs-date churn bug — _parse_event_datetime used to
return string dates, so `new_date != job.scheduled_date` (str vs Date column) was
always True and every poll rewrote a string into the column and bumped
jobs_updated. Phase 1 of the reconciliation plan returns real date/time objects.
"""
from datetime import date, time
from unittest.mock import patch, MagicMock

from database.db import SessionLocal
from database.models import Client, Job, Property


def _service_returning(events):
    """A fake Google service whose events().list().execute() yields `events`."""
    svc = MagicMock()
    svc.events.return_value.list.return_value.execute.return_value = {"items": events}
    return svc


def _run_sync(db, events):
    from integrations import gcal_sync
    with patch("integrations.google_calendar._get_service", return_value=_service_returning(events)):
        return gcal_sync.sync_calendar(db, calendar_ids=["primary"])


def test_sync_is_noop_when_nothing_changed():
    db = SessionLocal()
    try:
        client = Client(name="GCal Idem Test", email="idem@example.com")
        db.add(client); db.commit(); db.refresh(client)
        prop = Property(client_id=client.id, name="P", address="1 Test St",
                        property_type="residential", active=True)
        db.add(prop); db.commit(); db.refresh(prop)

        # A job already linked to a GCal event, with proper date/time objects.
        job = Job(
            client_id=client.id, property_id=prop.id, job_type="residential", title="Test Clean",
            scheduled_date=date(2026, 7, 10), start_time=time(10, 0), end_time=time(13, 0),
            address="", gcal_event_id="evt_idem_1", status="scheduled",
        )
        db.add(job); db.commit(); db.refresh(job)

        # The same event coming back from Google — identical date/time/title.
        event = {
            "id": "evt_idem_1",
            "status": "confirmed",
            "summary": "Test Clean",
            "start": {"dateTime": "2026-07-10T10:00:00-04:00"},
            "end": {"dateTime": "2026-07-10T13:00:00-04:00"},
        }

        r1 = _run_sync(db, [event])
        assert r1["jobs_updated"] == 0, "first identical poll should not rewrite the job"
        r2 = _run_sync(db, [event])
        assert r2["jobs_updated"] == 0, "second identical poll should also be a no-op"

        # And the job's columns are still real date/time objects (not strings).
        db.refresh(job)
        assert job.scheduled_date == date(2026, 7, 10)
        assert job.start_time == time(10, 0)
        assert job.end_time == time(13, 0)
    finally:
        db.rollback()
        db.query(Job).filter(Job.gcal_event_id == "evt_idem_1").delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_sync_applies_a_real_date_change_once():
    """When Google really moves the event, the job is updated — but only the once."""
    db = SessionLocal()
    try:
        client = Client(name="GCal Move Test", email="move@example.com")
        db.add(client); db.commit(); db.refresh(client)
        prop = Property(client_id=client.id, name="P", address="1 Test St",
                        property_type="residential", active=True)
        db.add(prop); db.commit(); db.refresh(prop)
        job = Job(
            client_id=client.id, property_id=prop.id, job_type="residential", title="Move Clean",
            scheduled_date=date(2026, 7, 10), start_time=time(10, 0), end_time=time(13, 0),
            address="", gcal_event_id="evt_move_1", status="scheduled",
        )
        db.add(job); db.commit(); db.refresh(job)

        moved = {
            "id": "evt_move_1",
            "status": "confirmed",
            "summary": "Move Clean",
            "start": {"dateTime": "2026-07-12T10:00:00-04:00"},
            "end": {"dateTime": "2026-07-12T13:00:00-04:00"},
        }
        r1 = _run_sync(db, [moved])
        assert r1["jobs_updated"] == 1
        db.refresh(job)
        assert job.scheduled_date == date(2026, 7, 12)
        # Re-polling the moved event is now a no-op (no churn).
        r2 = _run_sync(db, [moved])
        assert r2["jobs_updated"] == 0
    finally:
        db.rollback()
        db.query(Job).filter(Job.gcal_event_id == "evt_move_1").delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_sync_does_not_churn_utc_z_form_event():
    """A UTC 'Z' event must read back as the business wall-clock time, not the
    raw UTC hour — otherwise it churns every poll and corrupts the stored time.

    Regression for the two-parser disagreement: the rehydrate endpoint converts
    13:00Z to 09:00 EDT, but sync_calendar used to take the raw 13:00. So the
    job, correctly stored at 09:00, was overwritten to 13:00 on the next poll
    (and flip-flopped forever). Both paths now agree on the Eastern wall clock.
    """
    db = SessionLocal()
    try:
        client = Client(name="GCal Z Test", email="ztz@example.com")
        db.add(client); db.commit(); db.refresh(client)
        prop = Property(client_id=client.id, name="P", address="1 Test St",
                        property_type="residential", active=True)
        db.add(prop); db.commit(); db.refresh(prop)
        # Job stored at the correct LOCAL time (09:00 EDT == 13:00Z).
        job = Job(
            client_id=client.id, property_id=prop.id, job_type="residential", title="Z Clean",
            scheduled_date=date(2026, 7, 10), start_time=time(9, 0), end_time=time(12, 0),
            address="", gcal_event_id="evt_z_1", status="scheduled",
        )
        db.add(job); db.commit(); db.refresh(job)

        # Same event coming back from Google in UTC 'Z' form.
        event = {
            "id": "evt_z_1",
            "status": "confirmed",
            "summary": "Z Clean",
            "start": {"dateTime": "2026-07-10T13:00:00Z"},
            "end": {"dateTime": "2026-07-10T16:00:00Z"},
        }
        r1 = _run_sync(db, [event])
        assert r1["jobs_updated"] == 0, "13:00Z must match the stored 09:00 EDT — no churn"
        r2 = _run_sync(db, [event])
        assert r2["jobs_updated"] == 0

        db.refresh(job)
        # The stored local time is preserved, NOT overwritten to the UTC hour.
        assert job.scheduled_date == date(2026, 7, 10)
        assert job.start_time == time(9, 0)
        assert job.end_time == time(12, 0)
    finally:
        db.rollback()
        db.query(Job).filter(Job.gcal_event_id == "evt_z_1").delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit()
        db.close()
