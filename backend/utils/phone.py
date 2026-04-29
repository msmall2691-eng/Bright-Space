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
