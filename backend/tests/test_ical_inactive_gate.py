"""The iCal feed is an INBOX: it must not generate turnover jobs (or GCal
invites) for a property/client that's been taken out of service.

Regression for the reported "Spin Drift" bug — a client set to
status="inactive" kept its STR feed generating turnovers and emailing the
customer Google Calendar invites, because the sync keyed off Property.active /
PropertyIcal.active and never the owning client. The guard lives at the top of
integrations.ical_sync.sync_property so it covers every caller (the hourly
tick, "Sync now", per-feed retry, and the GCal backfill).
"""
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

from database.models import Property, Job, Client, PropertyIcal, ICalEvent
from database.db import SessionLocal
from integrations.ical_sync import sync_property


def _cleanup(db, prop, client):
    # Delete every row this test created, in FK order. ical_events must go too:
    # leaving them behind (job_id set) collides with other iCal tests via
    # SQLite rowid reuse on the ical_events.job_id UNIQUE constraint.
    db.query(ICalEvent).filter(ICalEvent.property_id == prop.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.property_id == prop.id).delete(synchronize_session=False)
    db.query(PropertyIcal).filter(PropertyIcal.property_id == prop.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture(autouse=True)
def _stub_ssrf_dns():
    # The SSRF guard does a real DNS lookup before the mocked HTTP client is
    # reached; stub it so these tests don't depend on external DNS.
    with patch("integrations.ical_sync._assert_public_url", return_value=None):
        yield


def _ics(events):
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


def _patch_feed(ics_bytes):
    mock_cls = MagicMock()
    entered = mock_cls.return_value.__enter__.return_value

    def _get(url, *a, **k):
        resp = MagicMock()
        resp.content = ics_bytes
        resp.raise_for_status = MagicMock()
        return resp

    entered.get.side_effect = _get
    return patch("integrations.ical_sync._httpx.Client", mock_cls)


def _seed(db, *, client_status="active"):
    client = Client(name="Spin Drift Owner", email="owner@example.com",
                    status=client_status)
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="Spin Drift", address="1 Drift Rd",
                    property_type="str")
    db.add(prop); db.commit(); db.refresh(prop)
    url = "https://example.com/spindrift.ics?s=1"
    db.add(PropertyIcal(property_id=prop.id, url=url, source="airbnb", active=True))
    db.commit(); db.refresh(prop)
    return client, prop, url


def _future_booking():
    checkin = date.today() + timedelta(days=10)
    checkout = date.today() + timedelta(days=12)
    return checkout, _ics([("spindrift-stay@airbnb", checkin, checkout, "Reserved")])


def test_active_client_generates_a_turnover():
    """Baseline: an active client's feed still generates the turnover job."""
    db = SessionLocal()
    try:
        _client, prop, _url = _seed(db, client_status="active")
        checkout, ics = _future_booking()
        with _patch_feed(ics), \
             patch("integrations.google_calendar.create_event", return_value=None):
            result = sync_property(db, prop)
        assert "skipped" not in result
        job = db.query(Job).filter_by(property_id=prop.id, scheduled_date=checkout).first()
        assert job is not None and job.status == "scheduled"
    finally:
        _cleanup(db, prop, _client); db.close()


def test_inactive_client_feed_is_skipped():
    """The reported bug: a client marked inactive must stop the feed — no job,
    no fetch, no GCal invite."""
    db = SessionLocal()
    try:
        _client, prop, _url = _seed(db, client_status="inactive")
        _checkout, ics = _future_booking()
        with _patch_feed(ics), \
             patch("integrations.google_calendar.create_event", return_value=None):
            result = sync_property(db, prop)
        assert result.get("skipped") is True
        assert result.get("reason") == "client_inactive"
        assert db.query(Job).filter_by(property_id=prop.id).count() == 0
    finally:
        _cleanup(db, prop, _client); db.close()


def test_archived_property_feed_is_skipped():
    """An archived (active=False) property also stops the feed, whatever the
    client's status — covers the manual 'Sync now' hole on an archived house."""
    db = SessionLocal()
    try:
        _client, prop, _url = _seed(db, client_status="active")
        prop.active = False
        db.commit()
        _checkout, ics = _future_booking()
        with _patch_feed(ics), \
             patch("integrations.google_calendar.create_event", return_value=None):
            result = sync_property(db, prop)
        assert result.get("skipped") is True
        assert result.get("reason") == "property_inactive"
        assert db.query(Job).filter_by(property_id=prop.id).count() == 0
    finally:
        _cleanup(db, prop, _client); db.close()
