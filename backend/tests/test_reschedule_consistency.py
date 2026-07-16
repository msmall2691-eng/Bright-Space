"""Reschedule consistency invariants: when a visit moves, the customer's
confirm/manage link follows it, and the "confirmed" + "reminder sent" flags
reset so a moved visit isn't shown as confirmed for a time the customer never
saw and still gets a reminder at its new time."""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, RecurringSchedule
from modules.auth.router import get_current_user, current_org_id

client = TestClient(app)


class _Admin:
    id, org_id, role, status, active = 7701, 1, "admin", "active", True
    email = "resched-consistency@example.com"


@pytest.fixture
def admin():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    yield
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _seed_oneoff(db):
    c = Client(name=f"RC {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 RC Ave",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="RC visit", job_type="residential",
            scheduled_date=date(2026, 9, 1), start_time=time(10, 0), end_time=time(12, 0),
            status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def test_staff_move_resets_confirmed_and_reminder(admin):
    """update_job to a new date clears customer_confirmed_at + sms_reminder_sent."""
    db = SessionLocal()
    c, p, j = _seed_oneoff(db)
    from datetime import datetime, timezone
    db.query(Job).filter(Job.id == j.id).update(
        {"customer_confirmed_at": datetime.now(timezone.utc), "sms_reminder_sent": True})
    db.commit()
    jid, cid, pid = j.id, c.id, p.id
    db.close()
    try:
        r = client.patch(f"/api/jobs/{jid}", json={"scheduled_date": "2026-09-08", "allow_conflicts": True})
        assert r.status_code == 200, r.text
        db = SessionLocal()
        moved = db.query(Job).filter(Job.id == jid).first()
        assert str(moved.scheduled_date) == "2026-09-08"
        assert moved.customer_confirmed_at is None      # no longer "confirmed"
        assert moved.sms_reminder_sent is False          # reminder will re-fire
        db.close()
    finally:
        db = SessionLocal()
        db.query(Job).filter(Job.id == jid).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == pid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_same_time_edit_keeps_confirmed(admin):
    """A non-schedule edit (e.g. notes) must NOT reset the confirmation."""
    db = SessionLocal()
    c, p, j = _seed_oneoff(db)
    from datetime import datetime, timezone
    db.query(Job).filter(Job.id == j.id).update({"customer_confirmed_at": datetime.now(timezone.utc)})
    db.commit()
    jid, cid, pid = j.id, c.id, p.id
    db.close()
    try:
        r = client.patch(f"/api/jobs/{jid}", json={"notes": "gate code 1234", "allow_conflicts": True})
        assert r.status_code == 200, r.text
        db = SessionLocal()
        still = db.query(Job).filter(Job.id == jid).first()
        assert still.customer_confirmed_at is not None   # unchanged — no move
        db.close()
    finally:
        db = SessionLocal()
        db.query(Job).filter(Job.id == jid).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == pid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_recurring_reschedule_carries_token(admin):
    """Moving a recurring occurrence carries the customer's public_token onto the
    new visit and clears the stale confirmation."""
    from modules.recurring.router import _reschedule_occurrence
    from datetime import datetime, timezone
    db = SessionLocal()
    c = Client(name=f"RCrec {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="2 RC Ave",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    sched = RecurringSchedule(client_id=c.id, property_id=p.id, job_type="residential",
                              title="Recurring RC", address="2 RC Ave", frequency="weekly", day_of_week=1,
                              start_time=time(10, 0), end_time=time(12, 0),
                              series_start_date=date(2026, 9, 1), active=True, org_id=1)
    db.add(sched); db.commit(); db.refresh(sched)
    occ = Job(client_id=c.id, property_id=p.id, recurring_schedule_id=sched.id,
              title="Recurring RC", job_type="residential", scheduled_date=date(2026, 9, 1),
              start_time=time(10, 0), end_time=time(12, 0), status="scheduled",
              public_token="tok-recurring-rc-123", customer_confirmed_at=datetime.now(timezone.utc),
              org_id=1)
    db.add(occ); db.commit(); db.refresh(occ)
    sid, cid, pid, schid = occ.id, c.id, p.id, sched.id
    try:
        _, newjob = _reschedule_occurrence(
            db, sched, exception_date=date(2026, 9, 1), rescheduled_date=date(2026, 9, 3),
            rescheduled_start_time="14:00", rescheduled_end_time="16:00",
            reason="test move")
        db.commit(); db.refresh(newjob)
        assert newjob.id != sid                              # new row
        assert newjob.public_token == "tok-recurring-rc-123"  # link carried over
        assert newjob.customer_confirmed_at is None           # stale confirm cleared
        old = db.query(Job).filter(Job.id == sid).first()
        assert old.public_token is None                       # freed from old row
        newid = newjob.id
    finally:
        db.query(Job).filter(Job.recurring_schedule_id == schid).delete(synchronize_session=False)
        db.query(RecurringSchedule).filter(RecurringSchedule.id == schid).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == pid).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
        db.commit(); db.close()
