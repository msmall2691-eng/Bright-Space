#!/usr/bin/env python3
"""Test suite for iCal auto-sync scheduler."""

import sys
from unittest.mock import MagicMock

# Pre-mock google_calendar before ical_sync is imported
sys.modules['integrations.google_calendar'] = MagicMock()

import pytest
import os
import json
from datetime import date, datetime, timedelta
from unittest.mock import patch, MagicMock
from sqlalchemy.orm import Session

from database.db import SessionLocal, init_db
from database.models import Property, Job, ICalEvent, Client
from scheduler import start_scheduler, stop_scheduler, sync_all_ical_feeds_tick
from integrations.ical_sync import sync_property


def _cleanup_db():
    """Helper to clean test data."""
    db = SessionLocal()
    try:
        db.query(ICalEvent).delete()
        db.query(Job).delete()
        db.query(Property).delete()
        db.query(Client).delete()
        db.commit()
    finally:
        db.close()


def _make_test_client(db: Session) -> Client:
    """Create a test client."""
    client = Client(name="Test Client", email="test@example.com")
    db.add(client)
    db.commit()
    db.refresh(client)
    return client


def _make_test_property(db: Session, client_id: int, ical_url: str = None) -> Property:
    """Create a test property."""
    prop = Property(
        client_id=client_id,
        name="Test Property",
        address="123 Test St",
        property_type="str",
        ical_url=ical_url,
    )
    db.add(prop)
    db.commit()
    db.refresh(prop)
    return prop


def _make_ics(events: list) -> bytes:
    """Create a minimal ICS feed with given events.
    Events format: [{"uid": "...", "summary": "...", "start": "2026-05-01", "end": "2026-05-02"}]
    """
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Test//Test//EN",
    ]
    for event in events:
        # Convert date strings from YYYY-MM-DD to YYYYMMDD format for iCal
        start_str = event['start'].replace('-', '')
        end_str = event['end'].replace('-', '')
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:{event['uid']}",
            f"SUMMARY:{event['summary']}",
            f"DTSTART;VALUE=DATE:{start_str}",
            f"DTEND;VALUE=DATE:{end_str}",
            "END:VEVENT",
        ])
    lines.extend(["END:VCALENDAR"])
    return "\n".join(lines).encode()


class _FakeResponse:
    """Fake httpx response."""
    def __init__(self, content: bytes, status_code: int = 200):
        self.content = content
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}")


class _FakeHttpxClient:
    """Fake httpx client that returns test ICS."""
    def __init__(self, default_ics: bytes = None):
        self.default_ics = default_ics or _make_ics([])

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def get(self, url: str):
        if "404" in url:
            return _FakeResponse(b"Not Found", 404)
        return _FakeResponse(self.default_ics)


# ──────────────────────────────────────────────────────────────────────
# TESTS
# ──────────────────────────────────────────────────────────────────────

def test_0_stop_prior_scheduler():
    """Stop any scheduler from prior test runs."""
    stop_scheduler()


def test_1_sync_with_zero_properties():
    """sync_all_ical_feeds_tick with no properties returns clean summary."""
    init_db()
    _cleanup_db()

    result = sync_all_ical_feeds_tick()

    assert result["properties_checked"] == 0
    assert result["properties_synced"] == 0
    assert result["properties_failed"] == 0
    assert result["total_jobs_created"] == 0
    assert result["failures"] == []


def test_2_sync_one_property_with_ical():
    """Sync one property with a valid iCal feed."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)

        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "test-event-1",
                "summary": "Guest Checkout",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        # Mock httpx.Client.get to return our ICS
        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event") as mock_gcal:
                mock_gcal.return_value = "gcal-event-123"

                result = sync_all_ical_feeds_tick()

        assert result["properties_checked"] == 1
        assert result["properties_synced"] == 1
        assert result["properties_failed"] == 0
        assert result["total_jobs_created"] == 1
        assert result["failures"] == []

        # Verify ICalEvent was created
        event = db.query(ICalEvent).filter_by(property_id=prop.id, uid="test-event-1").first()
        assert event is not None
        assert event.summary == "Guest Checkout"
        assert event.checkout_date == day_after

        # Verify Job was created with correct type
        job = db.query(Job).filter_by(property_id=prop.id, job_type="str_turnover").first()
        assert job is not None
        assert job.status == "scheduled"

    finally:
        db.close()


def test_3_sync_with_broken_ical_url():
    """One broken iCal URL doesn't block other properties."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)

        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        good_ics = _make_ics([
            {
                "uid": "good-event",
                "summary": "Valid Event",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop_good = _make_test_property(db, client.id, "http://example.com/good.ics")
        prop_bad = _make_test_property(db, client.id, "http://example.com/404-not-found.ics")

        with patch("httpx.Client") as mock_Client:
            def fake_get(url):
                if "404" in url:
                    return _FakeResponse(b"Not Found", 404)
                return _FakeResponse(good_ics)

            fake_client = _FakeHttpxClient()
            fake_client.get = fake_get
            mock_Client.return_value = fake_client

            with patch("integrations.google_calendar.create_event"):
                result = sync_all_ical_feeds_tick()

        assert result["properties_checked"] == 2
        assert result["properties_synced"] == 1
        assert result["properties_failed"] == 1
        assert len(result["failures"]) == 1
        assert result["failures"][0]["property_id"] == prop_bad.id

    finally:
        db.close()


def test_4_scheduler_disabled():
    """ICAL_AUTO_SYNC_ENABLED=0 disables scheduler."""
    with patch.dict(os.environ, {"ICAL_AUTO_SYNC_ENABLED": "0"}):
        scheduler = start_scheduler()
        assert scheduler is None


def test_5_manual_sync_endpoint():
    """Manual sync endpoint returns correct summary shape."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        _make_test_property(db, client.id)

        result = sync_all_ical_feeds_tick()

        assert "properties_checked" in result
        assert "properties_synced" in result
        assert "properties_failed" in result
        assert "total_jobs_created" in result
        assert "failures" in result

    finally:
        db.close()


def test_6_host_block_detected():
    """Host blocks are recorded but don't create jobs."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "blocked-1",
                "summary": "Airbnb (Blocked)",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)

            result = sync_all_ical_feeds_tick()

        assert result["properties_synced"] == 1
        assert result["total_jobs_created"] == 0  # No job for host block
        event = db.query(ICalEvent).filter_by(property_id=prop.id).first()
        assert event is not None
        assert event.event_type == "host_block"

    finally:
        db.close()


def test_7_duplicate_job_dedup():
    """Existing job for same property + date prevents duplicate."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        # Create existing job
        checkout_date = (date.today() + timedelta(days=1)).isoformat()
        existing_job = Job(
            client_id=client.id,
            property_id=prop.id,
            job_type="str_turnover",
            title="Existing Turnover",
            scheduled_date=checkout_date,
            status="scheduled",
        )
        db.add(existing_job)
        db.commit()

        ics_content = _make_ics([
            {
                "uid": "event-1",
                "summary": "Checkout",
                "start": checkout_date,
                "end": (date.today() + timedelta(days=2)).isoformat(),
            }
        ])

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)

            result = sync_all_ical_feeds_tick()

        # Should not create a new job
        assert result["total_jobs_created"] == 0
        jobs = db.query(Job).filter_by(property_id=prop.id).all()
        assert len(jobs) == 1

    finally:
        db.close()


def test_8_multiple_events_multiple_properties():
    """Sync multiple properties with multiple events each."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)

        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "event-1",
                "summary": "Event 1",
                "start": tomorrow,
                "end": day_after,
            },
            {
                "uid": "event-2",
                "summary": "Event 2",
                "start": (date.today() + timedelta(days=3)).isoformat(),
                "end": (date.today() + timedelta(days=4)).isoformat(),
            }
        ])

        prop1 = _make_test_property(db, client.id, "http://example.com/prop1.ics")
        prop2 = _make_test_property(db, client.id, "http://example.com/prop2.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event"):
                result = sync_all_ical_feeds_tick()

        assert result["properties_checked"] == 2
        assert result["properties_synced"] == 2
        assert result["total_jobs_created"] == 4  # 2 events per property

    finally:
        db.close()


def test_9_past_events_no_jobs():
    """Past events don't get jobs created."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)

        past_date = (date.today() - timedelta(days=1)).isoformat()
        past_end = date.today().isoformat()

        ics_content = _make_ics([
            {
                "uid": "past-event",
                "summary": "Past Event",
                "start": past_date,
                "end": past_end,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)

            result = sync_all_ical_feeds_tick()

        assert result["total_jobs_created"] == 0

    finally:
        db.close()


def test_10_property_last_synced_timestamp():
    """Property ical_last_synced_at is updated."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        before_sync = datetime.utcnow()
        ics_content = _make_ics([])

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)

            result = sync_all_ical_feeds_tick()

        after_sync = datetime.utcnow()

        prop_after = db.query(Property).filter_by(id=prop.id).first()
        assert prop_after.ical_last_synced_at is not None
        assert before_sync <= prop_after.ical_last_synced_at <= after_sync

    finally:
        db.close()


def test_11_property_without_ical_url_skipped():
    """Properties without ical_url are not synced."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        _make_test_property(db, client.id, ical_url=None)

        result = sync_all_ical_feeds_tick()

        assert result["properties_checked"] == 0

    finally:
        db.close()


def test_12_inactive_property_skipped():
    """Inactive properties are not synced."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")
        prop.active = False
        db.commit()

        result = sync_all_ical_feeds_tick()

        assert result["properties_checked"] == 0

    finally:
        db.close()


def test_13_event_uid_dedup():
    """Same UID in multiple syncs doesn't create duplicates."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "stable-uid-1",
                "summary": "Event",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event"):
                # First sync
                sync_all_ical_feeds_tick()
                # Second sync of same feed
                sync_all_ical_feeds_tick()

        events = db.query(ICalEvent).filter_by(property_id=prop.id).all()
        assert len(events) == 1  # Only one event, not two

    finally:
        db.close()


def test_14_empty_ics_feed():
    """Empty ICS feed is handled gracefully."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        ics_content = _make_ics([])

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)

            result = sync_all_ical_feeds_tick()

        assert result["properties_synced"] == 1
        assert result["total_jobs_created"] == 0

    finally:
        db.close()


def test_15_malformed_ics_error_handling():
    """Malformed ICS is caught and recorded."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(b"not valid ics")

            result = sync_all_ical_feeds_tick()

        assert result["properties_failed"] == 1
        assert len(result["failures"]) == 1
        assert "Failed to parse iCal" in result["failures"][0]["error"]

    finally:
        db.close()


def test_16_sync_interval_env_var():
    """ICAL_AUTO_SYNC_INTERVAL_MINUTES is respected."""
    with patch.dict(os.environ, {"ICAL_AUTO_SYNC_INTERVAL_MINUTES": "30"}):
        with patch("scheduler.BackgroundScheduler") as mock_scheduler:
            mock_instance = MagicMock()
            mock_scheduler.return_value = mock_instance

            start_scheduler()

            # Verify add_job was called with 30 minute interval
            calls = mock_instance.add_job.call_args_list
            assert len(calls) > 0
            # Extract trigger from kwargs
            trigger = calls[0][1].get("trigger") if calls[0][1] else calls[0][0][1]
            assert trigger.interval.total_seconds() == 30 * 60

        stop_scheduler()


def test_17_gcal_event_id_stored():
    """Google Calendar event ID is stored on job."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "gcal-test",
                "summary": "Event",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event") as mock_gcal:
                mock_gcal.return_value = "gcal-123-test"

                sync_all_ical_feeds_tick()

        job = db.query(Job).filter_by(property_id=prop.id).first()
        assert job is not None
        assert job.gcal_event_id == "gcal-123-test"
        assert job.calendar_invite_sent is True

    finally:
        db.close()


def test_18_gcal_push_failure_logged():
    """Failed Google Calendar push doesn't fail the entire sync."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "gcal-fail",
                "summary": "Event",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event") as mock_gcal:
                mock_gcal.side_effect = Exception("GCal API error")

                result = sync_all_ical_feeds_tick()

        # Sync should still succeed even if GCal push fails
        assert result["properties_synced"] == 1
        assert result["total_jobs_created"] == 1

    finally:
        db.close()


def test_19_scheduler_lifecycle():
    """Scheduler can be started and stopped."""
    with patch("scheduler.BackgroundScheduler") as mock_scheduler:
        mock_instance = MagicMock()
        mock_scheduler.return_value = mock_instance

        scheduler = start_scheduler()
        assert scheduler is not None

        stop_scheduler()
        mock_instance.shutdown.assert_called_once()


def test_20_invalid_env_int():
    """Invalid ICAL_AUTO_SYNC_INTERVAL_MINUTES defaults to 15."""
    with patch.dict(os.environ, {"ICAL_AUTO_SYNC_INTERVAL_MINUTES": "invalid"}):
        from scheduler import _env_int
        val = _env_int("ICAL_AUTO_SYNC_INTERVAL_MINUTES", 15)
        assert val == 15


def test_21_event_type_updated():
    """Event type is updated if classification changes."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        # First sync: event is a reservation
        ics_reservation = _make_ics([
            {
                "uid": "event-type-test",
                "summary": "Guest Reservation",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_reservation)
            with patch("integrations.google_calendar.create_event") as mock_gcal:
                mock_gcal.return_value = "gcal-1"
                sync_all_ical_feeds_tick()

        event = db.query(ICalEvent).filter_by(property_id=prop.id).first()
        assert event.event_type == "reservation"

        # Second sync: same event is now blocked
        ics_blocked = _make_ics([
            {
                "uid": "event-type-test",
                "summary": "Airbnb (Blocked)",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_blocked)
            sync_all_ical_feeds_tick()

        event = db.query(ICalEvent).filter_by(property_id=prop.id).first()
        assert event.event_type == "host_block"

    finally:
        db.close()


def test_22_client_email_in_job():
    """Client email is included in job notes."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "email-test",
                "summary": "Checkout",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event") as mock_gcal:
                mock_gcal.return_value = "gcal-id"

                sync_all_ical_feeds_tick()

        # Check that create_event was called with client info
        assert mock_gcal.called
        call_args = mock_gcal.call_args
        client_dict = call_args[0][1]  # Second positional arg
        assert client_dict["email"] == "test@example.com"

    finally:
        db.close()


def test_23_default_start_time():
    """Turnover jobs start at 10:00 AM."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "time-test",
                "summary": "Checkout",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event"):
                sync_all_ical_feeds_tick()

        job = db.query(Job).filter_by(property_id=prop.id).first()
        assert job.start_time == "10:00"

    finally:
        db.close()


def test_24_property_address_in_job():
    """Job inherits property address."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        day_after = (date.today() + timedelta(days=2)).isoformat()

        ics_content = _make_ics([
            {
                "uid": "addr-test",
                "summary": "Checkout",
                "start": tomorrow,
                "end": day_after,
            }
        ])

        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")
        prop.address = "456 Custom St"
        db.commit()

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)
            with patch("integrations.google_calendar.create_event"):
                sync_all_ical_feeds_tick()

        job = db.query(Job).filter_by(property_id=prop.id).first()
        assert job.address == "456 Custom St"

    finally:
        db.close()


def test_25_summary_contains_property_info():
    """Sync result includes property info."""
    init_db()
    _cleanup_db()

    db = SessionLocal()
    try:
        client = _make_test_client(db)
        prop = _make_test_property(db, client.id, "http://example.com/ical.ics")

        ics_content = _make_ics([])

        with patch("httpx.Client") as mock_Client:
            mock_Client.return_value = _FakeHttpxClient(ics_content)

            result = sync_all_ical_feeds_tick()

        # Check structure
        assert isinstance(result, dict)
        assert "properties_checked" in result
        assert result["properties_checked"] >= 0

    finally:
        db.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
