"""A turnover the office deletes on purpose must stay deleted.

The generator's standing policy is "a live booking always keeps a turnover", so
deleting a turnover got it recreated on the next iCal sync — the feed (an inbox)
overriding a by-hand canonical delete (scheduling-invariants Rule 0). Deleting a
turnover now DISMISSES its booking, and the generator skips a dismissed booking.
Only the explicit human delete dismisses; the automatic false-cancel recovery
never does, so a system hiccup still can't silently drop a real cleaning
(TestResurrectCancelledTurnover in test_ical_sync_str_fix.py still passes).
"""
import uuid
import datetime as dt
from datetime import date, timedelta
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, ICalEvent
from integrations.ical_sync import _sync_ical_url, dismiss_booking_for_job
from modules.auth.router import get_current_user, current_org_id


@pytest.fixture(autouse=True)
def _stub_ssrf_dns():
    with patch("integrations.ical_sync._assert_public_url", return_value=None):
        yield


def _mock_feed(checkin, checkout, uid, summary="Reserved"):
    ics = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:{uid}
DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}
SUMMARY:{summary}
END:VEVENT
END:VCALENDAR""".encode()

    class _Ctx:
        def __enter__(self):
            self._p = [
                patch("integrations.ical_sync._httpx.Client"),
                patch("integrations.google_calendar.create_event", return_value=None),
                patch("integrations.google_calendar.update_event", return_value=None),
                patch("integrations.google_calendar.delete_event", return_value=True),
            ]
            mc = self._p[0].start()
            for p in self._p[1:]:
                p.start()
            resp = MagicMock(); resp.content = ics; resp.raise_for_status = MagicMock()
            mc.return_value.__enter__.return_value.get.return_value = resp
            return self

        def __exit__(self, *a):
            for p in reversed(self._p):
                p.stop()

    return _Ctx()


def _seed_str_property(db):
    c = Client(name=f"Spin Drift {uuid.uuid4().hex[:6]}", email="t@example.com", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    prop = Property(client_id=c.id, name="Wells rental", address="9 Shore Rd",
                    property_type="str", org_id=1)
    db.add(prop); db.commit(); db.refresh(prop)
    return c, prop


# ── unit ────────────────────────────────────────────────────────────────────
def test_dismiss_marks_booking_and_unlinks():
    db = SessionLocal()
    try:
        c, prop = _seed_str_property(db)
        job = Job(client_id=c.id, property_id=prop.id, job_type="str_turnover",
                  title="Turnover", status="scheduled",
                  scheduled_date=dt.date.today() + timedelta(days=12), org_id=1)
        db.add(job); db.commit(); db.refresh(job)
        ev = ICalEvent(property_id=prop.id, uid="u1@feed", event_type="reservation",
                       checkout_date=job.scheduled_date.isoformat(), job_id=job.id, org_id=1)
        db.add(ev); db.commit(); db.refresh(ev)

        n = dismiss_booking_for_job(db, job, actor="office delete")
        db.commit(); db.refresh(ev)
        assert n == 1
        assert ev.dismissed_at is not None
        assert ev.dismissed_by == "office delete"
        assert ev.job_id is None
        # Idempotent: re-dismiss keeps the first timestamp, still no-throw.
        first = ev.dismissed_at
        dismiss_booking_for_job(db, job, actor="again")
        db.commit(); db.refresh(ev)
        assert ev.dismissed_at == first
    finally:
        db.query(ICalEvent).filter(ICalEvent.property_id == prop.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.property_id == prop.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_dismiss_is_noop_for_non_turnover():
    db = SessionLocal()
    try:
        c, prop = _seed_str_property(db)
        job = Job(client_id=c.id, property_id=prop.id, job_type="residential",
                  title="Reg", status="scheduled", org_id=1)
        db.add(job); db.commit(); db.refresh(job)
        assert dismiss_booking_for_job(db, job) == 0
    finally:
        db.query(Job).filter(Job.title == "Reg").delete(synchronize_session=False)
        db.commit(); db.close()


# ── generator: dismissed booking is not regenerated ───────────────────────────
def test_dismissed_booking_is_not_recreated_on_next_sync():
    db = SessionLocal()
    try:
        _, prop = _seed_str_property(db)
        checkin = date.today() + timedelta(days=10)
        checkout = date.today() + timedelta(days=12)
        url = "https://www.airbnb.com/calendar/ical/dz.ics?s=abc"

        with _mock_feed(checkin, checkout, "dz@feed"):
            r1 = _sync_ical_url(db, prop, url, ical_source_label="airbnb")
        assert r1["jobs_created"] == 1
        job = db.query(Job).filter_by(property_id=prop.id).first()

        # Office deletes the turnover: dismiss its booking, then hard-delete the
        # job (what delete_job does).
        dismiss_booking_for_job(db, job, actor="office delete")
        db.delete(job); db.commit()

        # Next sync must NOT resurrect it, and must not flag it as a missing
        # turnover — the booking is dismissed, so "no cleaning" is intended.
        with _mock_feed(checkin, checkout, "dz@feed"):
            r2 = _sync_ical_url(db, prop, url, ical_source_label="airbnb")
        assert r2["jobs_created"] == 0
        assert r2["missing_turnovers"] == []
        live = db.query(Job).filter_by(property_id=prop.id).filter(
            Job.status != "cancelled").count()
        assert live == 0
    finally:
        db.query(ICalEvent).filter(ICalEvent.property_id == prop.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.property_id == prop.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
        db.commit(); db.close()


# ── endpoint: DELETE dismisses the linked booking ─────────────────────────────
class _Admin:
    id, org_id, role, status, active = 7911, 1, "admin", "active", True
    email = "dismiss-admin@example.com"


def test_delete_endpoint_dismisses_booking():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    db = SessionLocal()
    try:
        c, prop = _seed_str_property(db)
        job = Job(client_id=c.id, property_id=prop.id, job_type="str_turnover",
                  title="Turnover", status="scheduled",
                  scheduled_date=dt.date.today() + timedelta(days=12), org_id=1)
        db.add(job); db.commit(); db.refresh(job)
        ev = ICalEvent(property_id=prop.id, uid="del@feed", event_type="reservation",
                       checkout_date=job.scheduled_date.isoformat(), job_id=job.id, org_id=1)
        db.add(ev); db.commit(); db.refresh(ev)
        jid, evid = job.id, ev.id

        r = api.delete(f"/api/jobs/{jid}")
        assert r.status_code == 204, r.text

        db2 = SessionLocal()
        got = db2.query(ICalEvent).filter_by(id=evid).first()
        assert got is not None                      # booking row survives the job delete
        assert got.dismissed_at is not None         # …marked dismissed
        assert got.job_id is None
        assert db2.query(Job).filter_by(id=jid).first() is None  # job hard-deleted
        db2.close()
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)
        db.query(ICalEvent).filter(ICalEvent.property_id == prop.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.property_id == prop.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
        db.commit(); db.close()
