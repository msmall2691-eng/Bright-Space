"""Owner-alert destinations are configurable in-app, and every owner-alert SMS
attempt is auditable.

Two things this pins:
- GET /api/settings/sms-status reports whether Twilio is configured and where
  each owner-alert destination comes from (database / env / none); POST
  /api/settings/notifications sets them as AppSetting rows (which the alert code
  prefers over the OWNER_ALERT_* env vars), validating the phone as NANP and
  the email as an address, and a blank value clears the row.
- services.owner_alerts.send_owner_sms writes one integration_events row per
  ATTEMPT (provider "sms", action "owner_alert") — ok on success, failed with
  the error on a Twilio rejection — so the SMS activity read shows owner-alert
  texts. The unconfigured case sends nothing and logs no row.
"""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import AppSetting, IntegrationEvent
from modules.settings.router import set_setting

client = TestClient(app)

_KEYS = ("owner_alert_phone", "owner_alert_email")


def _wipe():
    db = SessionLocal()
    try:
        db.query(AppSetting).filter(AppSetting.key.in_(_KEYS)).delete(synchronize_session=False)
        db.query(IntegrationEvent).filter(
            IntegrationEvent.provider == "sms",
            IntegrationEvent.action.in_(("owner_alert", "test")),
        ).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def clean():
    _wipe()
    yield
    _wipe()


# ── Settings endpoints ───────────────────────────────────────────────────────

def test_sms_status_reports_sources():
    r = client.get("/api/settings/sms-status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "twilio_configured" in body and isinstance(body["twilio_configured"], bool)
    # Nothing set and no env var in the test env → source "none".
    assert body["owner_alert_phone"]["source"] == "none"
    assert body["owner_alert_email"]["source"] == "none"


def test_save_notifications_normalizes_and_sources_database():
    r = client.post("/api/settings/notifications",
                    json={"owner_alert_phone": "207-503-3301",
                          "owner_alert_email": "meg@example.com"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["owner_alert_phone"]["value"] == "+12075033301"   # normalized
    assert body["owner_alert_phone"]["source"] == "database"
    assert body["owner_alert_email"]["value"] == "meg@example.com"
    assert body["owner_alert_email"]["source"] == "database"
    # And a fresh status read agrees.
    again = client.get("/api/settings/sms-status").json()
    assert again["owner_alert_phone"]["value"] == "+12075033301"


def test_save_notifications_rejects_bad_phone_and_email():
    assert client.post("/api/settings/notifications",
                       json={"owner_alert_phone": "12"}).status_code == 400
    assert client.post("/api/settings/notifications",
                       json={"owner_alert_email": "not-an-email"}).status_code == 400


def test_blank_phone_clears_back_to_none():
    client.post("/api/settings/notifications", json={"owner_alert_phone": "2075033301"})
    assert client.get("/api/settings/sms-status").json()["owner_alert_phone"]["source"] == "database"
    client.post("/api/settings/notifications", json={"owner_alert_phone": ""})
    assert client.get("/api/settings/sms-status").json()["owner_alert_phone"]["source"] == "none"


# ── Owner-alert SMS audit logging ────────────────────────────────────────────

def _owner_rows(db):
    return (db.query(IntegrationEvent)
            .filter(IntegrationEvent.provider == "sms",
                    IntegrationEvent.action == "owner_alert",
                    IntegrationEvent.entity_id == 90001)
            .all())


def test_owner_sms_success_is_logged():
    from services import owner_alerts
    db = SessionLocal()
    try:
        set_setting(db, "owner_alert_phone", "+12075033301"); db.commit()
        with patch("integrations.twilio_client.send_sms",
                   return_value={"sid": "SM_owner", "status": "queued"}) as sms:
            ok = owner_alerts.send_owner_sms(db, "New request #90001", ref="for intake=90001",
                                             entity_type="intake", entity_id=90001)
        assert ok is True and sms.called
        rows = _owner_rows(db)
        assert len(rows) == 1
        assert rows[0].status == "ok"
        assert rows[0].external_id == "SM_owner"
        assert rows[0].request_payload == "to +12075033301"
    finally:
        db.close()


def test_owner_sms_failure_is_logged_and_reraises():
    from services import owner_alerts
    db = SessionLocal()
    try:
        set_setting(db, "owner_alert_phone", "+12075033301"); db.commit()
        with patch("integrations.twilio_client.send_sms",
                   side_effect=RuntimeError("Twilio API error: 30034 unregistered")):
            with pytest.raises(RuntimeError):
                owner_alerts.send_owner_sms(db, "New request #90001",
                                            entity_type="intake", entity_id=90001)
        rows = _owner_rows(db)
        assert len(rows) == 1
        assert rows[0].status == "failed"
        assert "30034" in (rows[0].error_message or "")
    finally:
        db.close()


def _twilio_configured():
    return patch.multiple(
        "integrations.twilio_client",
        _TWILIO_ACCOUNT_SID="AC_test", _TWILIO_AUTH_TOKEN="tok_test",
        _TWILIO_PHONE_NUMBER="+12075550100")


def test_sms_test_send_success_is_logged():
    with _twilio_configured(), patch("integrations.twilio_client.send_sms",
                                     return_value={"sid": "SM_test", "status": "queued"}) as sms:
        r = client.post("/api/settings/sms-test", json={"to": "207-503-3301"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["to"] == "+12075033301"
    assert sms.called and sms.call_args.kwargs["to"] == "+12075033301"
    db = SessionLocal()
    try:
        row = (db.query(IntegrationEvent)
               .filter(IntegrationEvent.provider == "sms",
                       IntegrationEvent.action == "test",
                       IntegrationEvent.status == "ok")
               .order_by(IntegrationEvent.id.desc()).first())
        assert row is not None and row.request_payload == "to +12075033301"
    finally:
        db.close()


def test_sms_test_send_surfaces_twilio_error():
    with _twilio_configured(), patch("integrations.twilio_client.send_sms",
                                     side_effect=RuntimeError("Twilio API error: 30034 unregistered")):
        r = client.post("/api/settings/sms-test", json={"to": "2075033301"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False and "30034" in body["error"]


def test_sms_test_send_needs_a_number():
    # No `to` and no owner_alert_phone configured → 400.
    r = client.post("/api/settings/sms-test", json={})
    assert r.status_code == 400


def test_owner_sms_unconfigured_sends_nothing_and_logs_no_row():
    from services import owner_alerts
    db = SessionLocal()
    try:
        # No owner_alert_phone row and no env var → skipped, no attempt.
        with patch("integrations.twilio_client.send_sms") as sms:
            ok = owner_alerts.send_owner_sms(db, "New request #90001",
                                             entity_type="intake", entity_id=90001)
        assert ok is False and not sms.called
        assert _owner_rows(db) == []
    finally:
        db.close()
