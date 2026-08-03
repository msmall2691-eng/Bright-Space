"""Recurring reschedule = a SILENT in-place calendar move.

When an operator moves one occurrence of a recurring schedule, the visit's
Google Calendar event must slide to the new date via a single `update_event`
(reusing the same event id) — NOT a delete + re-create. That guarantees:
  * no "cancelled" email + no re-invite (100% silent when notify_customer=False),
  * the moved Job carries the SAME event id (no orphan, no reconcile round-trip),
  * a customer self-move still notifies (send_updates="all").
"""
import uuid
from datetime import date, time
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import (
    Client, Property, Job, RecurringSchedule, RecurrenceException, Activity,
)
from modules.recurring.router import _reschedule_occurrence


@pytest.fixture
def seeded():
    db = SessionLocal()
    c = Client(name=f"InPlace {uuid.uuid4().hex[:6]}", email="ip@example.com",
               status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Home", address="1 Silent Way",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, job_type="residential", title="Biweekly",
        address="1 Silent Way", frequency="biweekly", interval_weeks=2,
        day_of_week=0, days_of_week=[0], start_time=time(9, 0), end_time=time(11, 0),
        active=True, org_id=1)
    db.add(sched); db.commit(); db.refresh(sched)
    # The materialized occurrence that already lives on the customer's calendar.
    occ = Job(client_id=c.id, property_id=p.id, recurring_schedule_id=sched.id,
              title="Biweekly", job_type="residential",
              scheduled_date=date(2026, 9, 7), start_time=time(9, 0), end_time=time(11, 0),
              status="scheduled", gcal_event_id="evt_recurring_1",
              gcal_account_id=None, org_id=1)
    db.add(occ); db.commit(); db.refresh(occ)
    yield db, c, p, sched, occ
    db.query(RecurrenceException).filter(RecurrenceException.recurring_schedule_id == sched.id).delete(synchronize_session=False)
    db.query(Activity).filter(Activity.job_id.in_(db.query(Job.id).filter(Job.client_id == c.id))).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id == sched.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _move(db, sched, from_d, to_d, notify):
    calls = {"update": [], "delete": []}
    def fake_update(event_id, job, client, send_invite=False, reminders=None,
                    send_updates=None, owner_account_id=None, **kw):
        calls["update"].append({"event_id": event_id, "send_updates": send_updates,
                                "date": job.get("scheduled_date")})
        return True
    def fake_delete(*a, **kw):
        calls["delete"].append(kw.get("send_updates"))
        return True
    with patch("integrations.google_calendar.is_configured", return_value=True), \
         patch("integrations.google_calendar.update_event", side_effect=fake_update), \
         patch("integrations.google_calendar.delete_event", side_effect=fake_delete):
        _, newjob = _reschedule_occurrence(
            db, sched, from_d, to_d,
            rescheduled_start_time=time(13, 0), rescheduled_end_time=time(15, 0),
            reason="test", notify_customer=notify)
        db.commit(); db.refresh(newjob)
    return newjob, calls


def test_operator_move_is_silent_and_reuses_event(seeded):
    db, c, p, sched, occ = seeded
    newjob, calls = _move(db, sched, date(2026, 9, 7), date(2026, 9, 9), notify=False)

    # The event slid in place: one update, no delete/re-create.
    assert len(calls["update"]) == 1
    assert calls["update"][0]["event_id"] == "evt_recurring_1"
    assert calls["update"][0]["send_updates"] == "none"        # 100% silent
    assert calls["update"][0]["date"] == date(2026, 9, 9)      # moved to the new day
    assert calls["delete"] == []                                # never deleted
    # The moved Job carries the SAME event id — no orphan, no reconcile needed.
    assert newjob.gcal_event_id == "evt_recurring_1"


def test_customer_move_still_notifies(seeded):
    db, c, p, sched, occ = seeded
    newjob, calls = _move(db, sched, date(2026, 9, 7), date(2026, 9, 14), notify=True)
    assert len(calls["update"]) == 1
    assert calls["update"][0]["send_updates"] == "all"          # customer self-move confirms
    assert newjob.gcal_event_id == "evt_recurring_1"
