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


def configured() -> bool:
    """True when an SID, token and from-number are all present.

    The mirror of `push_service.push_enabled()`, and it exists for the same
    reason: a caller that treats SMS as an optional channel needs to ask
    before it tries. `send_sms` RAISES when unconfigured, which is right for a
    deliberate send a human asked for and wrong for a best-effort fallback
    that must never break the schedule write it hangs off.
    """
    return all([_TWILIO_ACCOUNT_SID, _TWILIO_AUTH_TOKEN, _TWILIO_PHONE_NUMBER])


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
    """Send an SMS via Twilio. Returns the message SID and status.

    THE DESTINATION IS VALIDATED HERE, at the one place every outbound text in
    the app funnels through, because putting it at the call sites did not work:
    of the seven callers of this function, exactly one (the public booking
    form) ran its number through a validator first. The other six — quote
    delivery, owner alerts, the settings test, the comms reply path, the
    proposal executor, the crew fallbacks — handed over whatever string they
    were holding. Two things that reached production as a result:

      * A client record with a typo'd `+1 20743299492` was reshaped by
        `normalize_e164` into a `+`-prefixed 12-digit number and dialled.
        Twilio 400'd it. The quote never arrived and nobody noticed for weeks.
      * A test booking used the company's OWN Twilio number as the customer
        phone, and Twilio refused with "'To' and 'From' number cannot be the
        same" — an error that is obvious once you read it and invisible until
        you go digging for it.

    A gate at each caller is a rule you have to remember; a gate here is one
    you cannot forget, and the next caller added inherits it for free.

    Raises ValueError for a destination we refuse to dial, which is the same
    class this function already raises for missing credentials and which every
    existing caller already catches — `services/sms_send.py` audits and
    re-raises, and the rest log and continue.
    """
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

    from utils.phone import nanp_e164
    dest = nanp_e164(to)
    if not dest:
        # Deliberately does NOT echo `to` past what was passed in: this string
        # ends up in an integration_events row and an operator-visible error.
        raise ValueError(
            f"Refusing to send: {to!r} is not a textable US or Canada number."
        )
    # Twilio rejects a self-send with an HTTP 400 that reads like an API fault
    # rather than the configuration mistake it is. Catching it here costs one
    # comparison and turns a mystery into a sentence.
    sender = nanp_e164(_TWILIO_PHONE_NUMBER) or _TWILIO_PHONE_NUMBER
    if dest == sender:
        raise ValueError(
            "Refusing to send: the destination is this business's own Twilio "
            "number, so the text would be from and to the same line."
        )

    try:
        message = _client().messages.create(
            body=body,
            from_=_TWILIO_PHONE_NUMBER,
            # The NORMALIZED number, not the caller's string. Human-formatted
            # values like "(207) 432-9492" happened to work; that was Twilio
            # being forgiving, not us being correct.
            to=dest,
        )
        return {"sid": message.sid, "status": message.status}
    except ValueError as e:
        raise ValueError(f"Twilio configuration error: {e}")
    except Exception as e:
        raise RuntimeError(f"Twilio API error: {e}")


