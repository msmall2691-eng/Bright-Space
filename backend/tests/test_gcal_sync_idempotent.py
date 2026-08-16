"""GCal sync must be idempotent: a poll that finds no real change flags no drift.

Regression for the string-vs-date churn bug — _parse_event_datetime used to
return string dates, so `new_date != job.scheduled_date` (str vs Date column) was
always True and every poll rewrote a string into the column and bumped
jobs_updated. Phase 1 of the reconciliation plan returns real date/time objects.

calendar_source_of_truth='google' (legacy two-way pull, where a Google-side
edit overwrites the linked Job) is hard-blocked in code — sync_calendar()
raises GoogleWritebackDisabled immediately rather than running at all — per
scheduling-invariants Rule 0 / R2 (no writeback from a projection). So the
date-parsing regressions below are now exercised through the 'brightbase'
(default, only-supported) mode: the same _parse_event_datetime comparison
runs to decide drift_detected instead of jobs_updated, which is the actual
reachable code path today.
"""
from datetime import date, time
from unittest.mock import patch, MagicMock

import pytest

from database.db import SessionLocal
from database.models import Client, Job, Property


def _service_returning(events):
    """A fake Google service whose events().list().execute() yields `events`."""
    svc = MagicMock()
    svc.events.return_value.list.return_value.execute.return_value = {"items": events}
    return svc


def _run_sync(db, events, source="brightbase"):
    from integrations import gcal_sync
    with patch("integrations.google_calendar._get_service", return_value=_service_returning(events)), \
         patch("integrations.gcal_sync.calendar_source_of_truth", return_value=source):
        return gcal_sync.sync_calendar(db, calendar_ids=["primary"])


def test_google_source_of_truth_is_hard_blocked():
    """calendar_source_of_truth='google' must never run sync_calendar() at
    all — it's a hard block, not a silent no-op, so a future accidental
    re-enable of two-way pull fails loudly instead of quietly working."""
    from integrations import gcal_sync
    db = SessionLocal()
    try:
        with pytest.raises(gcal_sync.GoogleWritebackDisabled):
            _run_sync(db, [{"id": "evt_blocked", "status": "confirmed",
                             "summary": "x", "start": {"date": "2026-07-10"}}],
                      source="google")
    finally:
        db.close()


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

        r1 = _run_sync(db, [event], source="brightbase")
        assert r1["jobs_updated"] == 0, "brightbase mode never writes back"
        assert r1["drift_detected"] == 0, "first identical poll should flag no drift"
        r2 = _run_sync(db, [event], source="brightbase")
        assert r2["jobs_updated"] == 0
        assert r2["drift_detected"] == 0, "second identical poll should also flag no drift"

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


def test_sync_flags_a_real_date_change_as_drift_not_applied():
    """A real Google-side move is detected as drift exactly once and NOT
    applied to the job — 'google' (legacy pull) would have applied it, but
    that mode is hard-blocked; 'brightbase' is the only reachable mode."""
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
        r1 = _run_sync(db, [moved], source="brightbase")
        assert r1["jobs_updated"] == 0, "brightbase mode never writes back"
        assert r1["drift_detected"] == 1, "the real move must be flagged as drift"
        db.refresh(job)
        assert job.scheduled_date == date(2026, 7, 10), "job stays as BrightBase has it, NOT overwritten"
        # Re-polling the same (still-drifted) event keeps flagging it — the
        # job never got a chance to churn since it was never written.
        r2 = _run_sync(db, [moved], source="brightbase")
        assert r2["jobs_updated"] == 0
        assert r2["drift_detected"] == 1
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
        r1 = _run_sync(db, [event], source="brightbase")
        assert r1["drift_detected"] == 0, "13:00Z must match the stored 09:00 EDT — no false drift"
        r2 = _run_sync(db, [event], source="brightbase")
        assert r2["drift_detected"] == 0

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


def test_sync_preserves_non_eastern_property_wall_clock():
    """An event in a NON-Eastern property's timezone must keep its property-local
    wall clock — not get rewritten to the Eastern hour every sync.

    Regression for the over-eager BUSINESS_TZ conversion: a 09:00 Pacific event
    comes back as 09:00:00-07:00 with timeZone America/Los_Angeles. Forcing it to
    Eastern would store 12:00 and churn forever. With the event's own timeZone
    honored, 09:00 stays 09:00.
    """
    db = SessionLocal()
    try:
        client = Client(name="GCal PT Test", email="pttz@example.com")
        db.add(client); db.commit(); db.refresh(client)
        prop = Property(client_id=client.id, name="P", address="1 Test St",
                        property_type="residential", active=True)
        db.add(prop); db.commit(); db.refresh(prop)
        # Job stored at the property-local Pacific time (09:00 PT).
        job = Job(
            client_id=client.id, property_id=prop.id, job_type="residential", title="PT Clean",
            scheduled_date=date(2026, 7, 10), start_time=time(9, 0), end_time=time(12, 0),
            address="", gcal_event_id="evt_pt_1", status="scheduled",
        )
        db.add(job); db.commit(); db.refresh(job)

        # Google echoes the property timezone alongside the offset-form dateTime.
        event = {
            "id": "evt_pt_1",
            "status": "confirmed",
            "summary": "PT Clean",
            "start": {"dateTime": "2026-07-10T09:00:00-07:00", "timeZone": "America/Los_Angeles"},
            "end": {"dateTime": "2026-07-10T12:00:00-07:00", "timeZone": "America/Los_Angeles"},
        }
        r1 = _run_sync(db, [event], source="brightbase")
        assert r1["drift_detected"] == 0, "09:00 PT must stay 09:00 — not falsely flagged vs 12:00 Eastern"
        db.refresh(job)
        assert job.scheduled_date == date(2026, 7, 10)
        assert job.start_time == time(9, 0)
        assert job.end_time == time(12, 0)
    finally:
        db.rollback()
        db.query(Job).filter(Job.gcal_event_id == "evt_pt_1").delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_brightbase_wins_ignores_external_reschedule():
    """Default source-of-truth: a reschedule made directly in Google is surfaced
    as drift, NOT applied over the job. Cancellations still propagate."""
    db = SessionLocal()
    client = Client(name="SoT Test", email="sot@example.com")
    db.add(client); db.commit(); db.refresh(client)
    try:
        prop = Property(client_id=client.id, name="P", address="1 SoT St",
                        property_type="residential", active=True)
        db.add(prop); db.commit(); db.refresh(prop)
        job = Job(client_id=client.id, property_id=prop.id, job_type="residential", title="SoT Clean",
                  scheduled_date=date(2026, 7, 10), start_time=time(10, 0), end_time=time(13, 0),
                  address="", gcal_event_id="evt_sot_1", status="scheduled")
        db.add(job); db.commit(); db.refresh(job)

        moved = {
            "id": "evt_sot_1", "status": "confirmed", "summary": "SoT Clean",
            "iCalUID": "sot-uid-1", "updated": "2026-06-14T03:00:00Z",
            "start": {"dateTime": "2026-07-12T10:00:00-04:00"},
            "end": {"dateTime": "2026-07-12T13:00:00-04:00"},
        }
        r = _run_sync(db, [moved])  # default = brightbase wins
        assert r["jobs_updated"] == 0
        assert r["drift_detected"] == 1
        db.refresh(job)
        assert job.scheduled_date == date(2026, 7, 10)   # NOT overwritten
        assert job.gcal_ical_uid == "sot-uid-1"          # iCalUID captured

        # A cancellation in Google still wins even when BrightBase is master.
        cancelled = {"id": "evt_sot_1", "status": "cancelled", "iCalUID": "sot-uid-1"}
        rc = _run_sync(db, [cancelled])
        assert rc["jobs_cancelled"] == 1
        db.refresh(job)
        assert job.status == "cancelled"
    finally:
        db.rollback()
        db.query(Job).filter(Job.gcal_event_id == "evt_sot_1").delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_ical_uid_relinks_recreated_event_no_duplicate():
    """An event whose id changed but whose iCalUID we already know relinks the
    same job instead of creating a duplicate."""
    db = SessionLocal()
    client = Client(name="UID Test", email="uid@example.com")
    db.add(client); db.commit(); db.refresh(client)
    try:
        prop = Property(client_id=client.id, name="P", address="1 UID St",
                        property_type="residential", active=True)
        db.add(prop); db.commit(); db.refresh(prop)
        job = Job(client_id=client.id, property_id=prop.id, job_type="residential", title="UID Clean",
                  scheduled_date=date(2026, 7, 10), start_time=time(10, 0), end_time=time(13, 0),
                  address="", gcal_event_id="old_evt", gcal_ical_uid="uid-keep-1", status="scheduled")
        db.add(job); db.commit(); db.refresh(job)

        recreated = {
            "id": "new_evt", "status": "confirmed", "summary": "UID Clean", "iCalUID": "uid-keep-1",
            "start": {"dateTime": "2026-07-10T10:00:00-04:00"},
            "end": {"dateTime": "2026-07-10T13:00:00-04:00"},
        }
        r = _run_sync(db, [recreated])
        assert r["proposals_created"] == 0       # no duplicate proposal or job
        db.refresh(job)
        assert job.gcal_event_id == "new_evt"    # relinked to the new event id
    finally:
        db.rollback()
        db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
        db.commit(); db.close()
