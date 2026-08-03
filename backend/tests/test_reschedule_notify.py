"""Per-move customer notification control — the explicit per-move OVERRIDE.

BrightBase now makes reschedules silent-by-default (Settings "email on move" is
off) for one-time, recurring, and bulk moves. On top of that settings default,
this branch adds an explicit per-move choice — the JobEditModal "Notify customer
of this change" checkbox — carried as `notify_customer` on the request:

  1. One-time jobs (update_job / JobUpdate.notify_customer): an explicit
     True/False overrides the in-place-move sendUpdates for that one call.
  2. Recurring occurrences (add_reschedule_exception / ExceptionCreate
     .notify_customer): the same override, applied on top of the in-place
     "carry the event" move (main's #653) — True/False wins, None falls back to
     the Settings default.

The tests capture the exact Google `sendUpdates` so they assert the
customer-facing effect. (Main's test_recurring_inplace_move.py already covers
the settings-driven recurring core; this file covers the per-request override.)
"""
import uuid
from datetime import date, time
from unittest.mock import patch, MagicMock

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, RecurringSchedule, RecurrenceException, Activity
from modules.settings.router import set_setting
from modules.scheduling.router import update_job, JobUpdate
from modules.recurring.router import add_reschedule_exception, ExceptionCreate


@pytest.fixture
def notify_defaults():
    """Pin the automation settings this feature reads to their documented
    defaults (invite on, master notify on, email-on-move OFF) so the assertions
    don't depend on whatever another test left behind. Cleaned up after."""
    db = SessionLocal()
    set_setting(db, "invite_customers", "true")
    set_setting(db, "notify_customers", "true")
    set_setting(db, "notify_customers_on_move", "false")
    db.commit()
    yield db
    from database.models import AppSetting
    for k in ("invite_customers", "notify_customers", "notify_customers_on_move"):
        db.query(AppSetting).filter(AppSetting.key == k).delete(synchronize_session=False)
    db.commit(); db.close()


def _cleanup(db, *, client_id, schedule_id=None):
    job_ids = [r[0] for r in db.query(Job.id).filter(Job.client_id == client_id).all()]
    if job_ids:
        db.query(Activity).filter(Activity.job_id.in_(job_ids)).delete(synchronize_session=False)
    if schedule_id is not None:
        db.query(RecurrenceException).filter(RecurrenceException.recurring_schedule_id == schedule_id).delete(synchronize_session=False)
        db.query(Job).filter(Job.recurring_schedule_id == schedule_id).delete(synchronize_session=False)
        db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == client_id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == client_id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
    db.commit()


# ── One-time job (update_job / JobUpdate.notify_customer) ─────────────────────

def _seed_oneoff(db):
    c = Client(name=f"Ntfy {uuid.uuid4().hex[:6]}", email="cust@example.com",
               status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Ntfy Ave",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Visit", job_type="residential",
            scheduled_date=date(2026, 9, 1), start_time=time(10, 0), end_time=time(12, 0),
            status="scheduled", gcal_event_id="evt-oneoff", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def _move_oneoff(db, job_id, **update_kwargs):
    """Move the job a week out and capture the sendUpdates passed to Google."""
    with patch("integrations.google_calendar.update_event", MagicMock(return_value=True)) as upd:
        update_job(job_id, JobUpdate(scheduled_date="2026-09-08", allow_conflicts=True, **update_kwargs),
                   db=db, org_id=1)
    assert upd.called, "expected a Google Calendar update on a move"
    return upd.call_args.kwargs.get("send_updates")


def test_oneoff_move_is_silent_by_default(notify_defaults):
    db = notify_defaults
    c, p, j = _seed_oneoff(db)
    try:
        # notify_customer omitted → falls back to Settings, where move-email is off.
        assert _move_oneoff(db, j.id) == "none"
    finally:
        _cleanup(db, client_id=c.id)


def test_oneoff_move_notify_true_emails(notify_defaults):
    db = notify_defaults
    c, p, j = _seed_oneoff(db)
    try:
        assert _move_oneoff(db, j.id, notify_customer=True) == "all"
    finally:
        _cleanup(db, client_id=c.id)


def test_oneoff_move_notify_false_stays_silent_even_if_setting_on(notify_defaults):
    db = notify_defaults
    # Even with the global "email on move" turned ON, an explicit False wins.
    set_setting(db, "notify_customers_on_move", "true"); db.commit()
    c, p, j = _seed_oneoff(db)
    try:
        assert _move_oneoff(db, j.id, notify_customer=False) == "none"
        # ...and with the setting on, an un-specified move DOES email (sanity that
        # the override, not a blanket suppression, is what silenced it above).
        c2, p2, j2 = _seed_oneoff(db)
        assert _move_oneoff(db, j2.id) == "all"
        _cleanup(db, client_id=c2.id)
    finally:
        _cleanup(db, client_id=c.id)


# ── Recurring occurrence (endpoint override: ExceptionCreate.notify_customer) ─

def _seed_recurring(db):
    c = Client(name=f"RecNt {uuid.uuid4().hex[:6]}", email="rec@example.com",
               status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="2 Ntfy Ave",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    sched = RecurringSchedule(client_id=c.id, property_id=p.id, job_type="residential",
                              title="Recurring", address="2 Ntfy Ave", frequency="monthly",
                              day_of_week=1,  # NOT NULL column; unused by the monthly generator
                              day_of_month=1, start_time=time(10, 0), end_time=time(12, 0),
                              series_start_date=date(2026, 9, 1), active=True, org_id=1)
    db.add(sched); db.commit(); db.refresh(sched)
    # A materialized occurrence already on the customer's calendar (so the move
    # carries the event id and updates it in place — main's #653 design).
    occ = Job(client_id=c.id, property_id=p.id, recurring_schedule_id=sched.id,
              title="Recurring", job_type="residential", scheduled_date=date(2026, 9, 1),
              start_time=time(10, 0), end_time=time(12, 0), status="scheduled",
              gcal_event_id="evt-old", org_id=1)
    db.add(occ); db.commit(); db.refresh(occ)
    return c, p, sched, occ


def _move_recurring_via_endpoint(db, sched, notify_customer):
    """Reschedule one occurrence through the ENDPOINT with a per-move override;
    capture the sendUpdates on the in-place calendar update."""
    captured = {}
    def fake_update(event_id, job, client, send_invite=False, reminders=None,
                    send_updates=None, owner_account_id=None, **kw):
        captured["send_updates"] = send_updates
        return True
    with patch("integrations.google_calendar.is_configured", return_value=True), \
         patch("integrations.google_calendar.update_event", side_effect=fake_update), \
         patch("integrations.google_calendar.delete_event", MagicMock(return_value=True)):
        add_reschedule_exception(
            sched.id,
            ExceptionCreate(exception_date=date(2026, 9, 1), rescheduled_date=date(2026, 9, 5),
                            notify_customer=notify_customer),
            db=db, org_id=1)
    return captured.get("send_updates")


def test_recurring_endpoint_override_false_is_silent(notify_defaults):
    db = notify_defaults
    c, p, sched, occ = _seed_recurring(db)
    try:
        assert _move_recurring_via_endpoint(db, sched, notify_customer=False) == "none"
    finally:
        _cleanup(db, client_id=c.id, schedule_id=sched.id)


def test_recurring_endpoint_override_true_emails(notify_defaults):
    db = notify_defaults
    c, p, sched, occ = _seed_recurring(db)
    try:
        assert _move_recurring_via_endpoint(db, sched, notify_customer=True) == "all"
    finally:
        _cleanup(db, client_id=c.id, schedule_id=sched.id)


def test_recurring_endpoint_none_falls_back_to_settings(notify_defaults):
    # notify_customers_on_move is off by default → an un-specified move stays silent.
    db = notify_defaults
    c, p, sched, occ = _seed_recurring(db)
    try:
        assert _move_recurring_via_endpoint(db, sched, notify_customer=None) == "none"
    finally:
        _cleanup(db, client_id=c.id, schedule_id=sched.id)
