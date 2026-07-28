"""The consolidated Schedule sync-health read (GET /api/jobs/sync-health) and
its pure decision helper.

Powers the passive 'Synced / Syncing / Needs attention' badge + panel, so the
operator can trust the schedule at a glance instead of clicking manual push
buttons.

The pill DECISION is a pure function (`_sync_overall`) tested exhaustively and
deterministically. The endpoint tests run against the shared test DB, so they
assert only what this request controls — the connected/auto-flow flags and the
DELTA my own job contributes to the counts — never the global 'overall', which
other rows in the shared DB influence.
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import Client, Job, Property
from modules.scheduling import router as sched


# ---- pure decision helper -------------------------------------------------

def test_overall_clean_is_ok():
    assert sched._sync_overall(duplicates=0, orphans=0, backlog=0,
                               auto_flow_on=True, google_connected=True) == "ok"


def test_overall_backlog_with_auto_flow_on_is_syncing():
    assert sched._sync_overall(duplicates=0, orphans=0, backlog=5,
                               auto_flow_on=True, google_connected=True) == "syncing"


def test_overall_backlog_with_auto_flow_off_is_attention():
    assert sched._sync_overall(duplicates=0, orphans=0, backlog=5,
                               auto_flow_on=False, google_connected=True) == "attention"


@pytest.mark.parametrize("dups,orphs", [(1, 0), (0, 1), (2, 3)])
def test_overall_integrity_issues_always_attention(dups, orphs):
    # Even with auto-flow on and no backlog, integrity issues need a human.
    assert sched._sync_overall(duplicates=dups, orphans=orphs, backlog=0,
                               auto_flow_on=True, google_connected=True) == "attention"


def test_overall_google_disconnected_is_attention_even_when_calm():
    # Google down = jobs can't reach the calendar; never a green 'ok'.
    assert sched._sync_overall(duplicates=0, orphans=0, backlog=0,
                               auto_flow_on=False, google_connected=False) == "attention"


# ---- endpoint (deterministic fields + deltas) -----------------------------

def _ctx(gcal=True, connecteam=True, ct_auto=True, source="brightbase"):
    return (
        patch("integrations.google_calendar.is_configured", return_value=gcal),
        patch("integrations.connecteam.is_configured", return_value=connecteam),
        patch("modules.settings.router.connecteam_auto_dispatch_enabled", return_value=ct_auto),
        patch("integrations.gcal_sync.calendar_source_of_truth", return_value=source),
    )


def _run(db, **kw):
    a, b, c, d = _ctx(**kw)
    with a, b, c, d:
        return sched.sync_health(db, 1)


def _setup(db):
    client = Client(name=f"Health {uuid.uuid4().hex[:6]}", status="active")
    db.add(client); db.commit(); db.refresh(client)
    prop = Property(client_id=client.id, name="P", address="1 Test St",
                    property_type="residential", active=True)
    db.add(prop); db.commit(); db.refresh(prop)
    return client, prop


def _cleanup(db, client):
    db.query(Job).filter(Job.client_id == client.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == client.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client.id).delete(synchronize_session=False)
    db.commit()


def test_connected_flags_and_auto_flow_reported():
    db = SessionLocal()
    try:
        r = _run(db)
        assert r["google"]["configured"] is True
        assert r["connecteam"]["configured"] is True
        assert r["connecteam"]["auto_dispatch"] is True
        # All flow toggles default ON in the test env → auto-flow on.
        assert r["auto_flow_on"] is True
        assert r["automation"]["calendar_source_of_truth"] == "brightbase"
    finally:
        db.close()


def test_unsynced_job_adds_to_both_backlogs():
    db = SessionLocal()
    try:
        client, prop = _setup(db)
        before = _run(db)
        db.add(Job(client_id=client.id, property_id=prop.id, job_type="residential",
                   title="Clean", scheduled_date=date.today() + timedelta(days=2),
                   start_time=time(10, 0), end_time=time(13, 0), address="1 Test St",
                   status="scheduled", gcal_event_id=None, connecteam_shift_ids=None))
        db.commit()
        after = _run(db)
        assert after["google"]["unsynced_count"] == before["google"]["unsynced_count"] + 1
        assert after["connecteam"]["unsynced_count"] == before["connecteam"]["unsynced_count"] + 1
    finally:
        _cleanup(db, client); db.close()


def test_synced_job_adds_nothing_to_backlog():
    db = SessionLocal()
    try:
        client, prop = _setup(db)
        before = _run(db)
        db.add(Job(client_id=client.id, property_id=prop.id, job_type="residential",
                   title="Clean", scheduled_date=date.today() + timedelta(days=2),
                   start_time=time(10, 0), end_time=time(13, 0), address="1 Test St",
                   status="scheduled", gcal_event_id="evt_x", connecteam_shift_ids=["s1"]))
        db.commit()
        after = _run(db)
        assert after["google"]["unsynced_count"] == before["google"]["unsynced_count"]
        assert after["connecteam"]["unsynced_count"] == before["connecteam"]["unsynced_count"]
    finally:
        _cleanup(db, client); db.close()


def test_connecteam_disconnected_zeroes_its_backlog_and_frees_flow():
    db = SessionLocal()
    try:
        client, prop = _setup(db)
        db.add(Job(client_id=client.id, property_id=prop.id, job_type="residential",
                   title="Clean", scheduled_date=date.today() + timedelta(days=2),
                   start_time=time(10, 0), end_time=time(13, 0), address="1 Test St",
                   status="scheduled", gcal_event_id="evt_x", connecteam_shift_ids=None))
        db.commit()
        r = _run(db, connecteam=False, ct_auto=False)
        assert r["connecteam"]["configured"] is False
        assert r["connecteam"]["unsynced_count"] == 0  # not counted when disconnected
        assert r["auto_flow_on"] is True               # Connecteam off doesn't break flow
    finally:
        _cleanup(db, client); db.close()
