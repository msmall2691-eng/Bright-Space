"""Tests for STR turnover date fix (RFC 5545 DTEND exclusivity)."""
import pytest
from datetime import datetime, date, timedelta
from unittest.mock import Mock, patch, MagicMock
from database.models import Property, ICalEvent, Job, Client
from database.db import SessionLocal
from integrations.ical_sync import _extract_guest_metadata, _make_end_time, _sync_ical_url


def _sync_one_event(db, summary, *, uid="evt-1@feed"):
    """Build a single-event, future-dated feed with the given SUMMARY, run the
    sync against a fresh STR property, and return (result, job, checkout_date).
    Used to assert which titles become turnovers vs. host blocks."""
    client = Client(name="Test Client", email="t@example.com")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="Pier House",
                    address="1 Pier Rd", property_type="str")
    db.add(prop); db.commit(); db.refresh(prop)

    checkin = date.today() + timedelta(days=14)
    checkout = date.today() + timedelta(days=16)
    ics = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:{uid}
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:{summary}
END:VEVENT
END:VCALENDAR""".encode()

    with patch("integrations.ical_sync._httpx.Client") as mock_client_class:
        resp = MagicMock()
        resp.content = ics
        resp.raise_for_status = MagicMock()
        mock_client_class.return_value.__enter__.return_value.get.return_value = resp
        with patch("integrations.google_calendar.create_event") as mock_gcal:
            mock_gcal.return_value = None
            result = _sync_ical_url(db, prop, "https://example.com/feed.ics?s=1",
                                    ical_source_label="airbnb")

    job = db.query(Job).filter_by(property_id=prop.id).first()
    return result, job, checkout


class TestBookingDetection:
    """A calendar event becomes a turnover unless its title is a host block —
    regardless of whether the title says 'Reserved' (Pier House regression)."""

    def test_blank_title_creates_turnover(self):
        """A booking with an empty SUMMARY (common on VRBO) still schedules a
        turnover — the old allowlist silently dropped these."""
        db = SessionLocal()
        try:
            result, job, checkout = _sync_one_event(db, "", uid="blank@feed")
            assert result["jobs_created"] == 1
            assert job is not None
            assert job.scheduled_date == checkout
        finally:
            db.close()

    def test_guest_name_title_creates_turnover(self):
        """A booking whose title is just the guest's name (Hospitable/Guesty)
        still schedules a turnover."""
        db = SessionLocal()
        try:
            result, job, checkout = _sync_one_event(db, "John Smith", uid="guest@feed")
            assert result["jobs_created"] == 1
            assert job is not None
            assert job.scheduled_date == checkout
        finally:
            db.close()

    def test_owner_stay_is_skipped(self):
        """An owner-stay block is NOT turned into a cleaning."""
        db = SessionLocal()
        try:
            result, job, _ = _sync_one_event(db, "Owner stay", uid="owner@feed")
            assert result["jobs_created"] == 0
            assert result["skipped_host_blocks"] == 1
            assert job is None
        finally:
            db.close()

    def test_name_containing_owner_substring_is_a_booking(self):
        """Word-boundary matching: a title like 'Downtowner' must not be
        mistaken for an owner block."""
        db = SessionLocal()
        try:
            result, job, checkout = _sync_one_event(db, "Reserved - Downtowner", uid="dt@feed")
            assert result["jobs_created"] == 1
            assert job is not None
            assert job.scheduled_date == checkout
        finally:
            db.close()


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

            # Mock an AirBnB iCal response with an all-day event. Use
            # future-relative dates so the "checkout today or future" guard in
            # _sync_ical_url always passes (hardcoded dates rotted into the past).
            # DTEND is exclusive — turnover happens ON the DTEND date.
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            ical_content = f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//AirBnB//AirBnB Calendar//EN
BEGIN:VEVENT
UID:abc123xyz.airbnbicalendar@airbnb.com
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:Reserved
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMTEST123\\nPhone Number (Last 4 Digits): 5555
END:VEVENT
END:VCALENDAR""".encode()

            with patch("integrations.ical_sync._httpx.Client") as mock_client_class:
                mock_response = MagicMock()
                mock_response.content = ical_content
                mock_response.raise_for_status = MagicMock()
                mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response

                with patch("integrations.google_calendar.create_event") as mock_gcal:
                    mock_gcal.return_value = "event_12345"

                    result = _sync_ical_url(
                        db, prop,
                        "https://www.airbnb.com/calendar/ical/12345.ics?s=abc",
                        ical_source_label="airbnb"
                    )

                    # Verify a job was created
                    assert result["jobs_created"] == 1

                    # scheduled_date is the DTEND value (exclusive), NOT DTEND-1
                    job = db.query(Job).filter_by(property_id=prop.id).first()
                    assert job is not None
                    assert job.scheduled_date == checkout  # DTEND value
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

            # Future-relative dates so the checkout-in-future guard passes.
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            ical_content = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:same_uid_123.airbnbicalendar@airbnb.com
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:Reserved
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMDEDUP1\\nPhone Number (Last 4 Digits): 1111
END:VEVENT
END:VCALENDAR""".encode()

            with patch("integrations.ical_sync._httpx.Client") as mock_client_class:
                mock_response = MagicMock()
                mock_response.content = ical_content
                mock_response.raise_for_status = MagicMock()
                mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response

                with patch("integrations.google_calendar.create_event") as mock_gcal:
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


class TestPreviewDiagnostic:
    """The ical-preview 'Diagnose feed' endpoint must use the same booking rule
    as the real sync — a guest-name booking is 'would create', not 'skipped'."""

    def test_preview_matches_sync_classification(self):
        from modules.properties.router import ical_preview
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="t@example.com")
            db.add(client); db.commit(); db.refresh(client)
            prop = Property(client_id=client.id, name="Pier House",
                            address="1 Pier Rd", property_type="str",
                            ical_url="https://www.airbnb.com/calendar/ical/7.ics?s=abc")
            db.add(prop); db.commit(); db.refresh(prop)

            checkin = date.today() + timedelta(days=18)
            checkout = date.today() + timedelta(days=20)
            ics = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:guest@feed
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:John Smith
END:VEVENT
BEGIN:VEVENT
UID:block@feed
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:Airbnb (Not available)
END:VEVENT
END:VCALENDAR""".encode()

            with patch("httpx.Client") as mc:
                resp = MagicMock(); resp.content = ics; resp.raise_for_status = MagicMock()
                mc.return_value.__enter__.return_value.get.return_value = resp
                result = ical_preview(prop.id, db)

            events = {e["summary"]: e["decision"] for e in result["feeds"][0]["events"]}
            # Guest-name booking is recognized (old code said "not a reservation").
            assert events["John Smith"] == "would create turnover"
            assert "host block" in events["Airbnb (Not available)"]
        finally:
            db.close()


class TestResurrectCancelledTurnover:
    """An active booking always keeps a turnover: if its turnover was cancelled
    (manually, or when its GCal event was deleted) the next sync recreates it."""

    def test_cancelled_turnover_recreated_while_booking_active(self):
        from integrations.ical_sync import _sync_ical_url
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="t@example.com")
            db.add(client); db.commit(); db.refresh(client)
            prop = Property(client_id=client.id, name="Pier House",
                            address="1 Pier Rd", property_type="str",
                            ical_url="https://www.airbnb.com/calendar/ical/5.ics?s=abc")
            db.add(prop); db.commit(); db.refresh(prop)

            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            ics = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:stay-1@feed
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:Reserved
END:VEVENT
END:VCALENDAR""".encode()

            def run_sync():
                with patch("integrations.ical_sync._httpx.Client") as mc:
                    resp = MagicMock(); resp.content = ics; resp.raise_for_status = MagicMock()
                    mc.return_value.__enter__.return_value.get.return_value = resp
                    with patch("integrations.google_calendar.create_event") as gc:
                        gc.return_value = None
                        return _sync_ical_url(db, prop, prop.ical_url, ical_source_label="airbnb")

            # First sync creates the turnover and links the iCal event to it.
            r1 = run_sync()
            assert r1["jobs_created"] == 1
            job = db.query(Job).filter_by(property_id=prop.id).first()
            ev = db.query(ICalEvent).filter_by(property_id=prop.id, uid="stay-1@feed").first()
            assert ev.job_id == job.id

            # Simulate a stuck cancellation that left the link pointing at it
            # (manual cancel, or GCal event deleted) while the booking stays live.
            job.status = "cancelled"
            db.commit()

            # Next sync must resurrect: a new active turnover on the same date,
            # with the iCal event repointed to it.
            r2 = run_sync()
            assert r2["jobs_created"] == 1
            active = db.query(Job).filter_by(property_id=prop.id, status="scheduled").all()
            assert len(active) == 1
            assert active[0].id != job.id
            assert active[0].scheduled_date == checkout
            db.refresh(ev)
            assert ev.job_id == active[0].id
        finally:
            db.close()

    def test_active_turnover_with_lost_date_is_reconciled(self):
        """A linked turnover that's still active but lost its scheduled_date (old
        data reset / VARCHAR→DATE migration) is reconciled to the feed checkout on
        the next sync, instead of staying invisible on the calendar."""
        from integrations.ical_sync import _sync_ical_url
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="t@example.com")
            db.add(client); db.commit(); db.refresh(client)
            prop = Property(client_id=client.id, name="Pier House",
                            address="1 Pier Rd", property_type="str",
                            ical_url="https://www.airbnb.com/calendar/ical/6.ics?s=abc")
            db.add(prop); db.commit(); db.refresh(prop)

            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            ics = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:stay-2@feed
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:Reserved
END:VEVENT
END:VCALENDAR""".encode()

            def run_sync():
                with patch("integrations.ical_sync._httpx.Client") as mc:
                    resp = MagicMock(); resp.content = ics; resp.raise_for_status = MagicMock()
                    mc.return_value.__enter__.return_value.get.return_value = resp
                    with patch("integrations.google_calendar.create_event") as gc:
                        gc.return_value = None
                        return _sync_ical_url(db, prop, prop.ical_url, ical_source_label="airbnb")

            run_sync()
            job = db.query(Job).filter_by(property_id=prop.id).first()
            assert job.scheduled_date == checkout

            # Simulate the lost-date corruption while the job stays active/linked.
            job.scheduled_date = None
            db.commit()

            # Next sync reconciles it back to the booking's checkout date — no
            # duplicate job, the same row is fixed in place.
            r2 = run_sync()
            assert r2["jobs_created"] == 0
            db.refresh(job)
            assert job.scheduled_date == checkout
            assert db.query(Job).filter_by(property_id=prop.id).count() == 1
        finally:
            db.close()


class TestTurnoverHardening:
    """Capture full booking data, report coverage, and keep GCal in step when
    reconciling — so a missed/wrong-day turnover can't recur silently."""

    def test_turnover_captures_stay_metadata_and_coverage(self):
        db = SessionLocal()
        try:
            result, job, checkout = _sync_one_event(db, "Reserved", uid="meta@feed")
            checkin = checkout - timedelta(days=2)  # _sync_one_event: checkin = checkout-2
            # Full booking window is captured on the turnover.
            assert job.custom_fields.get("checkin_date") == checkin.isoformat()
            assert job.custom_fields.get("checkout_date") == checkout.isoformat()
            assert job.custom_fields.get("nights") == 2
            assert job.custom_fields.get("booking_uid") == "meta@feed"
            # Coverage: the one future booking is covered, nothing missing.
            assert result["future_bookings"] == 1
            assert result["missing_turnovers"] == []
        finally:
            db.close()

    def test_reconcile_pushes_corrected_date_to_gcal(self):
        """When a linked turnover's date is reconciled, the linked Google Calendar
        event must be updated too — otherwise the next GCal sync (authoritative)
        reverts it."""
        from integrations.ical_sync import _sync_ical_url
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="t@example.com")
            db.add(client); db.commit(); db.refresh(client)
            prop = Property(client_id=client.id, name="Pier House",
                            address="1 Pier Rd", property_type="str",
                            ical_url="https://www.airbnb.com/calendar/ical/8.ics?s=abc")
            db.add(prop); db.commit(); db.refresh(prop)

            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            ics = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:stay-3@feed
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:Reserved
END:VEVENT
END:VCALENDAR""".encode()

            def run_sync(update_mock=None):
                with patch("integrations.ical_sync._httpx.Client") as mc:
                    resp = MagicMock(); resp.content = ics; resp.raise_for_status = MagicMock()
                    mc.return_value.__enter__.return_value.get.return_value = resp
                    with patch("integrations.google_calendar.create_event") as gc:
                        gc.return_value = None
                        if update_mock is not None:
                            with patch("integrations.google_calendar.update_event", update_mock):
                                return _sync_ical_url(db, prop, prop.ical_url, ical_source_label="airbnb")
                        return _sync_ical_url(db, prop, prop.ical_url, ical_source_label="airbnb")

            run_sync()
            job = db.query(Job).filter_by(property_id=prop.id).first()
            # Give it a GCal event, then wipe its date (the stuck state).
            job.gcal_event_id = "evt_pier_123"
            job.scheduled_date = None
            db.commit()

            upd = MagicMock()
            run_sync(update_mock=upd)
            db.refresh(job)
            assert job.scheduled_date == checkout
            # The GCal event was updated to the corrected checkout date.
            assert upd.called, "expected update_event to be called on reconcile"
            args, kwargs = upd.call_args
            assert args[0] == "evt_pier_123"
            assert args[1].get("scheduled_date") == checkout.isoformat()
        finally:
            db.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

