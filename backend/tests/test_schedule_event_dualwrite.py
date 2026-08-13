"""Phase 2 dual-write — the schedule_events flush listener.

Every canonical Job mutation (create / reschedule / reassign / cancel / complete
/ delete) writes exactly one ordered `schedule_events` row IN THE SAME
transaction as the Job change, gated by SCHEDULE_EVENT_LOG_ENABLED. When the flag
is off it is a total no-op — that's what makes Phase 2 a safe, additive
dark-launch. The event also carries the Job's org_id, so RLS scopes the log per
tenant.
"""
import pytest
from datetime import date, timedelta, time

from database.db import SessionLocal
from database.models import Client, Property, Job, ScheduleEvent
import services.schedule_events  # noqa: F401 — registers the flush listener on SessionLocal


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="Sched Event Test", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 St",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    # Clear the whole log — only these tests ever write it (flag-gated), and a
    # deleted job orphans its rows while SQLite reuses that rowid for the next
    # test's job, which would otherwise surface stale events.
    db.query(ScheduleEvent).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _job(db, c, p, **kw):
    kw.setdefault("status", "scheduled")
    kw.setdefault("job_type", "residential")
    kw.setdefault("org_id", 1)
    j = Job(client_id=c.id, property_id=p.id, title="J",
            start_time=time(9, 0), end_time=time(11, 0), **kw)
    db.add(j); db.commit(); db.refresh(j)
    return j


def _events(db, job_id):
    return (db.query(ScheduleEvent)
              .filter(ScheduleEvent.job_id == job_id)
              .order_by(ScheduleEvent.id).all())


def test_dualwrite_records_the_lifecycle(ctx, monkeypatch):
    db, c, p = ctx
    monkeypatch.setenv("SCHEDULE_EVENT_LOG_ENABLED", "1")
    future = date.today() + timedelta(days=5)

    j = _job(db, c, p, scheduled_date=future, cleaner_ids=[], org_id=1)
    evs = _events(db, j.id)
    assert [e.event_type for e in evs] == ["created"]
    assert evs[0].org_id == 1
    assert evs[0].payload["scheduled_date"] == future.isoformat()

    # reschedule (date change)
    j.scheduled_date = future + timedelta(days=1)
    db.commit()
    last = _events(db, j.id)[-1]
    assert last.event_type == "rescheduled"
    assert last.payload["scheduled_date"][1] == (future + timedelta(days=1)).isoformat()

    # reassign (cleaner_ids only)
    j.cleaner_ids = [7]
    db.commit()
    assert _events(db, j.id)[-1].event_type == "reassigned"

    # cancel
    j.status = "cancelled"
    db.commit()
    assert _events(db, j.id)[-1].event_type == "cancelled"

    # complete
    j.status = "completed"
    db.commit()
    assert _events(db, j.id)[-1].event_type == "completed"

    # delete
    jid = j.id
    db.delete(j)
    db.commit()
    assert _events(db, jid)[-1].event_type == "deleted"


def test_no_events_when_flag_off(ctx, monkeypatch):
    db, c, p = ctx
    monkeypatch.delenv("SCHEDULE_EVENT_LOG_ENABLED", raising=False)  # default OFF
    future = date.today() + timedelta(days=5)
    j = _job(db, c, p, scheduled_date=future, org_id=1)
    j.scheduled_date = future + timedelta(days=1); db.commit()
    assert _events(db, j.id) == [], "dark-launch: nothing logged while the flag is off"


def test_event_carries_job_org(ctx, monkeypatch):
    # The event is stamped with the Job's org_id so Postgres RLS scopes the log
    # per tenant (the log is in TENANT_TABLES / migration 068).
    db, c, p = ctx
    monkeypatch.setenv("SCHEDULE_EVENT_LOG_ENABLED", "1")
    j = _job(db, c, p, scheduled_date=date.today() + timedelta(days=3), org_id=99999)
    assert _events(db, j.id)[0].org_id == 99999


def test_listener_error_never_breaks_the_job_write(ctx, monkeypatch):
    """Fail-safe (activation hardening): if the event-logging path raises, the
    canonical Job write must still succeed and no exception may escape. Here
    _snapshot (used to build the 'created' event) is forced to raise; the Job is
    still created and simply isn't logged. This is what makes the log safe to
    turn on in production — a bug in logging can never roll back a real Job."""
    db, c, p = ctx
    monkeypatch.setenv("SCHEDULE_EVENT_LOG_ENABLED", "1")
    import services.schedule_events as se

    def _boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(se, "_snapshot", _boom)

    future = date.today() + timedelta(days=5)
    j = _job(db, c, p, scheduled_date=future, org_id=1)  # must NOT raise
    assert j.id is not None            # the Job write succeeded
    assert _events(db, j.id) == []     # the failing batch was dropped, nothing logged
