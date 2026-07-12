"""Recurring-schedule cancellation paths must release GCal/Connecteam sync
links, not just flip status='cancelled' (audit finding #2, July 2026).

Before this fix, skip/reschedule/"all visits"/"this and future" all
cancelled the Job row in the DB but left its gcal_event_id and
connecteam_shift_ids untouched. generate_jobs() then created a NEW event/
shift for the regenerated occurrence, so cleaners kept a stale Connecteam
shift for the old slot and the calendar showed both occurrences.

Hermetic: integrations.google_calendar.delete_event and
integrations.connecteam_auto.remove_job_from_connecteam are monkeypatched —
no network calls.
"""
import uuid
from datetime import date, time, timedelta

import pytest

import integrations.google_calendar as gcal
import integrations.connecteam_auto as connecteam_auto
from database.db import SessionLocal, engine
from database.models import (
    Base, Client, Property, RecurringSchedule, Job, RecurrenceException,
)
from modules.recurring.router import (
    _release_sync_links, _cancel_existing_job, _resync_future_jobs,
    split_schedule, ScheduleSplit,
)


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_test_schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def fresh_client_property():
    db = SessionLocal()
    client = Client(name=f"SyncCleanup {uuid.uuid4().hex[:6]}", status="active")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="Sync Cleanup Home",
                     address="9 Cleanup Ln", property_type="residential")
    db.add(prop); db.commit(); db.refresh(prop)
    yield client, prop
    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id.in_(
            db.query(RecurringSchedule.id).filter(RecurringSchedule.client_id == client.id)
        )
    ).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == client.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _make_schedule(db, client, prop):
    today_dow = date.today().weekday()
    sched = RecurringSchedule(
        client_id=client.id, property_id=prop.id, job_type="residential",
        title="Sync Cleanup Clean", address=prop.address, frequency="weekly",
        interval_weeks=1, days_of_week=[today_dow], day_of_week=today_dow,
        start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=[],
        generate_weeks_ahead=4, active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    return sched


def _make_synced_job(db, sched, client, prop, *, on_date):
    job = Job(
        client_id=client.id, property_id=prop.id, recurring_schedule_id=sched.id,
        job_type="residential", title=sched.title, address=prop.address,
        scheduled_date=on_date, start_time=time(9, 0), end_time=time(11, 0),
        status="scheduled", cleaner_ids=[],
        gcal_event_id="gcal_evt_123", connecteam_shift_ids=["ct_shift_456"],
        dispatched=True,
    )
    db.add(job); db.commit(); db.refresh(job)
    return job


# ---------------------------------------------------------------------------
# _release_sync_links (the shared helper) in isolation
# ---------------------------------------------------------------------------

def test_release_sync_links_clears_gcal_event_id_on_successful_delete(fresh_client_property, monkeypatch):
    client, prop = fresh_client_property
    db = SessionLocal()
    sched = _make_schedule(db, client, prop)
    job = _make_synced_job(db, sched, client, prop, on_date=date.today())

    monkeypatch.setattr(gcal, "delete_event", lambda *a, **k: True)
    monkeypatch.setattr(connecteam_auto, "remove_job_from_connecteam", lambda *a, **k: {"removed": True})

    _release_sync_links(db, job)
    assert job.gcal_event_id is None
    db.close()


def test_release_sync_links_keeps_gcal_event_id_on_failed_delete(fresh_client_property, monkeypatch):
    """A failed GCal delete must NOT clear gcal_event_id — otherwise the
    reconcile sweep loses track of the orphaned event and it's never retried."""
    client, prop = fresh_client_property
    db = SessionLocal()
    sched = _make_schedule(db, client, prop)
    job = _make_synced_job(db, sched, client, prop, on_date=date.today())

    monkeypatch.setattr(gcal, "delete_event", lambda *a, **k: False)
    monkeypatch.setattr(connecteam_auto, "remove_job_from_connecteam", lambda *a, **k: {"removed": True})

    _release_sync_links(db, job)
    assert job.gcal_event_id == "gcal_evt_123"
    db.close()


def test_release_sync_links_calls_remove_job_from_connecteam(fresh_client_property, monkeypatch):
    client, prop = fresh_client_property
    db = SessionLocal()
    sched = _make_schedule(db, client, prop)
    job = _make_synced_job(db, sched, client, prop, on_date=date.today())

    monkeypatch.setattr(gcal, "delete_event", lambda *a, **k: True)
    calls = []
    monkeypatch.setattr(connecteam_auto, "remove_job_from_connecteam",
                        lambda db_, j, **k: calls.append(j.id) or {"removed": True})

    _release_sync_links(db, job)
    assert calls == [job.id]
    db.close()


def test_release_sync_links_is_a_noop_when_nothing_synced(fresh_client_property, monkeypatch):
    """Jobs with no gcal_event_id/connecteam_shift_ids shouldn't trigger any
    external call at all — the common case for never-dispatched jobs."""
    client, prop = fresh_client_property
    db = SessionLocal()
    sched = _make_schedule(db, client, prop)
    job = Job(
        client_id=client.id, property_id=prop.id, recurring_schedule_id=sched.id,
        job_type="residential", title=sched.title, address=prop.address,
        scheduled_date=date.today(), start_time=time(9, 0), end_time=time(11, 0),
        status="scheduled", cleaner_ids=[],
    )
    db.add(job); db.commit(); db.refresh(job)

    def _boom(*a, **k):
        raise AssertionError("should not be called")
    monkeypatch.setattr(gcal, "delete_event", _boom)
    monkeypatch.setattr(connecteam_auto, "remove_job_from_connecteam", _boom)

    _release_sync_links(db, job)  # must not raise
    db.close()


# ---------------------------------------------------------------------------
# The 3 call sites actually invoke it
# ---------------------------------------------------------------------------

def test_skip_exception_releases_sync_links(fresh_client_property, monkeypatch):
    client, prop = fresh_client_property
    db = SessionLocal()
    sched = _make_schedule(db, client, prop)
    target_date = date.today()
    _make_synced_job(db, sched, client, prop, on_date=target_date)

    monkeypatch.setattr(gcal, "delete_event", lambda *a, **k: True)
    # Both call sites below also regenerate the freed-up date via
    # generate_jobs(), which pushes the NEW job to GCal — stub that too so
    # the test doesn't depend on whatever integrations.google_calendar
    # happens to be bound to elsewhere in the suite (some other test module
    # replaces it with a bare MagicMock at import time; a MagicMock return
    # value isn't JSON-serializable and would blow up the activity-log
    # insert for the regenerated job).
    monkeypatch.setattr(gcal, "create_event", lambda *a, **k: None)
    connecteam_calls = []
    monkeypatch.setattr(connecteam_auto, "remove_job_from_connecteam",
                        lambda db_, j, **k: connecteam_calls.append(j.id) or {"removed": True})

    _cancel_existing_job(db, sched.id, target_date, "test skip")

    job = db.query(Job).filter(Job.recurring_schedule_id == sched.id, Job.scheduled_date == target_date).first()
    assert job.status == "cancelled"
    assert job.gcal_event_id is None
    assert connecteam_calls == [job.id]
    db.commit()
    db.close()


def test_resync_future_jobs_releases_sync_links(fresh_client_property, monkeypatch):
    client, prop = fresh_client_property
    db = SessionLocal()
    sched = _make_schedule(db, client, prop)
    future_date = date.today() + timedelta(days=7)
    synced_job = _make_synced_job(db, sched, client, prop, on_date=future_date)

    monkeypatch.setattr(gcal, "delete_event", lambda *a, **k: True)
    # Both call sites below also regenerate the freed-up date via
    # generate_jobs(), which pushes the NEW job to GCal — stub that too so
    # the test doesn't depend on whatever integrations.google_calendar
    # happens to be bound to elsewhere in the suite (some other test module
    # replaces it with a bare MagicMock at import time; a MagicMock return
    # value isn't JSON-serializable and would blow up the activity-log
    # insert for the regenerated job).
    monkeypatch.setattr(gcal, "create_event", lambda *a, **k: None)
    connecteam_calls = []
    monkeypatch.setattr(connecteam_auto, "remove_job_from_connecteam",
                        lambda db_, j, **k: connecteam_calls.append(j.id) or {"removed": True})

    _resync_future_jobs(db, sched)

    db.refresh(synced_job)
    assert synced_job.status == "cancelled"
    assert synced_job.gcal_event_id is None
    assert connecteam_calls == [synced_job.id]
    db.commit()
    db.close()


def test_split_schedule_releases_sync_links(fresh_client_property, monkeypatch):
    client, prop = fresh_client_property
    db = SessionLocal()
    sched = _make_schedule(db, client, prop)
    split_date = date.today() + timedelta(days=7)
    synced_job = _make_synced_job(db, sched, client, prop, on_date=split_date)

    monkeypatch.setattr(gcal, "delete_event", lambda *a, **k: True)
    # Both call sites below also regenerate the freed-up date via
    # generate_jobs(), which pushes the NEW job to GCal — stub that too so
    # the test doesn't depend on whatever integrations.google_calendar
    # happens to be bound to elsewhere in the suite (some other test module
    # replaces it with a bare MagicMock at import time; a MagicMock return
    # value isn't JSON-serializable and would blow up the activity-log
    # insert for the regenerated job).
    monkeypatch.setattr(gcal, "create_event", lambda *a, **k: None)
    connecteam_calls = []
    monkeypatch.setattr(connecteam_auto, "remove_job_from_connecteam",
                        lambda db_, j, **k: connecteam_calls.append(j.id) or {"removed": True})

    split_schedule(sched.id, ScheduleSplit(split_date=split_date), db=db, org_id=1)

    db.refresh(synced_job)
    assert synced_job.status == "cancelled"
    assert synced_job.gcal_event_id is None
    assert connecteam_calls == [synced_job.id]
    db.close()
