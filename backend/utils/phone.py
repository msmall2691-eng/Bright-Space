"""Phone number normalization utilities."""
import re
from typing import Optional

_NON_DIGITS = re.compile(r"\D")


def digits_only(phone: Optional[str]) -> Optional[str]:
    """Strip everything except digits. Returns None for None/empty."""
    if not phone:
        return None
    digits = _NON_DIGITS.sub("", phone)
    return digits or None


def phone_tail(phone: Optional[str]) -> Optional[str]:
    """Return the last 10 digits of a phone number, or all digits if
    shorter. Used for format-insensitive matching across E.164,
    human-formatted, dotted, etc. Returns None for None/empty."""
    digits = digits_only(phone)
    if not digits:
        return None
    return digits[-10:] if len(digits) >= 10 else digits


def normalize_e164(phone: Optional[str]) -> Optional[str]:
    """Normalize phone to E.164 format: +15551234567

    Handles various formats with or without country code.
    Assumes US (+1) if no country code present.
    Returns None if invalid.
    """
    if not phone:
        return None

    phone = phone.strip()
    if not phone:
        return None

    digits = digits_only(phone)
    if not digits:
        return None

    # Has country code (11+ digits or starts with +)
    if len(digits) >= 11:
        return f"+{digits}" if not phone.startswith('+') else f"+{digits}"
    # Assume US (+1) for 10-digit numbers
    elif len(digits) == 10:
        return f"+1{digits}"
    else:
        return None


_PLACEHOLDER_PHONE_MARKER = re.compile(r"\b(placeholder|tbd|unknown)\b", re.IGNORECASE)


def is_deliverable_sms_number(phone: Optional[str]) -> bool:
    """True when the string looks like a real number Twilio can text.

    Rejects placeholder-labelled entries ("+12074518184 (placeholder)")
    that survive digit-only validators, plus obviously invalid NANP
    numbers whose area code or exchange starts with 0 or 1 (e.g. the
    malformed "+09650460670" a lead once submitted). Runs upstream of
    Twilio so we don't burn a request on numbers that will fail there."""
    if not phone or _PLACEHOLDER_PHONE_MARKER.search(phone):
        return False
    e164 = normalize_e164(phone)
    if not e164:
        return False
    digits = e164.lstrip("+")
    if len(digits) == 11 and digits.startswith("1"):
        nanp = digits[1:]
    elif len(digits) == 10:
        nanp = digits
    else:
        # Non-NANP international — we don't service, so don't try to send.
        return False
    if len(nanp) != 10:
        return False
    if nanp[0] in ("0", "1"):
        return False
    if nanp[3] in ("0", "1"):
        return False
    return True
