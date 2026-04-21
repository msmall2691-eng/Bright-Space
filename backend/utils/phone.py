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
