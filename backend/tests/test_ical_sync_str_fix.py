"""Tests for STR turnover date fix (RFC 5545 DTEND exclusivity)."""
import pytest
from datetime import datetime, date
from unittest.mock import Mock, patch, MagicMock
from database.models import Property, ICalEvent, Job, Client
from database.db import SessionLocal
from integrations.ical_sync import _extract_guest_metadata, _make_end_time, _sync_ical_url


class TestExtractGuestMetadata:
    """Test guest metadata extraction from AirBnB DESCRIPTION."""

    def test_extract_reservation_code(self):
        """Extract AirBnB reservation code from Reservation URL."""
        description = """Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCXYZ
Phone Number (Last 4 Digits): 1234"""
        metadata = _extract_guest_metadata(description)
        assert metadata.get('airbnb_reservation_code') == 'HMABCXYZ'

    def test_extract_phone_last_4(self):
        """Extract guest phone last-4 from DESCRIPTION."""
        description = "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCXYZ\nPhone Number (Last 4 Digits): 5678"
        metadata = _extract_guest_metadata(description)
        assert metadata.get('guest_phone_last_4') == '5678'

    def test_extract_both(self):
        """Extract both reservation code and phone."""
        description = """Reservation URL: https://www.airbnb.com/hosting/reservations/details/HM123456
Phone Number (Last 4 Digits): 9999"""
        metadata = _extract_guest_metadata(description)
        assert metadata.get('airbnb_reservation_code') == 'HM123456'
        assert metadata.get('guest_phone_last_4') == '9999'

    def test_empty_description(self):
        """Handle empty or None description."""
        assert _extract_guest_metadata(None) == {}
        assert _extract_guest_metadata("") == {}

    def test_no_metadata_found(self):
        """Description without standard format returns empty dict."""
        description = "Some random text about the property"
        metadata = _extract_guest_metadata(description)
        assert 'airbnb_reservation_code' not in metadata
        assert 'guest_phone_last_4' not in metadata


class TestMakeEndTime:
    """Test end time calculation."""

    def test_basic_duration(self):
        """Calculate end time from start time + 3 hours."""
        end = _make_end_time("10:00", 3.0)
        assert end == "13:00:00"

    def test_fractional_duration(self):
        """Handle fractional hours (e.g., 2.5 hours)."""
        end = _make_end_time("14:00", 2.5)
        assert end == "16:30:00"

    def test_duration_crosses_midnight(self):
        """Handle duration that crosses midnight."""
        end = _make_end_time("22:00", 4.0)
        assert end == "02:00:00"  # (22 + 4) % 24 = 2


class TestDTENDExclusivity:
    """Test the RFC 5545 DTEND exclusivity fix."""

    def test_dtend_not_subtracted_for_allday(self):
        """CRITICAL: DTEND should NOT be decremented for all-day events."""
        # This is the main fix: DTEND is exclusive, so DTEND IS the checkout date
        db = SessionLocal()
        try:
            # Create a property and client
            client = Client(
                name="Test Client",
                email="test@example.com"
            )
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Test Property",
                address="123 Main St",
                property_type="str",
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            # Mock an AirBnB iCal response with all-day event
            # Guest checks in April 20, checks out April 22 (stays April 20-21)
            # DTEND is April 22 (exclusive) — turnover happens April 22
            ical_content = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//AirBnB//AirBnB Calendar//EN
BEGIN:VEVENT
UID:abc123xyz.airbnbicalendar@airbnb.com
DTSTART;VALUE=DATE:20260420
DTEND;VALUE=DATE:20260422
SUMMARY:Reserved
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMTEST123\\nPhone Number (Last 4 Digits): 5555
END:VEVENT
END:VCALENDAR"""

            with patch("integrations.ical_sync._httpx.Client") as mock_client_class:
                mock_response = MagicMock()
                mock_response.content = ical_content
                mock_response.raise_for_status = MagicMock()
                mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response

                with patch("integrations.ical_sync.create_event") as mock_gcal:
                    mock_gcal.return_value = "event_12345"

                    result = _sync_ical_url(
                        db, prop,
                        "https://www.airbnb.com/calendar/ical/12345.ics?s=abc",
                        ical_source_label="airbnb"
                    )

                    # Verify a job was created
                    assert result["jobs_created"] == 1

                    # Verify the scheduled_date is DTEND (April 22), NOT DTEND-1 (April 21)
                    job = db.query(Job).filter_by(property_id=prop.id).first()
                    assert job is not None
                    assert job.scheduled_date == "2026-04-22"  # DTEND value
                    assert job.job_type == "str_turnover"

                    # Verify guest metadata was extracted
                    assert job.custom_fields.get('airbnb_reservation_code') == 'HMTEST123'
                    assert job.custom_fields.get('guest_phone_last_4') == '5555'

        finally:
            db.close()


class TestHostBlockFiltering:
    """Test that 'Not available' and other host blocks are skipped."""

    def test_not_available_skipped(self):
        """'Not available' events should NOT create jobs."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Test Property",
                address="123 Main St",
                property_type="str",
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            # iCal with "Not available" summary
            ical_content = b"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:host_block_123.airbnbicalendar@airbnb.com
DTSTART;VALUE=DATE:20260420
DTEND;VALUE=DATE:20260423
SUMMARY:Not available
DESCRIPTION:Owner blocked these dates
END:VEVENT
END:VCALENDAR"""

            with patch("integrations.ical_sync._httpx.Client") as mock_client_class:
                mock_response = MagicMock()
                mock_response.content = ical_content
                mock_response.raise_for_status = MagicMock()
                mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response

                result = _sync_ical_url(
                    db, prop,
                    "https://www.airbnb.com/calendar/ical/12345.ics?s=abc",
                    ical_source_label="airbnb"
                )

                # No jobs should be created for host blocks
                assert result["jobs_created"] == 0
                assert result["skipped_host_blocks"] == 1

                # No Job should exist
                job = db.query(Job).filter_by(property_id=prop.id).first()
                assert job is None

        finally:
            db.close()


class TestDedupLogic:
    """Test deduplication using (property_id, uid) key."""

    def test_same_event_twice_creates_one_job(self):
        """Running sync twice with same event should not duplicate jobs."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Test Property",
                address="123 Main St",
                property_type="str",
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            ical_content = b"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:same_uid_123.airbnbicalendar@airbnb.com
DTSTART;VALUE=DATE:20260420
DTEND;VALUE=DATE:20260422
SUMMARY:Reserved
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMDEDUP1\\nPhone Number (Last 4 Digits): 1111
END:VEVENT
END:VCALENDAR"""

            with patch("integrations.ical_sync._httpx.Client") as mock_client_class:
                mock_response = MagicMock()
                mock_response.content = ical_content
                mock_response.raise_for_status = MagicMock()
                mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response

                with patch("integrations.ical_sync.create_event") as mock_gcal:
                    mock_gcal.return_value = "event_id_1"

                    # First sync
                    result1 = _sync_ical_url(
                        db, prop,
                        "https://www.airbnb.com/calendar/ical/12345.ics?s=abc",
                        ical_source_label="airbnb"
                    )
                    assert result1["jobs_created"] == 1

                    # Second sync (same UID)
                    result2 = _sync_ical_url(
                        db, prop,
                        "https://www.airbnb.com/calendar/ical/12345.ics?s=abc",
                        ical_source_label="airbnb"
                    )
                    # Should detect existing event and skip
                    assert result2["jobs_created"] == 0

                    # Verify only one job exists
                    jobs = db.query(Job).filter_by(property_id=prop.id).all()
                    assert len(jobs) == 1

        finally:
            db.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
