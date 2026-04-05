"""
Twilio SMS integration.
"""

import os
from twilio.rest import Client


def _client() -> Client:
    return Client(
        os.getenv("TWILIO_ACCOUNT_SID"),
        os.getenv("TWILIO_AUTH_TOKEN"),
    )


def send_sms(to: str, body: str) -> dict:
    """Send an SMS via Twilio. Returns the message SID and status."""
    message = _client().messages.create(
        body=body,
        from_=os.getenv("TWILIO_PHONE_NUMBER"),
        to=to,
    )
    return {"sid": message.sid, "status": message.status}


def get_sms_status(sid: str) -> dict:
    """Check delivery status of a sent message."""
    message = _client().messages(sid).fetch()
    return {"sid": message.sid, "status": message.status, "error_code": message.error_code}
