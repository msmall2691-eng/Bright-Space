"""POST /api/booking/submit — the owner alert email (BB-BOOK-01).

The owner-email block built its subject and body with `service_label(...)`, but
imported only `format_requested_date` — so `service_label` was undefined at that
point (it's imported inside a different function), every owner email raised
NameError while its arguments were being evaluated, the bare `except` swallowed
it, and the owner was silently never told a booking came in. With Twilio
configured the "nobody was notified" ERROR never fired either, so the failure
was invisible.

The regression is caught by spying on `_send_owner_email`: the subject/body
f-strings are the CALL's arguments, so under the bug they raise BEFORE the
function is entered and the spy is never called. Under the fix it's called, and
the subject carries the human service label — proof `service_label` resolved.
"""
import uuid
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake
from ratelimit import limiter

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    limiter.reset()
    yield
    limiter.reset()


def _payload(**overrides):
    payload = {
        "name": "Jane Doe",
        "email": f"owner-{uuid.uuid4().hex[:8]}@example.com",
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


def test_owner_email_is_attempted_with_the_service_label_in_the_subject():
    spy = MagicMock(return_value=True)
    with patch("modules.booking.router._send_owner_email", spy):
        r = client.post("/api/booking/submit", json=_payload(serviceType="standard"))
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        # Called at all → the subject/body f-strings evaluated, so service_label
        # was in scope. Under the NameError bug the spy is never reached.
        assert spy.called, "owner email was never attempted (NameError swallowed?)"
        subject = spy.call_args.kwargs["subject"]
        assert "Standard clean" in subject, subject          # the resolved label
        assert "Jane Doe" in subject
        # And the body's Service: line carries it too.
        lines = spy.call_args.kwargs["lines"]
        assert any("Standard clean" in str(l) for l in lines), lines
    finally:
        _cleanup(intake_id)


def test_a_dateless_inquiry_still_emails_the_owner():
    # Contact-form inquiries land here with no date; the owner ping must still go.
    spy = MagicMock(return_value=True)
    with patch("modules.booking.router._send_owner_email", spy):
        r = client.post("/api/booking/submit", json=_payload(requestedDate=None, serviceType="commercial"))
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        assert spy.called
        assert "Commercial clean" in spy.call_args.kwargs["subject"]
    finally:
        _cleanup(intake_id)
