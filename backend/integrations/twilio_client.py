"""
Twilio SMS integration.
"""

import os
import logging
from twilio.rest import Client
from twilio.http.http_client import TwilioHttpClient

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
    # Explicit HTTP timeout — Twilio's default is None (block indefinitely).
    # A hung Twilio API leg could otherwise wedge the uvicorn worker forever,
    # which on a single-worker deploy queued the entire request stream past
    # Railway's edge timeout and produced 502s. Match SMTP/IMAP: 30s ceiling.
    twilio_timeout = int(os.getenv("TWILIO_TIMEOUT_SECONDS", "30"))
    http_client = TwilioHttpClient(timeout=twilio_timeout)
    return Client(_TWILIO_ACCOUNT_SID, _TWILIO_AUTH_TOKEN, http_client=http_client)


def send_sms(to: str, body: str) -> dict:
    """Send an SMS via Twilio. Returns the message SID and status."""
    if not _TWILIO_PHONE_NUMBER:
        raise ValueError(
            "Twilio phone number not configured. "
            "Set TWILIO_PHONE_NUMBER environment variable."
        )
    if not _TWILIO_ACCOUNT_SID or not _TWILIO_AUTH_TOKEN:
        raise ValueError(
            "Twilio credentials not configured. "
            "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables."
        )
    try:
        message = _client().messages.create(
            body=body,
            from_=_TWILIO_PHONE_NUMBER,
            to=to,
        )
        return {"sid": message.sid, "status": message.status}
    except ValueError as e:
        raise ValueError(f"Twilio configuration error: {e}")
    except Exception as e:
        raise RuntimeError(f"Twilio API error: {e}")


