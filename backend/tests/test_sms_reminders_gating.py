"""job_sms_reminders_tick gating semantics (T-04).

Before this change the outer scheduler.start_scheduler() only registered
the tick when JOB_SMS_REMINDERS_ENABLED env was truthy — so Meg flipping
the in-app Settings toggle did nothing in production without a redeploy.

New semantics, tested here:
  1. `JOB_SMS_REMINDERS_ENABLED=0` env is a HARD off — tick returns without
     sending, reason=env_disabled.
  2. Otherwise: tick reads the DB app_setting `job_sms_reminders_enabled`.
     Default (unset) is OFF, so a fresh deploy never texts customers.
  3. DB app_setting on + env not `0` → tick calls send_due_reminders.

Also asserts messaging_status matches — with the env-disabled reason
surfaced so the Automation tab can tell operators why a truthy DB toggle
still shows OFF.
"""
import os
import uuid
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import AppSetting
from modules.auth.router import get_current_user, current_org_id
from scheduler import job_sms_reminders_tick


class _Admin:
    id, org_id, role, status, active = 8801, 1, "admin", "active", True
    email = "reminder-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    yield TestClient(app)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    # Clean the app_setting so tests don't leak state to each other.
    db = SessionLocal()
    db.query(AppSetting).filter(
        AppSetting.key == "job_sms_reminders_enabled"
    ).delete(synchronize_session=False)
    db.commit()
    db.close()


def _set_db_flag(value: bool) -> None:
    db = SessionLocal()
    row = db.query(AppSetting).filter(
        AppSetting.key == "job_sms_reminders_enabled"
    ).first()
    if row:
        row.value = "true" if value else "false"
    else:
        db.add(AppSetting(key="job_sms_reminders_enabled",
                          value="true" if value else "false"))
    db.commit()
    db.close()


# ── job_sms_reminders_tick ────────────────────────────────────────────────

def test_tick_short_circuits_when_env_hard_off(api):
    _set_db_flag(True)
    with patch.dict(os.environ, {"JOB_SMS_REMINDERS_ENABLED": "0"}, clear=False):
        with patch("services.reminder_service.send_due_reminders") as mock_send:
            result = job_sms_reminders_tick()
    assert result == {"skipped": True, "reason": "env_disabled"}
    mock_send.assert_not_called()


def test_tick_short_circuits_when_db_flag_off(api):
    _set_db_flag(False)
    with patch.dict(os.environ, {"JOB_SMS_REMINDERS_ENABLED": "1"}, clear=False):
        with patch("services.reminder_service.send_due_reminders") as mock_send:
            result = job_sms_reminders_tick()
    assert result == {"skipped": True, "reason": "app_disabled"}
    mock_send.assert_not_called()


def test_tick_defaults_to_off_when_db_flag_unset(api):
    """Fresh deploys must never text customers without an explicit opt-in."""
    # No _set_db_flag call — leave app_setting missing.
    with patch.dict(os.environ, {"JOB_SMS_REMINDERS_ENABLED": "1"}, clear=False):
        with patch("services.reminder_service.send_due_reminders") as mock_send:
            result = job_sms_reminders_tick()
    assert result == {"skipped": True, "reason": "app_disabled"}
    mock_send.assert_not_called()


def test_tick_sends_when_env_default_and_db_flag_on(api):
    """Env unset (default = allow) + DB toggle ON → tick fires."""
    _set_db_flag(True)
    fake_result = {"sent": 3, "candidates": 3, "skipped_no_phone": 0, "failed": 0}
    env = {k: v for k, v in os.environ.items() if k != "JOB_SMS_REMINDERS_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        with patch("services.reminder_service.send_due_reminders",
                   return_value=fake_result) as mock_send:
            result = job_sms_reminders_tick()
    assert result == fake_result
    mock_send.assert_called_once()


# ── messaging_status ──────────────────────────────────────────────────────

def test_status_reflects_db_flag_when_env_permits(api):
    _set_db_flag(True)
    env = {k: v for k, v in os.environ.items() if k != "JOB_SMS_REMINDERS_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        r = api.get("/api/settings/messaging-status")
    assert r.status_code == 200
    body = r.json()
    assert body["customer_sms_reminders"] is True
    assert body["any_automatic_customer_messaging"] is True
    assert body["env_disabled"] is False


def test_status_reports_env_disabled_when_hard_off(api):
    """DB flag on + env hard-off → status shows off + env_disabled so the
    UI can explain why the toggle isn't taking effect."""
    _set_db_flag(True)
    with patch.dict(os.environ, {"JOB_SMS_REMINDERS_ENABLED": "0"}, clear=False):
        r = api.get("/api/settings/messaging-status")
    assert r.status_code == 200
    body = r.json()
    assert body["customer_sms_reminders"] is False
    assert body["env_disabled"] is True


def test_setting_persists_via_settings_api(api):
    """POST /api/settings/messaging writes the DB flag and messaging-status
    reflects the change immediately."""
    env = {k: v for k, v in os.environ.items() if k != "JOB_SMS_REMINDERS_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        r = api.post("/api/settings/messaging", json={"customer_sms_reminders": True})
        assert r.status_code == 200
        assert r.json()["customer_sms_reminders"] is True

        r = api.post("/api/settings/messaging", json={"customer_sms_reminders": False})
        assert r.status_code == 200
        assert r.json()["customer_sms_reminders"] is False


def test_tick_and_status_agree_on_ambiguous_env_values(api):
    """Regression against Codex #520: the tick's env parser and the status
    endpoint's parser must agree on non-obvious values. A truthy DB flag
    with a garbage env value should never show ON in the UI while the
    tick silently no-ops, or vice versa.
    """
    _set_db_flag(True)
    fake_result = {"sent": 1, "candidates": 1, "skipped_no_phone": 0, "failed": 0}

    for env_value in ("", "  ", "foo", "maybe", "yes-please", "0 ", " 0"):
        with patch.dict(os.environ, {"JOB_SMS_REMINDERS_ENABLED": env_value}, clear=False):
            # Ask the API what the UI would show:
            status = api.get("/api/settings/messaging-status").json()
            # And what the tick actually does:
            with patch("services.reminder_service.send_due_reminders",
                       return_value=fake_result) as mock_send:
                tick = job_sms_reminders_tick()

            # The two must agree — either both say "would send" (status=ON,
            # tick doesn't short-circuit on env), or both say "hard off".
            ui_on = status["customer_sms_reminders"]
            tick_ran = mock_send.called
            assert ui_on == tick_ran, (
                f"UI/tick disagreed for JOB_SMS_REMINDERS_ENABLED={env_value!r}: "
                f"ui_on={ui_on}, tick_ran={tick_ran}, tick={tick}, status={status}"
            )
