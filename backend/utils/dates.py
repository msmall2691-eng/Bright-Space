"""Tolerant date coercion/formatting shared by the quote, PDF, and email paths.

Production schema has drifted: some date columns (notably ``quotes.valid_until``)
come back as ``str`` rather than ``date``. Calling ``.strftime()`` directly on a
string raises ``AttributeError`` and 500s the request. These helpers accept a
``date``/``datetime`` OR an ISO string and never raise on unexpected input, so a
single bad value can't take down the customer-facing quote page or quote sending.
"""

from datetime import date, datetime
from typing import Optional, Union

DateLike = Union[date, datetime, str, None]


def coerce_date(v: DateLike) -> Optional[date]:
    """Return a ``date`` from a date/datetime/ISO-string, else ``None``.

    Empty string and unparseable input become ``None`` (never raises)."""
    if not v:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except (ValueError, TypeError):
        return None


def fmt_long_date(v: DateLike) -> Optional[str]:
    """'July 13, 2026' from a date/datetime OR an ISO string. None-safe.

    Never raises on unexpected input: an unparseable non-empty string is
    returned as-is rather than 500-ing the caller."""
    if not v:
        return None
    d = coerce_date(v)
    if d is None:
        # Non-empty but unparseable (e.g. already a human string): pass through.
        return v if isinstance(v, str) else None
    return d.strftime("%B %d, %Y")
