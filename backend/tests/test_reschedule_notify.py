"""Per-move customer notification control (the "don't bombard them with Google
Calendar emails every time I move a visit" work).

Two guarantees, one for each reschedule path:

  1. One-time jobs (update_job): the Google `sendUpdates` on an in-place move is
     silent by default (Settings "email on move" is off), and an explicit
     JobUpdate.notify_customer overrides it either way for that one call.

  2. Recurring occurrences (_reschedule_occurrence): the SAME rule now applies to
     BOTH the old event's deletion and the moved event's creation — previously
     recurring moves ignored the move toggle and emailed per the master setting
     (the monthly-move bombardment). notify=True/False overrides per call.

The tests capture the exact `sendUpdates` handed to google_calendar.* so they
assert the customer-facing effect, not just that a call happened.
"""
import uuid
from datetime import date, time
from unittest.mock import patch, MagicMock

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, RecurringSchedule
from modules.settings.router import set_setting
from modules.scheduling.router import update_job, JobUpdate
from modules.recurring.router import _reschedule_occurrence


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


def _cleanup(db, *, client_id, schedule_id=None):
    if schedule_id is not None:
        db.query(Job).filter(Job.recurring_schedule_id == schedule_id).delete(synchronize_session=False)
        db.query(RecurringSchedule).filter(RecurringSchedule.id == schedule_id).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == client_id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == client_id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
    db.commit()


# ── One-time job (update_job) ────────────────────────────────────────────────

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


# ── Recurring occurrence (_reschedule_occurrence) ────────────────────────────

def _seed_recurring(db):
    c = Client(name=f"Rec {uuid.uuid4().hex[:6]}", email="rec@example.com",
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
    occ = Job(client_id=c.id, property_id=p.id, recurring_schedule_id=sched.id,
              title="Recurring", job_type="residential", scheduled_date=date(2026, 9, 1),
              start_time=time(10, 0), end_time=time(12, 0), status="scheduled",
              gcal_event_id="evt-old", org_id=1)
    db.add(occ); db.commit(); db.refresh(occ)
    return c, p, sched, occ


def _move_recurring(db, sched, notify):
    """Move a monthly occurrence to a new day; capture sendUpdates on BOTH the
    old-event delete and the new-event create."""
    with patch("integrations.google_calendar.delete_event", MagicMock(return_value=True)) as dele, \
         patch("integrations.google_calendar.create_event", MagicMock(return_value="evt-new")) as crea, \
         patch("integrations.google_calendar.is_configured", MagicMock(return_value=True)), \
         patch("integrations.google_calendar.active_account_id", MagicMock(return_value=1)):
        _reschedule_occurrence(
            db, sched, exception_date=date(2026, 9, 1), rescheduled_date=date(2026, 9, 5),
            notify=notify)
        db.commit()
    return (dele.call_args.kwargs.get("send_updates") if dele.called else None,
            crea.call_args.kwargs.get("send_updates") if crea.called else None)


def test_recurring_move_is_silent_by_default(notify_defaults):
    db = notify_defaults
    c, p, sched, occ = _seed_recurring(db)
    try:
        del_su, crt_su = _move_recurring(db, sched, notify=None)
        # The parity fix: BOTH sides respect the (off-by-default) move setting,
        # so a monthly move no longer fires a cancellation + a fresh invite.
        assert del_su == "none"
        assert crt_su == "none"
    finally:
        _cleanup(db, client_id=c.id, schedule_id=sched.id)


def test_recurring_move_notify_true_emails_both_sides(notify_defaults):
    db = notify_defaults
    c, p, sched, occ = _seed_recurring(db)
    try:
        del_su, crt_su = _move_recurring(db, sched, notify=True)
        assert del_su == "all"
        assert crt_su == "all"
    finally:
        _cleanup(db, client_id=c.id, schedule_id=sched.id)


def test_recurring_move_notify_false_silent_even_with_setting_on(notify_defaults):
    db = notify_defaults
    set_setting(db, "notify_customers_on_move", "true"); db.commit()
    c, p, sched, occ = _seed_recurring(db)
    try:
        del_su, crt_su = _move_recurring(db, sched, notify=False)
        assert del_su == "none"
        assert crt_su == "none"
    finally:
        _cleanup(db, client_id=c.id, schedule_id=sched.id)
