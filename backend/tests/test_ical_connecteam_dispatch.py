"""New Airbnb/VRBO turnovers must reach the Connecteam schedule, not just
Google Calendar.

Before this fix, an iCal sync created a str_turnover Job and pushed it to
Google (_push_new_turnover_to_gcal) but nothing put it on Connecteam: the only
backstop, sync_reconcile_tick, skipped any job with no assigned cleaner — and a
turnover is always unassigned. _dispatch_turnovers_to_connecteam closes that
gap by dispatching every upcoming, not-yet-dispatched turnover at sync time.

Hermetic: is_configured / the settings toggle / auto_dispatch_job are
monkeypatched, so nothing hits the network.
"""
import uuid
from datetime import date, time, timedelta

import pytest

import integrations.ical_sync as ical_sync
from database.db import SessionLocal, engine
from database.models import Base, Client, Property, Job


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_test_schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def client_property():
    db = SessionLocal()
    client = Client(name=f"CT Dispatch {uuid.uuid4().hex[:6]}", status="active")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="Pier House",
                    address="1 Ocean Ave", property_type="short_term_rental")
    db.add(prop); db.commit(); db.refresh(prop)
    yield db, client, prop
    db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _turnover(db, prop, **over):
    base = dict(
        client_id=prop.client_id, property_id=prop.id, job_type="str_turnover",
        title=f"Turnover — {prop.name}", scheduled_date=date.today() + timedelta(days=3),
        start_time=time(10, 0), end_time=time(13, 0), address=prop.address,
        notes="Guest checkout", status="scheduled", connecteam_shift_ids=None,
    )
    base.update(over)
    job = Job(**base)
    db.add(job); db.commit(); db.refresh(job)
    return job


def test_new_turnover_is_dispatched_to_connecteam(monkeypatch, client_property):
    db, client, prop = client_property
    job = _turnover(db, prop)

    monkeypatch.setattr(ical_sync, "business_today", lambda: date.today())
    # Connecteam configured + auto-dispatch on.
    import integrations.connecteam as ct
    monkeypatch.setattr(ct, "is_configured", lambda: True)
    import modules.settings.router as settings_router
    monkeypatch.setattr(settings_router, "connecteam_auto_dispatch_enabled", lambda _db: True)

    dispatched = []

    def _fake_dispatch(_db, j, commit=False):
        j.connecteam_shift_ids = ["open_shift_1"]
        j.dispatched = True
        dispatched.append(j.id)
        if commit:
            _db.commit()
        return {"dispatched": True, "count": 1, "errors": []}

    import integrations.connecteam_auto as ca
    monkeypatch.setattr(ca, "auto_dispatch_job", _fake_dispatch)

    n = ical_sync._dispatch_turnovers_to_connecteam(db, prop)
    assert n == 1
    assert dispatched == [job.id]
    db.refresh(job)
    assert job.connecteam_shift_ids == ["open_shift_1"]


def test_commit_failure_halts_and_is_not_counted(monkeypatch, client_property):
    """A shift created in Connecteam whose id fails to commit must NOT be counted
    as dispatched, and the loop must stop so it retries cleanly next tick rather
    than compounding orphaned/duplicate shifts."""
    db, client, prop = client_property
    job_a = _turnover(db, prop, scheduled_date=date.today() + timedelta(days=3))
    job_b = _turnover(db, prop, scheduled_date=date.today() + timedelta(days=5))

    monkeypatch.setattr(ical_sync, "business_today", lambda: date.today())
    import integrations.connecteam as ct
    monkeypatch.setattr(ct, "is_configured", lambda: True)
    import modules.settings.router as settings_router
    monkeypatch.setattr(settings_router, "connecteam_auto_dispatch_enabled", lambda _db: True)

    calls = []

    def _fake_dispatch(_db, j, commit=False):
        calls.append(j.id)
        # Simulate: shift created remotely, but the DB commit failed.
        return {"dispatched": True, "committed": False, "count": 1,
                "errors": [{"target": "commit", "error": "boom"}]}

    import integrations.connecteam_auto as ca
    monkeypatch.setattr(ca, "auto_dispatch_job", _fake_dispatch)

    n = ical_sync._dispatch_turnovers_to_connecteam(db, prop)
    assert n == 0                       # nothing counted as dispatched
    assert len(calls) == 1              # halted after the first (didn't touch job_b)


def test_already_dispatched_turnover_is_skipped(monkeypatch, client_property):
    db, client, prop = client_property
    _turnover(db, prop, connecteam_shift_ids=["existing"])

    monkeypatch.setattr(ical_sync, "business_today", lambda: date.today())
    import integrations.connecteam as ct
    monkeypatch.setattr(ct, "is_configured", lambda: True)
    import modules.settings.router as settings_router
    monkeypatch.setattr(settings_router, "connecteam_auto_dispatch_enabled", lambda _db: True)
    import integrations.connecteam_auto as ca
    monkeypatch.setattr(ca, "auto_dispatch_job",
                        lambda *a, **k: pytest.fail("should not re-dispatch"))

    assert ical_sync._dispatch_turnovers_to_connecteam(db, prop) == 0


def test_noop_when_auto_dispatch_disabled(monkeypatch, client_property):
    db, client, prop = client_property
    _turnover(db, prop)

    monkeypatch.setattr(ical_sync, "business_today", lambda: date.today())
    import integrations.connecteam as ct
    monkeypatch.setattr(ct, "is_configured", lambda: True)
    import modules.settings.router as settings_router
    monkeypatch.setattr(settings_router, "connecteam_auto_dispatch_enabled", lambda _db: False)
    import integrations.connecteam_auto as ca
    monkeypatch.setattr(ca, "auto_dispatch_job",
                        lambda *a, **k: pytest.fail("must not dispatch when toggle off"))

    assert ical_sync._dispatch_turnovers_to_connecteam(db, prop) == 0
