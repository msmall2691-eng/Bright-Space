"""services.sms_send.send_and_log — the one seam every non-owner, non-booking
SMS routes through, so every attempt lands on the integration audit log.

What must hold:
- a success returns twilio_client.send_sms's result unchanged AND writes one
  ok row (provider "sms", the caller's action, the recipient, the sid);
- a failure writes a failed row carrying the provider error, then RE-RAISES the
  same exception so the caller's existing handling is unchanged;
- the audit row is written in its own session, so it persists regardless of the
  caller's transaction.
"""
from unittest.mock import patch

import pytest

from database.db import SessionLocal
from database.models import IntegrationEvent
from services.sms_send import send_and_log

ACTION = "test_wrapper"


def _wipe():
    db = SessionLocal()
    try:
        db.query(IntegrationEvent).filter(
            IntegrationEvent.provider == "sms",
            IntegrationEvent.action == ACTION).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def clean():
    _wipe()
    yield
    _wipe()


def _rows():
    db = SessionLocal()
    try:
        return (db.query(IntegrationEvent)
                .filter(IntegrationEvent.provider == "sms",
                        IntegrationEvent.action == ACTION)
                .order_by(IntegrationEvent.id.desc()).all())
    finally:
        db.close()


def test_success_returns_result_and_logs_ok():
    with patch("integrations.twilio_client.send_sms",
               return_value={"sid": "SM_w", "status": "queued"}) as sms:
        res = send_and_log(to="+12075550123", body="hi", action=ACTION,
                           entity_type="job", entity_id=42, org_id=1)
    assert res == {"sid": "SM_w", "status": "queued"}
    assert sms.call_args.kwargs == {"to": "+12075550123", "body": "hi"}
    rows = _rows()
    assert len(rows) == 1
    assert rows[0].status == "ok"
    assert rows[0].external_id == "SM_w"
    assert rows[0].entity_type == "job" and rows[0].entity_id == 42
    assert rows[0].request_payload == "to +12075550123"


def test_failure_logs_and_reraises():
    with patch("integrations.twilio_client.send_sms",
               side_effect=RuntimeError("Twilio API error: 30034")):
        with pytest.raises(RuntimeError):
            send_and_log(to="+12075550124", body="hi", action=ACTION)
    rows = _rows()
    assert len(rows) == 1
    assert rows[0].status == "failed"
    assert "30034" in (rows[0].error_message or "")


def test_defaults_are_safe_when_no_entity_given():
    with patch("integrations.twilio_client.send_sms",
               return_value={"sid": "SM_d", "status": "sent"}):
        send_and_log(to="+12075550125", body="hi", action=ACTION)
    rows = _rows()
    assert len(rows) == 1 and rows[0].entity_type == "sms" and rows[0].entity_id == 0
