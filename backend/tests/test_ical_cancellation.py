"""Tests for iCal cancellation and reschedule detection.

Previously this file was all `assert True` placeholders documenting the
intended logic without exercising it. Rewritten with real DB/sync exercises,
and extended to cover the multi-feed + partial-fetch cancellation bugs (one
Airbnb booking on a 2-feed property spawned hundreds of duplicate turnover
jobs in production via a cancel<->recreate loop — see ical_sync.py's
sync_property for the fix: the cancellation sweep now runs ONCE per tick,
after every active feed has synced, against the union of all their UIDs,
and is skipped entirely if any feed failed or looked like a partial read).
"""
import pytest
from datetime import date, timedelta
from unittest.mock import MagicMock, patch
from database.models import Property, ICalEvent, Job, Client, PropertyIcal
from database.db import SessionLocal
from integrations.ical_sync import _sync_ical_url, sync_property


@pytest.fixture(autouse=True)
def _stub_ssrf_dns():
    """The SSRF guard does a real DNS lookup before the mocked HTTP client is
    reached. Stub it so these tests don't depend on external DNS resolution."""
    with patch("integrations.ical_sync._assert_public_url", return_value=None):
        yield


def _ics(events):
    """events: list of (uid, checkin_date, checkout_date, summary) -> iCal bytes."""
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN"]
    for uid, checkin, checkout, summary in events:
        lines += [
            "BEGIN:VEVENT",
            f"UID:{uid}",
            f"DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}",
            f"SUMMARY:{summary}",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines).encode()


def _patch_feeds(url_to_ics):
    """Patch integrations.ical_sync._httpx.Client so .get(url) returns the
    bytes registered for that url — lets a multi-feed sync_property() call
    serve different content per feed URL in one `with` block."""
    mock_client_cls = MagicMock()
    entered = mock_client_cls.return_value.__enter__.return_value

    def _get(url, *a, **k):
        resp = MagicMock()
        resp.content = url_to_ics[url]
        resp.raise_for_status = MagicMock()
        return resp

    entered.get.side_effect = _get
    return patch("integrations.ical_sync._httpx.Client", mock_client_cls)


def _seed_property(db, n_feeds=1):
    client = Client(name="Test Client", email="t@example.com")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="Wells Rental",
                     address="1 Wells Way", property_type="str")
    db.add(prop); db.commit(); db.refresh(prop)
    urls = [f"https://example.com/feed{i}.ics?s=1" for i in range(n_feeds)]
    for i, url in enumerate(urls):
        db.add(PropertyIcal(property_id=prop.id, url=url,
                             source=f"source{i}", active=True))
    db.commit(); db.refresh(prop)
    return prop, urls


class TestCancellationDetection:
    """Bookings disappearing from every synced feed get cancelled; bookings
    that are just missing from ONE feed on a multi-feed property do not."""

    def test_cancellation_marks_job_cancelled(self):
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            other_checkin = date.today() + timedelta(days=30)
            other_checkout = date.today() + timedelta(days=32)
            # Two bookings so the second tick's feed isn't empty (seen == 0
            # is always treated as an unreliable read — see the partial-fetch
            # guard tests below — so a real disappearance has to be simulated
            # against a feed that still returns other, unrelated content).
            events = [
                ("stay-1@feed", checkin, checkout, "Reserved"),
                ("stay-1b@feed", other_checkin, other_checkout, "Reserved"),
            ]

            with _patch_feeds({url: _ics(events)}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            job = db.query(Job).filter_by(property_id=prop.id, scheduled_date=checkout).first()
            assert job.status == "scheduled"

            # Next tick: booking 1 is gone from the feed; booking 1b remains.
            with _patch_feeds({url: _ics(events[1:])}), \
                 patch("integrations.google_calendar.delete_event", return_value=True):
                sync_property(db, prop)
            db.refresh(job)
            assert job.status == "cancelled"
            ev = db.query(ICalEvent).filter_by(property_id=prop.id, uid="stay-1@feed").first()
            assert ev.event_type == "cancelled"
            assert ev.job_id is None
            other_job = db.query(Job).filter_by(property_id=prop.id, scheduled_date=other_checkout).first()
            assert other_job.status == "scheduled"
        finally:
            db.close()

    def test_completed_jobs_not_cancelled(self):
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            other_checkin = date.today() + timedelta(days=30)
            other_checkout = date.today() + timedelta(days=32)
            events = [
                ("stay-2@feed", checkin, checkout, "Reserved"),
                ("stay-2b@feed", other_checkin, other_checkout, "Reserved"),
            ]

            with _patch_feeds({url: _ics(events)}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            job = db.query(Job).filter_by(property_id=prop.id, scheduled_date=checkout).first()
            job.status = "completed"
            db.commit()

            # Booking 1 (now completed) disappears; booking 1b keeps the feed
            # non-empty so the sweep actually runs and has to make this choice.
            with _patch_feeds({url: _ics(events[1:])}), \
                 patch("integrations.google_calendar.delete_event", return_value=True):
                sync_property(db, prop)
            db.refresh(job)
            assert job.status == "completed"
        finally:
            db.close()

    def test_past_events_not_touched_by_sweep(self):
        """A stored reservation event with a checkout in the past is outside the
        sweep's query window (checkout_date >= today) regardless of feed content."""
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            past_checkout = (date.today() - timedelta(days=5)).isoformat()
            past_job = Job(client_id=prop.client_id, property_id=prop.id,
                            job_type="str_turnover", title="Old turnover",
                            scheduled_date=date.today() - timedelta(days=5),
                            address=prop.address, status="scheduled")
            db.add(past_job); db.commit(); db.refresh(past_job)
            past_event = ICalEvent(property_id=prop.id, uid="old-stay@feed",
                                    event_type="reservation", checkout_date=past_checkout,
                                    checkin_date=(date.today() - timedelta(days=7)).isoformat(),
                                    job_id=past_job.id)
            db.add(past_event); db.commit()

            # An unrelated future booking, nothing to do with the past one.
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            with _patch_feeds({url: _ics([("stay-3@feed", checkin, checkout, "Reserved")])}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)

            db.refresh(past_job)
            assert past_job.status == "scheduled"
        finally:
            db.close()


class TestRescheduleDetection:
    def test_date_change_updates_job(self):
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            new_checkout = date.today() + timedelta(days=13)

            with _patch_feeds({url: _ics([("stay-4@feed", checkin, checkout, "Reserved")])}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            job = db.query(Job).filter_by(property_id=prop.id).first()
            assert job.scheduled_date == checkout

            with _patch_feeds({url: _ics([("stay-4@feed", checkin, new_checkout, "Reserved")])}), \
                 patch("integrations.google_calendar.update_event", return_value=True):
                sync_property(db, prop)
            db.refresh(job)
            assert job.scheduled_date == new_checkout
            assert db.query(Job).filter_by(property_id=prop.id).count() == 1
        finally:
            db.close()

    def test_completed_job_not_rescheduled(self):
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            new_checkout = date.today() + timedelta(days=13)

            with _patch_feeds({url: _ics([("stay-5@feed", checkin, checkout, "Reserved")])}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            job = db.query(Job).filter_by(property_id=prop.id).first()
            job.status = "completed"
            db.commit()

            with _patch_feeds({url: _ics([("stay-5@feed", checkin, new_checkout, "Reserved")])}):
                sync_property(db, prop)
            db.refresh(job)
            assert job.scheduled_date == checkout
        finally:
            db.close()


class TestSyncEdgeCases:
    def test_empty_feed_does_not_cancel_existing(self):
        """A feed reporting zero events this tick (network hiccup, transient
        empty response) must never cancel existing bookings — this is the
        hard floor the old `if feed_uids:` guard provided, preserved exactly
        by the new `seen == 0` check regardless of any drop-ratio heuristic."""
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)

            with _patch_feeds({url: _ics([("stay-6@feed", checkin, checkout, "Reserved")])}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            job = db.query(Job).filter_by(property_id=prop.id).first()
            assert job.status == "scheduled"

            with _patch_feeds({url: _ics([])}):
                sync_property(db, prop)
            db.refresh(job)
            assert job.status == "scheduled"
        finally:
            db.close()

    def test_host_blocks_dont_count_as_cancellations(self):
        """Host-block events never get an ICalEvent row (skipped before the
        upsert), so their disappearance can't affect any real booking's
        cancellation status."""
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            block_checkin = date.today() + timedelta(days=20)
            block_checkout = date.today() + timedelta(days=22)

            events = [
                ("stay-7@feed", checkin, checkout, "Reserved"),
                ("block-1@feed", block_checkin, block_checkout, "Owner — Not available"),
            ]
            with _patch_feeds({url: _ics(events)}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            job = db.query(Job).filter_by(property_id=prop.id).first()
            assert job.status == "scheduled"
            assert db.query(ICalEvent).filter_by(uid="block-1@feed").count() == 0

            # Host block disappears; real booking stays. Nothing to cancel.
            with _patch_feeds({url: _ics([("stay-7@feed", checkin, checkout, "Reserved")])}):
                sync_property(db, prop)
            db.refresh(job)
            assert job.status == "scheduled"
        finally:
            db.close()


class TestMultiFeedCancellationScoping:
    """The core reported bug: a property with 2+ active feeds must never have
    one feed's sync cancel a booking that only lives on a DIFFERENT feed."""

    def test_multi_feed_does_not_false_cancel_other_feeds_booking(self):
        db = SessionLocal()
        try:
            prop, (url_a, url_b) = _seed_property(db, n_feeds=2)
            checkin = date.today() + timedelta(days=10)
            checkout_a = date.today() + timedelta(days=12)
            checkout_b = date.today() + timedelta(days=14)

            feeds = {
                url_a: _ics([("booking-a@feed", checkin, checkout_a, "Reserved")]),
                url_b: _ics([("booking-b@feed", checkin, checkout_b, "Reserved")]),
            }
            with _patch_feeds(feeds), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)

            jobs = db.query(Job).filter_by(property_id=prop.id).all()
            assert len(jobs) == 2
            assert all(j.status == "scheduled" for j in jobs)

            # Sync again with BOTH feeds unchanged. The old per-feed sweep
            # would cancel booking-b while syncing feed A (its uid isn't in
            # feed A's feed_uids) and vice versa — the exact bug.
            with _patch_feeds(feeds):
                sync_property(db, prop)

            for j in jobs:
                db.refresh(j)
            assert all(j.status == "scheduled" for j in jobs), \
                "a booking on one feed must not be cancelled by another feed's sync"
        finally:
            db.close()


class TestPartialFetchGuard:
    def test_partial_fetch_skips_cancellation_sweep(self):
        """A feed whose event count drops drastically (but not to zero) vs its
        own last known-good count is treated as an unreliable/partial read —
        the sweep is skipped entirely for this tick rather than trusting the
        partial UID set to mean "everything else is cancelled"."""
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            bookings = [
                (f"stay-{i}@feed", checkin, checkin + timedelta(days=2 + i), "Reserved")
                for i in range(5)
            ]
            with _patch_feeds({url: _ics(bookings)}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            jobs = db.query(Job).filter_by(property_id=prop.id).all()
            assert len(jobs) == 5

            # Next tick: feed suddenly reports only ONE of the five bookings —
            # a partial/truncated read, not five real cancellations.
            with _patch_feeds({url: _ics(bookings[:1])}):
                sync_property(db, prop)

            for j in jobs:
                db.refresh(j)
            assert all(j.status == "scheduled" for j in jobs), \
                "a suspiciously small fetch must not cancel the other bookings"
        finally:
            db.close()


class TestSyncIdempotency:
    """Direct regression coverage for the reported bug: syncing the same
    booking repeatedly, across two feeds, with one partial fetch mixed in,
    must land on exactly ONE scheduled turnover — never a duplicate."""

    def test_repeated_syncs_across_two_feeds_with_one_partial_produce_no_duplicates(self):
        db = SessionLocal()
        try:
            prop, (url_a, url_b) = _seed_property(db, n_feeds=2)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            booking_a = [("the-booking@feed-a", checkin, checkout, "Reserved")]
            other_checkin = date.today() + timedelta(days=30)
            other_checkout = date.today() + timedelta(days=32)
            booking_b = [("other-booking@feed-b", other_checkin, other_checkout, "Reserved")]

            with patch("integrations.google_calendar.create_event", return_value=None), \
                 patch("integrations.google_calendar.update_event", return_value=True), \
                 patch("integrations.google_calendar.delete_event", return_value=True):
                # Ticks 1-2: both feeds healthy.
                for _ in range(2):
                    with _patch_feeds({url_a: _ics(booking_a), url_b: _ics(booking_b)}):
                        sync_property(db, prop)

                # Tick 3: feed B has a partial/truncated read (simulated as
                # empty here — the hard "seen == 0" floor covers this case;
                # feed A is unaffected and still reports the booking).
                with _patch_feeds({url_a: _ics(booking_a), url_b: _ics([])}):
                    sync_property(db, prop)

                # Ticks 4-5: back to normal.
                for _ in range(2):
                    with _patch_feeds({url_a: _ics(booking_a), url_b: _ics(booking_b)}):
                        sync_property(db, prop)

            turnovers = db.query(Job).filter_by(
                property_id=prop.id, job_type="str_turnover", scheduled_date=checkout,
            ).all()
            assert len(turnovers) == 1, f"expected exactly one turnover, got {len(turnovers)}"
            assert turnovers[0].status == "scheduled"

            other_turnovers = db.query(Job).filter_by(
                property_id=prop.id, job_type="str_turnover", scheduled_date=other_checkout,
            ).all()
            assert len(other_turnovers) == 1
            assert other_turnovers[0].status == "scheduled"
        finally:
            db.close()

    def test_cancel_then_resurrect_across_many_ticks_reactivates_not_duplicates(self):
        """The exact production shape: a booking's turnover gets cancelled
        (e.g. a manual cancel, or a historical false-cancel from before this
        fix) while the booking is still genuinely live. Many subsequent syncs
        must converge on ONE scheduled job, not one new row per tick."""
        db = SessionLocal()
        try:
            prop, (url,) = _seed_property(db)
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            booking = [("flappy@feed", checkin, checkout, "Reserved")]

            with _patch_feeds({url: _ics(booking)}), \
                 patch("integrations.google_calendar.create_event", return_value=None):
                sync_property(db, prop)
            job = db.query(Job).filter_by(property_id=prop.id).first()
            job.status = "cancelled"
            db.commit()

            with patch("integrations.google_calendar.create_event", return_value=None), \
                 patch("integrations.google_calendar.update_event", return_value=True):
                for _ in range(5):
                    with _patch_feeds({url: _ics(booking)}):
                        sync_property(db, prop)

            assert db.query(Job).filter_by(property_id=prop.id).count() == 1
            db.refresh(job)
            assert job.status == "scheduled"
        finally:
            db.close()
