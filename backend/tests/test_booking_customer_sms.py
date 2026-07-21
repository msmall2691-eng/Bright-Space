"""POST /api/booking/submit — customer confirmation SMS.

Twilio lives only in Bright-Space (maineclean.co has no SMS), so the customer's
booking-confirmation text is sent here, best-effort, right after the customer
confirmation email. Covers: a booking WITH a phone triggers a customer SMS
whose body carries the self-service manage link when provided; a BLANK phone
sends no SMS; and a Twilio failure never breaks the 201.

send_sms is patched at its import site — _send_booking_customer_sms does
`from integrations import twilio_client` then `twilio_client.send_sms(...)`,
so patching the module attribute (and the TWILIO_* config gate it checks) is
what actually intercepts the call.
"""
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake
from ratelimit import limiter

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    """/api/booking/submit is capped at 20/hour on a process-shared in-memory
    limiter keyed on the TestClient. Our four submits would otherwise eat into
    the budget other booking-test files (which don't reset) rely on. Clear it
    before and after each test so this file is budget-neutral for the suite."""
    limiter.reset()
    yield
    limiter.reset()


def _payload(**overrides):
    payload = {
        "name": "Jane Doe",
        "email": f"sms-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550188",
        "address": "12 Pine St, Portland, ME 04101",
        "serviceType": "standard",
        "requestedDate": "2026-08-10",
        "squareFeet": 1500,
        "bathrooms": 2,
        "idempotencyKey": str(uuid.uuid4()),
    }
    payload.update(overrides)
    return payload


def _cleanup(intake_id):
    db = SessionLocal()
    try:
        db.query(LeadIntake).filter(LeadIntake.id == intake_id).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _twilio_configured():
    """Force the module's "Twilio is configured" gate on so the send path runs
    even in a test env with no real credentials."""
    return patch.multiple(
        "integrations.twilio_client",
        _TWILIO_ACCOUNT_SID="AC_test",
        _TWILIO_AUTH_TOKEN="tok_test",
        _TWILIO_PHONE_NUMBER="+12075550100",
    )


def test_submit_sends_customer_sms_with_manage_link():
    manage_url = "https://maineclean.co/booking/manage/tok_abc123"
    with _twilio_configured(), patch(
        "integrations.twilio_client.send_sms",
        return_value={"sid": "SM1", "status": "queued"},
    ) as sms:
        r = client.post("/api/booking/submit", json=_payload(manageUrl=manage_url))
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        assert sms.called, "customer confirmation SMS should have been attempted"
        kwargs = sms.call_args.kwargs
        assert kwargs["to"] == "+12075550188"
        body = kwargs["body"]
        # Friendly bits + the self-service manage link the site forwarded.
        assert "Jane" in body
        assert manage_url in body
        assert "1 business day" in body
    finally:
        _cleanup(intake_id)


def test_submit_omits_manage_link_when_not_provided():
    with _twilio_configured(), patch(
        "integrations.twilio_client.send_sms",
        return_value={"sid": "SM2", "status": "queued"},
    ) as sms:
        r = client.post("/api/booking/submit", json=_payload())  # no manageUrl
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        assert sms.called
        body = sms.call_args.kwargs["body"]
        assert "Manage/cancel:" not in body
    finally:
        _cleanup(intake_id)


def test_submit_no_sms_when_phone_blank():
    with _twilio_configured(), patch(
        "integrations.twilio_client.send_sms",
        return_value={"sid": "SM3", "status": "queued"},
    ) as sms:
        r = client.post("/api/booking/submit", json=_payload(phone=""))
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        assert not sms.called, "blank phone must not attempt a customer SMS"
    finally:
        _cleanup(intake_id)


def test_submit_survives_twilio_failure():
    # A Twilio outage / send error must never break the customer-facing 201 —
    # the confirmation SMS is strictly best-effort.
    with _twilio_configured(), patch(
        "integrations.twilio_client.send_sms",
        side_effect=RuntimeError("Twilio API error: boom"),
    ) as sms:
        r = client.post("/api/booking/submit", json=_payload())
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        assert sms.called
    finally:
        _cleanup(intake_id)
