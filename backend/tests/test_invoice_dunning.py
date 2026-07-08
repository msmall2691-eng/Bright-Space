"""services.dunning_service + scheduler.invoice_dunning_tick coverage (T-03).

The service walks unpaid invoices, sends the existing overdue-styled
invoice email at +1/+7/+14 days past due (configurable via
JOB_DUNNING_CADENCE_DAYS), and advances Invoice.dunning_stage so a
subsequent tick can't re-fire the same stage.

Same gating pattern as SMS reminders: env=0 hard-off,
dunning_enabled app_setting is Meg's toggle, default OFF.
"""
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import AppSetting, Client, Invoice
from modules.auth.router import get_current_user, current_org_id
from services.dunning_service import (
    _due_stage, _days_past_due, send_due_dunning, DEFAULT_CADENCE_DAYS,
)
from scheduler import invoice_dunning_tick


class _Admin:
    id, org_id, role, status, active = 8901, 1, "admin", "active", True
    email = "dunning-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    yield TestClient(app)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(AppSetting).filter(AppSetting.key.in_(
        ("dunning_enabled", "job_sms_reminders_enabled")
    )).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture
def ctx(api):
    db = SessionLocal()
    c = Client(name=f"Dunning {uuid.uuid4().hex[:6]}",
               email="pay@example.com", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids = {"clients": [c.id], "invoices": []}
    try:
        yield db, c, ids
    finally:
        db.query(Invoice).filter(Invoice.id.in_(ids["invoices"] or [0])).delete(synchronize_session=False)
        db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
        db.commit(); db.close()


def _mk_invoice(db, c, ids, *, due_date, status="sent", total=250.0,
                dunning_stage=0, email_override=None):
    inv = Invoice(
        client_id=c.id, total=total, status=status,
        invoice_number=f"INV-D-{uuid.uuid4().hex[:8]}",
        due_date=due_date if isinstance(due_date, str) else due_date.isoformat(),
        items=[{"name": "clean", "qty": 1, "unit_price": total}],
        dunning_stage=dunning_stage, org_id=1,
    )
    db.add(inv); db.commit(); db.refresh(inv)
    ids["invoices"].append(inv.id)
    return inv


# ── Pure helpers ──────────────────────────────────────────────────────────

def test_days_past_due():
    today = date(2026, 7, 8)
    assert _days_past_due("2026-07-08", today) == 0
    assert _days_past_due("2026-07-07", today) == 1
    assert _days_past_due("2026-06-08", today) == 30
    assert _days_past_due(None, today) is None
    assert _days_past_due("garbage", today) is None
    # Accepts a full timestamp — invoicing sometimes stores an ISO with a
    # `T` suffix; parser only inspects the first 10 chars.
    assert _days_past_due("2026-07-07T14:00:00Z", today) == 1


def test_due_stage_advances_one_at_a_time():
    cadence = (1, 7, 14)
    # Nothing past due yet.
    assert _due_stage(0, cadence, 0) is None
    # First threshold reached.
    assert _due_stage(1, cadence, 0) == 1
    assert _due_stage(6, cadence, 1) is None
    assert _due_stage(7, cadence, 1) == 2
    # Doesn't skip stages when a run was missed — big jump still advances by 1.
    assert _due_stage(30, cadence, 0) == 1
    assert _due_stage(30, cadence, 1) == 2
    assert _due_stage(30, cadence, 2) == 3
    # Final stage never re-fires.
    assert _due_stage(50, cadence, 3) is None


# ── send_due_dunning (integration-style with mocked send_email) ────────────

def test_dunning_fires_stage_1_at_first_past_due_day(ctx):
    db, c, ids = ctx
    inv = _mk_invoice(db, c, ids, due_date=date.today() - timedelta(days=1))
    with patch("services.dunning_service.send_email") as mock_send:
        r = send_due_dunning(db)
    assert r["sent"] == 1
    mock_send.assert_called_once()
    db.refresh(inv)
    assert inv.dunning_stage == 1
    assert inv.dunning_last_sent_at is not None
    assert inv.status == "overdue"  # flipped from sent → overdue


def test_dunning_does_not_double_send_same_stage(ctx):
    """Second tick on the same day: stage 1 already fired, no new send."""
    db, c, ids = ctx
    _mk_invoice(db, c, ids, due_date=date.today() - timedelta(days=1),
                dunning_stage=1)
    with patch("services.dunning_service.send_email") as mock_send:
        r = send_due_dunning(db)
    assert r["sent"] == 0
    mock_send.assert_not_called()


def test_dunning_advances_to_stage_2_at_day_7(ctx):
    db, c, ids = ctx
    inv = _mk_invoice(db, c, ids, due_date=date.today() - timedelta(days=7),
                      dunning_stage=1)
    with patch("services.dunning_service.send_email") as mock_send:
        r = send_due_dunning(db)
    assert r["sent"] == 1
    mock_send.assert_called_once()
    db.refresh(inv)
    assert inv.dunning_stage == 2


def test_dunning_stops_after_final_stage(ctx):
    """An invoice already at the final stage is filtered out at the query level."""
    db, c, ids = ctx
    _mk_invoice(db, c, ids, due_date=date.today() - timedelta(days=60),
                dunning_stage=3)
    with patch("services.dunning_service.send_email") as mock_send:
        r = send_due_dunning(db)
    assert r["sent"] == 0
    mock_send.assert_not_called()


def test_dunning_skips_paid_invoices(ctx):
    db, c, ids = ctx
    _mk_invoice(db, c, ids, due_date=date.today() - timedelta(days=10),
                status="paid")
    with patch("services.dunning_service.send_email") as mock_send:
        r = send_due_dunning(db)
    assert r["sent"] == 0
    mock_send.assert_not_called()


def test_dunning_skips_client_with_no_email_but_advances_stage(ctx):
    """No email → we can't chase, but advance the counter so we don't
    burn cycles on the same invoice every tick forever."""
    db, c, ids = ctx
    c.email = None
    db.commit()
    inv = _mk_invoice(db, c, ids, due_date=date.today() - timedelta(days=1))
    with patch("services.dunning_service.send_email") as mock_send:
        r = send_due_dunning(db)
    assert r["sent"] == 0
    assert r["skipped_no_email"] == 1
    mock_send.assert_not_called()
    db.refresh(inv)
    assert inv.dunning_stage == 1


def test_dunning_survives_send_email_failure(ctx):
    """send_email raising leaves the stage unchanged so the next tick retries."""
    db, c, ids = ctx
    inv = _mk_invoice(db, c, ids, due_date=date.today() - timedelta(days=1))
    with patch("services.dunning_service.send_email",
               side_effect=RuntimeError("SMTP down")):
        r = send_due_dunning(db)
    assert r["failed"] == 1
    assert r["sent"] == 0
    db.refresh(inv)
    assert inv.dunning_stage == 0  # NOT advanced


# ── invoice_dunning_tick gating ───────────────────────────────────────────

def _set_flag(key: str, value: bool):
    db = SessionLocal()
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = "true" if value else "false"
    else:
        db.add(AppSetting(key=key, value="true" if value else "false"))
    db.commit(); db.close()


def test_tick_short_circuits_when_env_hard_off(api):
    _set_flag("dunning_enabled", True)
    with patch.dict(os.environ, {"JOB_DUNNING_ENABLED": "0"}, clear=False):
        with patch("services.dunning_service.send_due_dunning") as mock_send:
            result = invoice_dunning_tick()
    assert result == {"skipped": True, "reason": "env_disabled"}
    mock_send.assert_not_called()


def test_tick_short_circuits_when_db_flag_off(api):
    _set_flag("dunning_enabled", False)
    env = {k: v for k, v in os.environ.items() if k != "JOB_DUNNING_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        with patch("services.dunning_service.send_due_dunning") as mock_send:
            result = invoice_dunning_tick()
    assert result == {"skipped": True, "reason": "app_disabled"}
    mock_send.assert_not_called()


def test_tick_defaults_off_when_flag_unset(api):
    """Fresh deploys never chase without an explicit opt-in."""
    env = {k: v for k, v in os.environ.items() if k != "JOB_DUNNING_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        with patch("services.dunning_service.send_due_dunning") as mock_send:
            result = invoice_dunning_tick()
    assert result == {"skipped": True, "reason": "app_disabled"}
    mock_send.assert_not_called()


def test_tick_calls_service_when_enabled(api):
    _set_flag("dunning_enabled", True)
    fake = {"candidates": 1, "sent": 1, "skipped_no_email": 0, "failed": 0,
            "stage_advanced": 1, "cadence_days": [1, 7, 14]}
    env = {k: v for k, v in os.environ.items() if k != "JOB_DUNNING_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        with patch("services.dunning_service.send_due_dunning",
                   return_value=fake) as mock_send:
            result = invoice_dunning_tick()
    assert result == fake
    mock_send.assert_called_once()


# ── Settings API surfaces the flag ────────────────────────────────────────

def test_messaging_status_reflects_dunning_flag(api):
    _set_flag("dunning_enabled", True)
    env = {k: v for k, v in os.environ.items() if k != "JOB_DUNNING_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        r = api.get("/api/settings/messaging-status")
    body = r.json()
    assert body["invoice_dunning"] is True
    assert body["invoice_dunning_env_disabled"] is False


def test_settings_api_persists_dunning_flag(api):
    env = {k: v for k, v in os.environ.items() if k != "JOB_DUNNING_ENABLED"}
    with patch.dict(os.environ, env, clear=True):
        r = api.post("/api/settings/messaging", json={"invoice_dunning": True})
        assert r.status_code == 200
        assert r.json()["invoice_dunning"] is True

        # Partial POST doesn't reset the SMS flag.
        api.post("/api/settings/messaging", json={"customer_sms_reminders": True})
        r = api.post("/api/settings/messaging", json={"invoice_dunning": False})
        body = r.json()
        assert body["invoice_dunning"] is False
        assert body["customer_sms_reminders"] is True
