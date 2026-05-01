"""
Twilio SMS integration.
"""

import os
import logging
from twilio.rest import Client

logger = logging.getLogger(__name__)

_TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
_TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
_TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER")

# Log if Twilio is not configured
if not all([_TWILIO_ACCOUNT_SID, _TWILIO_AUTH_TOKEN, _TWILIO_PHONE_NUMBER]):
    logger.warning(
        "Twilio SMS is not fully configured. "
        "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to enable SMS."
    )


def _client() -> Client:
    if not _TWILIO_ACCOUNT_SID or not _TWILIO_AUTH_TOKEN:
        raise ValueError(
            "Twilio credentials not configured. "
            "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables."
        )
    return Client(_TWILIO_ACCOUNT_SID, _TWILIO_AUTH_TOKEN)


def send_sms(to: str, body: str) -> dict:
    """Send an SMS via Twilio. Returns the message SID and status."""
    if not _TWILIO_PHONE_NUMBER:
        raise ValueError(
            "Twilio phone number not configured. "
            "Set TWILIO_PHONE_NUMBER environment variable."
        )
    message = _client().messages.create(
        body=body,
        from_=_TWILIO_PHONE_NUMBER,
        to=to,
    )
    return {"sid": message.sid, "status": message.status}


def get_sms_status(sid: str) -> dict:
    """Check delivery status of a sent message."""
    message = _client().messages(sid).fetch()
    return {"sid": message.sid, "status": message.status, "error_code": message.error_code}
