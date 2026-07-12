"""Tests for the job date rehydration endpoint."""
import pytest
from datetime import datetime, date, time
from unittest.mock import Mock, patch, MagicMock
from googleapiclient.errors import HttpError
from sqlalchemy import inspect, text
from database.models import Job, Client, Property, ICalEvent, PropertyIcal, RecurringSchedule
from database.db import SessionLocal, engine


def _seed_client_property(db):
    """Create a client + property and return their ids (every Job needs both)."""
    c = Client(name="Rehydrate Test", status="active")
    db.add(c); db.commit(); db.refresh(c)
    pr = Property(client_id=c.id, name="P", address="123 Test St",
                  property_type="residential", active=True)
    db.add(pr); db.commit(); db.refresh(pr)
    return c.id, pr.id


@pytest.fixture(autouse=True)
def _clean_jobs():
    """Reset jobs/clients/properties around each test. The rehydrate endpoint
    scans ALL null-date jobs in the DB, so leftover rows from a prior test
    (e.g. the dry-run job that's intentionally not written) would otherwise
    inflate the next test's counts on the shared test DB."""
    yield
    db = SessionLocal()
    try:
        # This is a genuinely global reset (every Job/Property/Client in the
        # whole DB, not just rows this test created) — the rehydrate endpoint
        # itself scans ALL null-date jobs, so any leftover row from ANY test
        # in the whole session (not just this file) would inflate the next
        # test's counts. That means this cleanup can't assume it's the only
        # thing that ever touched these clients/properties, so instead of
        # hand-listing every table with a client_id/property_id (easy to
        # miss one, as happened here), discover them dynamically the same
        # way scripts/cleanup_ical_turnover_duplicates.py does.
        #
        # Job.ical_event_id -> ical_events.id AND ical_events.job_id ->
        # jobs.id is a genuine bidirectional cycle — neither table can be
        # deleted first while the other still references it, so both FK
        # columns are nulled out before either table is deleted. Same idea
        # for ical_events.property_ical_id -> property_icals.id.
        db.query(Job).update({Job.ical_event_id: None}, synchronize_session=False)
        db.query(ICalEvent).update(
            {ICalEvent.job_id: None, ICalEvent.property_ical_id: None},
            synchronize_session=False,
        )
        db.commit()

        insp = inspect(engine)
        keep = {"clients", "properties", "jobs"}
        dependent_tables = [
            table for table in insp.get_table_names()
            if table not in keep
            and {"client_id", "property_id", "job_id"} & {c["name"] for c in insp.get_columns(table)}
        ]
        # Order among these isn't fully known (e.g. a table could reference
        # another dependent table, not just clients/properties/jobs
        # directly), so retry in passes: each pass clears whatever it can,
        # and a table whose row still has a live reference just waits for a
        # later pass once whatever was blocking it is gone. Bounded so a
        # genuinely unresolvable case fails loudly instead of looping forever.
        remaining = list(dependent_tables)
        for _ in range(len(dependent_tables) + 1):
            if not remaining:
                break
            still_stuck = []
            for table in remaining:
                try:
                    db.execute(text(f"DELETE FROM {table}"))
                    db.commit()
                except Exception:
                    db.rollback()
                    still_stuck.append(table)
            remaining = still_stuck
        assert not remaining, f"could not clear dependent table(s), likely a new FK cycle: {remaining}"

        db.query(Job).delete(synchronize_session=False)
        db.query(Property).delete(synchronize_session=False)
        db.query(Client).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_rehydrate_dry_run():
    """Test rehydrate endpoint in dry_run mode — should not write to DB."""
    db = SessionLocal()
    try:
        cid, pid = _seed_client_property(db)
        # Create a job with NULL dates but a valid gcal_event_id
        job = Job(
            client_id=cid, property_id=pid,
            title="Test Job",
            scheduled_date=None,  # This is NULL
            start_time=None,
            end_time=None,
            status="scheduled",
            gcal_event_id="test_event_123",
            job_type="residential",
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        job_id = job.id

        # Mock the Google Calendar service
        with patch("integrations.google_calendar._get_service") as mock_service:
            mock_events = MagicMock()
            mock_service.return_value.events.return_value = mock_events

            # Mock the event response
            mock_event = {
                "start": {
                    "dateTime": "2026-04-07T13:00:00Z"
                },
                "end": {
                    "dateTime": "2026-04-07T17:00:00Z"
                },
            }
            mock_events.get.return_value.execute.return_value = mock_event

            # Call the endpoint with dry_run=True
            from modules.scheduling.router import rehydrate_job_dates_from_gcal
            result = rehydrate_job_dates_from_gcal(dry_run=True, db=db)

            # Verify the response
            assert result["dry_run"] is True
            assert result["updated"] == 1
            assert len(result["sample_updates"]) >= 1

            # Verify the DB was NOT written to
            db.refresh(job)
            assert job.scheduled_date is None
            assert job.start_time is None
            assert job.end_time is None

    finally:
        db.close()


def test_rehydrate_write_timed_event():
    """Test rehydrate endpoint writes timed event dates to DB."""
    db = SessionLocal()
    try:
        cid, pid = _seed_client_property(db)
        # Create a job with NULL dates
        job = Job(
            client_id=cid, property_id=pid,
            title="Test Job",
            scheduled_date=None,
            start_time=None,
            end_time=None,
            status="scheduled",
            gcal_event_id="test_event_456",
            job_type="residential",
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        job_id = job.id

        # Mock the Google Calendar service
        with patch("integrations.google_calendar._get_service") as mock_service:
            mock_events = MagicMock()
            mock_service.return_value.events.return_value = mock_events

            # Mock a timed event response
            mock_event = {
                "start": {
                    "dateTime": "2026-04-07T13:00:00Z"
                },
                "end": {
                    "dateTime": "2026-04-07T17:00:00Z"
                },
            }
            mock_events.get.return_value.execute.return_value = mock_event

            # Call the endpoint with dry_run=False
            from modules.scheduling.router import rehydrate_job_dates_from_gcal
            result = rehydrate_job_dates_from_gcal(dry_run=False, db=db)

            # Verify the response
            assert result["dry_run"] is False
            assert result["updated"] == 1
            assert result["errors"] == []

            # Verify the DB WAS written to
            db.refresh(job)
            assert job.scheduled_date is not None
            assert job.start_time is not None
            assert job.end_time is not None
            # The date should be in America/New_York timezone (UTC-4 in April)
            # 2026-04-07T13:00:00Z = 2026-04-07T09:00:00-04:00 (EDT)
            assert "2026-04-07" in str(job.scheduled_date)

    finally:
        db.close()


def test_rehydrate_all_day_event():
    """Test rehydrate endpoint handles all-day events."""
    db = SessionLocal()
    try:
        cid, pid = _seed_client_property(db)
        # Create a job with NULL dates
        job = Job(
            client_id=cid, property_id=pid,
            title="All Day Job",
            scheduled_date=None,
            start_time=None,
            end_time=None,
            status="scheduled",
            gcal_event_id="test_event_allday",
            job_type="residential",
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        # Mock the Google Calendar service
        with patch("integrations.google_calendar._get_service") as mock_service:
            mock_events = MagicMock()
            mock_service.return_value.events.return_value = mock_events

            # Mock an all-day event response (no dateTime, just date)
            mock_event = {
                "start": {
                    "date": "2026-04-07"
                },
                "end": {
                    "date": "2026-04-08"
                },
            }
            mock_events.get.return_value.execute.return_value = mock_event

            # Call the endpoint
            from modules.scheduling.router import rehydrate_job_dates_from_gcal
            result = rehydrate_job_dates_from_gcal(dry_run=False, db=db)

            # Verify
            assert result["updated"] == 1
            db.refresh(job)
            assert job.scheduled_date == date(2026, 4, 7)
            # All-day events should get default 9am-5pm
            assert job.start_time == time(9, 0)
            assert job.end_time == time(17, 0)

    finally:
        db.close()


def test_rehydrate_skips_already_populated():
    """Test rehydrate endpoint skips jobs that are already populated."""
    db = SessionLocal()
    try:
        cid, pid = _seed_client_property(db)
        # Create a job with POPULATED dates
        job = Job(
            client_id=cid, property_id=pid,
            title="Already Done",
            scheduled_date=date(2026, 4, 7),
            start_time=time(9, 0),
            end_time=time(12, 0),
            status="scheduled",
            gcal_event_id="test_event_789",
            job_type="residential",
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        # Mock the Google Calendar service
        with patch("integrations.google_calendar._get_service") as mock_service:
            mock_events = MagicMock()
            mock_service.return_value.events.return_value = mock_events

            # Call the endpoint
            from modules.scheduling.router import rehydrate_job_dates_from_gcal
            result = rehydrate_job_dates_from_gcal(dry_run=False, db=db)

            # Verify it was left alone: the query only selects null-date jobs, so
            # an already-populated job is never fetched or updated, and Google
            # Calendar is never called for it.
            assert result["updated"] == 0
            mock_events.get.assert_not_called()

    finally:
        db.close()


def test_rehydrate_handles_404():
    """Test rehydrate endpoint handles missing GCal events gracefully."""
    db = SessionLocal()
    try:
        cid, pid = _seed_client_property(db)
        # Create a job with a bogus gcal_event_id
        job = Job(
            client_id=cid, property_id=pid,
            title="Missing Event",
            scheduled_date=None,
            start_time=None,
            end_time=None,
            status="scheduled",
            gcal_event_id="nonexistent_event",
            job_type="residential",
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        # Mock the Google Calendar service to raise 404
        with patch("integrations.google_calendar._get_service") as mock_service:
            mock_events = MagicMock()
            mock_service.return_value.events.return_value = mock_events

            # Simulate a 404 error
            from googleapiclient.errors import HttpError
            mock_error = HttpError(MagicMock(status=404), b"Not Found")
            mock_events.get.return_value.execute.side_effect = mock_error

            # Call the endpoint
            from modules.scheduling.router import rehydrate_job_dates_from_gcal
            result = rehydrate_job_dates_from_gcal(dry_run=False, db=db)

            # Verify the error was caught
            assert result["updated"] == 0
            assert len(result["errors"]) == 1
            assert result["errors"][0]["job_id"] == job.id

            # Verify the job was not modified
            db.refresh(job)
            assert job.scheduled_date is None

    finally:
        db.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
