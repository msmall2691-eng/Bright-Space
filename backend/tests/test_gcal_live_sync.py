"""Two-way + real-time Google Calendar sync controls (Settings → Automation)."""
from unittest.mock import patch

from fastapi.testclient import TestClient
from main import app
from database.db import SessionLocal
from database.models import AppSetting
from integrations.gcal_sync import calendar_source_of_truth

client = TestClient(app)


def _clear():
    db = SessionLocal()
    try:
        db.query(AppSetting).filter(
            AppSetting.key.in_(["calendar_source_of_truth", "gcal_live_sync"])
        ).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def setup_function():
    _clear()


def teardown_function():
    _clear()


def test_recommended_defaults():
    r = client.get("/api/settings/automation")
    assert r.status_code == 200, r.text
    body = r.json()
    # Recommended combo: BrightBase stays master (safe), real-time sync ON.
    assert body["calendar_source_of_truth"] == "brightbase"
    assert body["gcal_live_sync"] is True


def test_live_sync_can_be_turned_off_explicitly():
    client.post("/api/settings/automation", json={"gcal_live_sync": False})
    assert client.get("/api/settings/automation").json()["gcal_live_sync"] is False


def test_enabling_two_way_persists_and_is_read_by_sync():
    r = client.post("/api/settings/automation", json={"calendar_source_of_truth": "google"})
    assert r.status_code == 200, r.text
    db = SessionLocal()
    try:
        # The sync engine reads the same setting to decide whether to pull
        # Google-side edits back.
        assert calendar_source_of_truth(db) == "google"
    finally:
        db.close()
    assert client.get("/api/settings/automation").json()["calendar_source_of_truth"] == "google"


def test_turning_on_live_sync_registers_watches():
    with patch("integrations.gcal_watch.register_watches", return_value={"ok": True, "channels": 1}) as reg:
        r = client.post("/api/settings/automation", json={"gcal_live_sync": True})
    assert r.status_code == 200, r.text
    assert reg.called                       # registered the push channels immediately
    assert r.json()["live_sync"]["ok"] is True
    assert client.get("/api/settings/automation").json()["gcal_live_sync"] is True


def test_live_sync_registration_failure_is_surfaced_not_raised():
    with patch("integrations.gcal_watch.register_watches",
               return_value={"ok": False, "error": "no base_url"}):
        r = client.post("/api/settings/automation", json={"gcal_live_sync": True})
    assert r.status_code == 200
    assert r.json()["live_sync"]["ok"] is False
