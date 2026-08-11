"""Pausing the Google channel must stop the background reconcile push.

Regression guard for the Sync Control Center: `gcal_auto_sync_enabled=false`
(set by the Google pause toggle / auto-pilot off) has to make
`sync_reconcile_tick` skip its Google push — otherwise the 30-min self-heal tick
keeps pushing to Google and a card showing "Paused" (or "Manual syncs only")
would still sync. The manual push-to-gcal endpoint stays ungated by design and
is not covered here.
"""
import pytest

import scheduler
from database.db import SessionLocal
from database.models import AppSetting

_KEYS = ("sync_reconcile_enabled", "gcal_auto_sync_enabled")


def _set(db, key, val):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is None:
        db.add(AppSetting(key=key, value=val))
    else:
        row.value = val
    db.commit()


@pytest.fixture
def flags():
    """Yield a session for setting flags, then delete them so this shared-session
    DB doesn't leak app_settings state into other curated tests."""
    db = SessionLocal()
    yield db
    for k in _KEYS:
        row = db.query(AppSetting).filter(AppSetting.key == k).first()
        if row is not None:
            db.delete(row)
    db.commit()
    db.close()


def _stub_integrations(monkeypatch, *, gcal_connected):
    import integrations.google_calendar as gcal
    import integrations.connecteam as ct
    import integrations.gcal_sync as gsync
    monkeypatch.setattr(gcal, "is_configured", lambda: gcal_connected)
    monkeypatch.setattr(ct, "is_configured", lambda: False)  # isolate the GCal path
    monkeypatch.setattr(gsync, "reassert_deleted_gcal_events", lambda db: {"restored": 0})


def test_reconcile_skips_google_push_when_paused(flags, monkeypatch):
    _set(flags, "sync_reconcile_enabled", "true")
    _set(flags, "gcal_auto_sync_enabled", "false")
    _stub_integrations(monkeypatch, gcal_connected=True)

    called = {"push": False}
    import modules.scheduling.router as sr

    def _push(*a, **k):
        called["push"] = True
        return {"pushed": 0, "errors": []}
    monkeypatch.setattr(sr, "push_to_gcal", _push)

    result = scheduler.sync_reconcile_tick()
    assert result.get("gcal") == {"skipped": "paused"}
    assert called["push"] is False, "reconcile must not push to Google while paused"


def test_reconcile_pushes_google_when_enabled(flags, monkeypatch):
    _set(flags, "sync_reconcile_enabled", "true")
    _set(flags, "gcal_auto_sync_enabled", "true")
    _stub_integrations(monkeypatch, gcal_connected=True)

    called = {"push": False}
    import modules.scheduling.router as sr

    def _push(*a, **k):
        called["push"] = True
        return {"pushed": 2, "errors": []}
    monkeypatch.setattr(sr, "push_to_gcal", _push)

    result = scheduler.sync_reconcile_tick()
    assert called["push"] is True
    assert result.get("gcal", {}).get("pushed") == 2
