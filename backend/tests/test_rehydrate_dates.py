"""Tests for the job date rehydration endpoint."""
import pytest
from datetime import datetime, date, time
from unittest.mock import Mock, patch, MagicMock
from googleapiclient.errors import HttpError
from database.models import Job
from database.db import SessionLocal


def test_rehydrate_dry_run():
    """Test rehydrate endpoint in dry_run mode — should not write to DB."""
    db = SessionLocal()
    try:
        # Create a job with NULL dates but a valid gcal_event_id
        job = Job(
            client_id=1,
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
        with patch("modules.scheduling.router._get_service") as mock_service:
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
        # Create a job with NULL dates
        job = Job(
            client_id=1,
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
        with patch("modules.scheduling.router._get_service") as mock_service:
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
        # Create a job with NULL dates
        job = Job(
            client_id=1,
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
        with patch("modules.scheduling.router._get_service") as mock_service:
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
            assert job.scheduled_date == "2026-04-07"
            # All-day events should get default 9am-5pm
            assert job.start_time == "09:00:00"
            assert job.end_time == "17:00:00"

    finally:
        db.close()


def test_rehydrate_skips_already_populated():
    """Test rehydrate endpoint skips jobs that are already populated."""
    db = SessionLocal()
    try:
        # Create a job with POPULATED dates
        job = Job(
            client_id=1,
            title="Already Done",
            scheduled_date="2026-04-07",
            start_time="09:00:00",
            end_time="12:00:00",
            status="scheduled",
            gcal_event_id="test_event_789",
            job_type="residential",
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        # Mock the Google Calendar service
        with patch("modules.scheduling.router._get_service") as mock_service:
            mock_events = MagicMock()
            mock_service.return_value.events.return_value = mock_events

            # Call the endpoint
            from modules.scheduling.router import rehydrate_job_dates_from_gcal
            result = rehydrate_job_dates_from_gcal(dry_run=False, db=db)

            # Verify it was skipped
            assert result["updated"] == 0
            assert result["skipped_already_populated"] == 1
            # Google Calendar should not have been called for this job
            mock_events.get.assert_not_called()

    finally:
        db.close()


def test_rehydrate_handles_404():
    """Test rehydrate endpoint handles missing GCal events gracefully."""
    db = SessionLocal()
    try:
        # Create a job with a bogus gcal_event_id
        job = Job(
            client_id=1,
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
        with patch("modules.scheduling.router._get_service") as mock_service:
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
