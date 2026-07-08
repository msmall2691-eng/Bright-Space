"""Pins the July-2026 audit's Twilio webhook fail-open finding.

Before this fix, POST /api/comms/twilio/webhook accepted ANY request —
signature unchecked — whenever TWILIO_AUTH_TOKEN was unset. Anyone could
forge a payload with an arbitrary From/Body, inject SMS records under a
real client's number, and trigger FORWARD_INBOUND_SMS_TO — turning Twilio
into a free open relay against the on-call line. Since TWILIO_AUTH_TOKEN is
already required for outbound SMS to function, there's no legitimate
inbound traffic to serve when it's unset, so the endpoint now fails closed.
"""
import os
import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_rejects_when_twilio_auth_token_is_unset(monkeypatch):
    monkeypatch.delenv("TWILIO_AUTH_TOKEN", raising=False)
    r = client.post(
        "/api/comms/twilio/webhook",
        data={"From": "+12075551234", "To": "+12075559999", "Body": "hi", "MessageSid": "SM123"},
    )
    assert r.status_code == 403


def test_rejects_bad_signature_when_token_is_set(monkeypatch):
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "test-token-not-matching-signature")
    r = client.post(
        "/api/comms/twilio/webhook",
        data={"From": "+12075551234", "To": "+12075559999", "Body": "hi", "MessageSid": "SM124"},
        headers={"X-Twilio-Signature": "definitely-not-valid"},
    )
    assert r.status_code == 403


def test_accepts_valid_signature_when_token_is_set(monkeypatch):
    """Sanity check that fail-closed didn't also break the legitimate path."""
    from twilio.request_validator import RequestValidator

    token = "test-token-for-valid-sig"
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", token)
    validator = RequestValidator(token)
    params = {"From": "+12075551234", "To": "+12075559999", "Body": "hi valid sig", "MessageSid": "SM125"}
    # TestClient posts to http://testserver by default.
    url = "http://testserver/api/comms/twilio/webhook"
    signature = validator.compute_signature(url, params)
    r = client.post(
        "/api/comms/twilio/webhook",
        data=params,
        headers={"X-Twilio-Signature": signature},
    )
    assert r.status_code == 200, r.text
