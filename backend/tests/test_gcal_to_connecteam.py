"""A reschedule made directly in Google Calendar must reach Connecteam within
the same sync tick (not just the 30-min drift reconcile) — but only when Google
is the source of truth. Under the "brightbase" default a Google edit is drift
and never touches the job, so nothing propagates.

Hermetic: the Google service, Connecteam config gate, and the resync/dispatch
helpers are patched — no network.
"""
from datetime import date, time
from unittest.mock import patch, MagicMock

from database.db import SessionLocal
from database.models import Client, Job, Property


def _service_returning(events):
    svc = MagicMock()
    svc.events.return_value.list.return_value.execute.return_value = {"items": events}
    return svc


def _run_sync(db, events, source, resync_spy, dispatch_spy):
    from integrations import gcal_sync
    with patch("integrations.google_calendar._get_service", return_value=_service_returning(events)), \
         patch("integrations.gcal_sync.calendar_source_of_truth", return_value=source), \
         patch("integrations.connecteam.is_configured", return_value=True), \
         patch("modules.settings.router.connecteam_auto_dispatch_enabled", return_value=True), \
         patch("integrations.connecteam_auto.resync_job", resync_spy), \
         patch("integrations.connecteam_auto.auto_dispatch_job", dispatch_spy):
        return gcal_sync.sync_calendar(db, calendar_ids=["primary"])


def _setup(db, **job_over):
    client = Client(name="GCal→CT", email="gct@example.com")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="P", address="1 Test St",
                    property_type="residential", active=True)
    db.add(prop); db.commit(); db.refresh(prop)
    base = dict(
        client_id=client.id, property_id=prop.id, job_type="residential",
        title="Clean", scheduled_date=date(2026, 7, 10), start_time=time(10, 0),
        end_time=time(13, 0), address="", gcal_event_id="evt_ct_1", status="scheduled",
    )
    base.update(job_over)
    job = Job(**base)
    db.add(job); db.commit(); db.refresh(job)
    return client, prop, job


def _cleanup(db, client):
    db.query(Job).filter(Job.gcal_event_id == "evt_ct_1").delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()


def _moved_event():
    return {
        "id": "evt_ct_1", "status": "confirmed", "summary": "Clean",
        "start": {"dateTime": "2026-07-14T10:00:00-04:00"},  # moved 10th → 14th
        "end": {"dateTime": "2026-07-14T13:00:00-04:00"},
    }


def test_google_reschedule_resyncs_existing_connecteam_shift():
    db = SessionLocal()
    resync_spy = MagicMock()
    dispatch_spy = MagicMock()
    try:
        client, prop, job = _setup(db, connecteam_shift_ids=["shift_a"])
        r = _run_sync(db, [_moved_event()], "google", resync_spy, dispatch_spy)
        assert r["jobs_updated"] == 1
        assert r.get("connecteam_resynced") == 1
        resync_spy.assert_called_once()          # existing shift → re-timed
        dispatch_spy.assert_not_called()
        db.refresh(job)
        assert job.scheduled_date == date(2026, 7, 14)
    finally:
        db.rollback(); _cleanup(db, client); db.close()


def test_google_reschedule_dispatches_when_not_yet_on_connecteam():
    db = SessionLocal()
    resync_spy = MagicMock()
    dispatch_spy = MagicMock()
    try:
        client, prop, job = _setup(db, connecteam_shift_ids=None)
        r = _run_sync(db, [_moved_event()], "google", resync_spy, dispatch_spy)
        assert r.get("connecteam_resynced") == 1
        dispatch_spy.assert_called_once()        # first time reaching Connecteam
        resync_spy.assert_not_called()
    finally:
        db.rollback(); _cleanup(db, client); db.close()


def test_brightbase_source_does_not_propagate_google_edits():
    """Default source-of-truth: a Google edit is drift, the job is untouched, and
    nothing is pushed to Connecteam."""
    db = SessionLocal()
    resync_spy = MagicMock()
    dispatch_spy = MagicMock()
    try:
        client, prop, job = _setup(db, connecteam_shift_ids=["shift_a"])
        r = _run_sync(db, [_moved_event()], "brightbase", resync_spy, dispatch_spy)
        assert "connecteam_resynced" not in r
        resync_spy.assert_not_called()
        dispatch_spy.assert_not_called()
        db.refresh(job)
        assert job.scheduled_date == date(2026, 7, 10)  # unchanged
    finally:
        db.rollback(); _cleanup(db, client); db.close()
