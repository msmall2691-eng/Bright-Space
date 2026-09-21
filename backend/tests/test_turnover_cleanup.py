"""Turnover cleanup + the Rule-0 fix that stopped the mess.

Two things ship together (see PR): the iCal sync no longer drags a manually
moved turnover back onto the booking's checkout date (scheduling-invariants
Rule 0 — the feed is an inbox, it must not override a canonical human move),
and there's a human-confirmed purge for the cancelled turnover *ghosts* the old
behaviour left piled on one date.
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import patch, MagicMock

from database.db import SessionLocal
from database.models import Property, ICalEvent, Job, Client, Invoice, Activity
from integrations.ical_sync import _sync_ical_url
from services.turnover_cleanup import (
    preview_cancelled_turnovers, purge_cancelled_turnovers,
)


def _run_feed(db, prop, checkin, checkout, uid):
    """Run one iCal sync with a single future booking, all network + GCal mocked."""
    ics = (
        "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n"
        f"UID:{uid}\n"
        f"DTSTART;VALUE=DATE:{checkin.strftime('%Y%m%d')}\n"
        f"DTEND;VALUE=DATE:{checkout.strftime('%Y%m%d')}\n"
        "SUMMARY:Reserved\nEND:VEVENT\nEND:VCALENDAR"
    ).encode()
    with patch("integrations.ical_sync._assert_public_url", return_value=None), \
         patch("integrations.ical_sync._httpx.Client") as mock_client_class, \
         patch("integrations.ical_sync._push_turnover_to_gcal", return_value=True), \
         patch("integrations.google_calendar.create_event", return_value=None):
        resp = MagicMock()
        resp.content = ics
        resp.raise_for_status = MagicMock()
        mock_client_class.return_value.__enter__.return_value.get.return_value = resp
        return _sync_ical_url(db, prop, "https://example.com/feed.ics?s=1",
                              ical_source_label="airbnb")


def _seed_str_property(db, name="Wells rental"):
    # Unique email per run: the test DB file persists across pytest invocations,
    # so a fixed address would trip Client's unique-email guard on a re-run.
    client = Client(name="C", email=f"{uuid.uuid4().hex[:10]}@example.com")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name=name, address="729 Ocean Ave",
                    property_type="str")
    db.add(prop); db.commit(); db.refresh(prop)
    return client, prop


class TestMovedTurnoverStaysPut:
    """Rule 0: a turnover the office moved off the checkout keeps its date."""

    def test_moved_turnover_is_not_reverted_by_sync(self):
        db = SessionLocal()
        try:
            client, prop = _seed_str_property(db)
            checkin = date.today() + timedelta(days=14)
            checkout = date.today() + timedelta(days=16)
            moved = checkout + timedelta(days=2)   # office pushed the cleaning out
            job = Job(client_id=client.id, property_id=prop.id, job_type="str_turnover",
                      title="Turnover — Wells rental", scheduled_date=moved,
                      start_time=time(10, 0), status="scheduled", address=prop.address)
            db.add(job); db.commit(); db.refresh(job)
            ev = ICalEvent(property_id=prop.id, uid="wells@feed", event_type="reservation",
                           checkout_date=checkout.isoformat(), checkin_date=checkin.isoformat(),
                           job_id=job.id, org_id=prop.org_id)
            db.add(ev); db.commit()

            _run_feed(db, prop, checkin, checkout, uid="wells@feed")

            db.refresh(job)
            # The feed did NOT drag it back to the checkout date.
            assert job.scheduled_date == moved
        finally:
            db.close()

    def test_turnover_with_no_date_is_filled_from_feed(self):
        db = SessionLocal()
        try:
            client, prop = _seed_str_property(db, name="Pier House")
            checkin = date.today() + timedelta(days=10)
            checkout = date.today() + timedelta(days=12)
            job = Job(client_id=client.id, property_id=prop.id, job_type="str_turnover",
                      title="Turnover — Pier House", scheduled_date=None,
                      status="scheduled", address=prop.address)
            db.add(job); db.commit(); db.refresh(job)
            ev = ICalEvent(property_id=prop.id, uid="pier@feed", event_type="reservation",
                           checkout_date=checkout.isoformat(), checkin_date=checkin.isoformat(),
                           job_id=job.id, org_id=prop.org_id)
            db.add(ev); db.commit()

            _run_feed(db, prop, checkin, checkout, uid="pier@feed")

            db.refresh(job)
            # A genuinely date-less turnover still gets pinned to the checkout.
            assert job.scheduled_date == checkout
        finally:
            db.close()


class TestPurgeCancelledTurnovers:
    """The human-confirmed ghost sweep: only cancelled turnovers, never billed
    ones, never live work, never a non-turnover job."""

    def test_preview_and_purge_only_touch_cancelled_turnover_ghosts(self):
        db = SessionLocal()
        try:
            client, prop = _seed_str_property(db, name="Ghosttown")
            co = (date.today() + timedelta(days=5))

            def mk(job_type, status):
                j = Job(client_id=client.id, property_id=prop.id, job_type=job_type,
                        title="x", scheduled_date=co, status=status, address="a")
                db.add(j); db.commit(); db.refresh(j)
                return j

            ghost1 = mk("str_turnover", "cancelled")
            ghost2 = mk("str_turnover", "cancelled")
            live = mk("str_turnover", "scheduled")            # not cancelled
            resi = mk("residential", "cancelled")             # not a turnover
            billed = mk("str_turnover", "cancelled")          # cancelled turnover WITH an invoice

            db.add(Invoice(client_id=client.id, job_id=billed.id,
                           invoice_number=f"INV-{uuid.uuid4().hex[:8]}"))
            # A ghost with an activity + a still-linked iCal event — the FK
            # children the purge has to unlink before it can delete.
            db.add(Activity(job_id=ghost1.id, activity_type="job_cancelled"))
            db.add(ICalEvent(property_id=prop.id, uid="ghost-evt", event_type="reservation",
                             checkout_date=co.isoformat(), job_id=ghost1.id, org_id=prop.org_id))
            db.commit()
            act_id = db.query(Activity).filter_by(job_id=ghost1.id).first().id

            preview = preview_cancelled_turnovers(db, org_id=None, property_id=prop.id)
            assert preview["count"] == 2                       # only the two pure ghosts
            assert set(preview["sample_ids"]) == {ghost1.id, ghost2.id}

            # batch_size=1 exercises the multi-batch commit loop.
            res = purge_cancelled_turnovers(db, org_id=None, property_id=prop.id, batch_size=1)
            assert res["deleted"] == 2

            # Ghosts gone; everything else survives.
            assert db.query(Job).filter(Job.id.in_([ghost1.id, ghost2.id])).count() == 0
            assert db.query(Job).filter_by(id=live.id).count() == 1
            assert db.query(Job).filter_by(id=resi.id).count() == 1
            assert db.query(Job).filter_by(id=billed.id).count() == 1   # invoice preserved it
            # The activity row survives, detached from the deleted job.
            act = db.query(Activity).filter_by(id=act_id).first()
            assert act is not None and act.job_id is None
        finally:
            db.close()
