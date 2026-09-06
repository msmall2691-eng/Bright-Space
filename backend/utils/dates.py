"""Tolerant date coercion/formatting shared by the quote, PDF, and email paths.

Production schema has drifted: some date columns (notably ``quotes.valid_until``)
come back as ``str`` rather than ``date``. Calling ``.strftime()`` directly on a
string raises ``AttributeError`` and 500s the request. These helpers accept a
``date``/``datetime`` OR an ISO string and never raise on unexpected input, so a
single bad value can't take down the customer-facing quote page or quote sending.
"""

from datetime import date, datetime, time, timedelta, timezone
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


def coerce_time(v) -> Optional[time]:
    """Return a ``time`` from a time/'HH:MM[:SS]' string, else ``None``.

    Tolerant of a missing leading zero ('9:30') and an optional seconds field,
    and never raises. This is the single canonical time parser: the scheduling
    and recurring routers each had their own, and they had DRIFTED — recurring
    used ``time.fromisoformat`` which rejects '9:30', so the same non-zero-padded
    payload wrote a valid time on the scheduling router but silently NULL on the
    recurring one. A Time column needs a real ``time`` object (psycopg2 casts a
    bare string leniently; SQLite's Time type raises), so writes go through this."""
    if v is None or isinstance(v, time):
        return v
    try:
        parts = str(v).strip().split(":")
        hh = int(parts[0])
        mm = int(parts[1]) if len(parts) > 1 and parts[1] != "" else 0
        ss = int(float(parts[2])) if len(parts) > 2 and parts[2] != "" else 0
        return time(hh, mm, ss)
    except (ValueError, TypeError, IndexError):
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


# --- Business-local "today" -------------------------------------------------
#
# The server runs in UTC (Railway), but the business operates in US Eastern.
# ``date.today()`` on a UTC box flips to *tomorrow* at 8pm Eastern, which
# shifted "today" schedules, past-date validation, reminders, and dashboards
# every evening. Use these instead of ``date.today()`` /
# ``datetime.now(timezone.utc)`` whenever "today" means the business day.

import os
from zoneinfo import ZoneInfo


def business_tz() -> ZoneInfo:
    """Company-local timezone (BUSINESS_TIMEZONE > GCAL_TIMEZONE > Eastern)."""
    return ZoneInfo(
        os.getenv("BUSINESS_TIMEZONE")
        or os.getenv("GCAL_TIMEZONE")
        or "America/New_York"
    )


def business_now() -> datetime:
    """Timezone-aware ``datetime.now()`` in the business timezone."""
    return datetime.now(business_tz())


def business_today() -> date:
    """Today's date in the business timezone (NOT the server's UTC date)."""
    return business_now().date()


def business_date(v: DateLike) -> Optional[date]:
    """The calendar date ``v`` fell on IN THE BUSINESS TIMEZONE.

    ``coerce_date`` takes a datetime's date exactly as stored, which for the
    UTC columns in this schema (``models._utcnow``) is the UTC date. For the
    four hours after midnight UTC — an ordinary Maine evening — that is
    TOMORROW's date. Comparing it against ``business_today()`` is therefore an
    off-by-one waiting for somebody to work late: a row stamped at 8pm reads as
    the next day.

    Use this instead of ``coerce_date`` whenever a stored timestamp is about to
    be compared against a business-local date. A naive datetime is assumed UTC,
    which is what those columns hold. A plain ``date`` has no time to convert
    and is returned unchanged.
    """
    if isinstance(v, datetime):
        aware = v if v.tzinfo is not None else v.replace(tzinfo=timezone.utc)
        return aware.astimezone(business_tz()).date()
    return coerce_date(v)


def week_monday(d: date) -> date:
    """The Monday of the week containing ``d`` (ISO week anchor).

    The canonical snap for week-anchored crew availability: BOTH the crew
    write path and the office resolver must snap through this before any
    lookup or lock comparison, so a client sending a mid-week date can never
    dodge the lock or strand a row where per-date resolution won't find it.
    (The office Schedule's Sunday-first strip is a display convention only —
    availability weeks and the crew pay week are Monday-anchored.)
    """
    return d - timedelta(days=d.weekday())


# --- Business-hours SLA math ------------------------------------------------
#
# Response-time SLAs count ONLY business hours, so a message that lands Friday
# evening isn't "overdue" all weekend. Configurable via env:
#   BUSINESS_OPEN_HOUR  (default 8)
#   BUSINESS_CLOSE_HOUR (default 18 = 6pm)
#   BUSINESS_DAYS       (default "0,1,2,3,4" = Mon–Fri; Python weekday(): Mon=0)

def business_hours_config():
    """(open_hour, close_hour, {weekday,…}) with safe fallbacks."""
    try:
        open_h = int(os.getenv("BUSINESS_OPEN_HOUR", "8"))
        close_h = int(os.getenv("BUSINESS_CLOSE_HOUR", "18"))
    except ValueError:
        open_h, close_h = 8, 18
    raw = os.getenv("BUSINESS_DAYS", "0,1,2,3,4")
    try:
        days = {int(x) for x in raw.split(",") if x.strip() != ""}
    except ValueError:
        days = {0, 1, 2, 3, 4}
    # Never allow a config that has zero business time (would loop forever).
    if not days or open_h >= close_h:
        return 8, 18, {0, 1, 2, 3, 4}
    return open_h, close_h, days


def add_business_minutes(start: datetime, minutes: int) -> datetime:
    """Advance ``start`` by ``minutes`` counted ONLY during business hours
    (company timezone), returning a naive-UTC datetime to match how the app
    stores timestamps.

    A start outside business hours snaps forward to the next business open
    before the clock starts. Hard iteration caps guarantee termination even on
    a pathological config.
    """
    tz = business_tz()
    open_h, close_h, days = business_hours_config()

    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    cur = start.astimezone(tz)
    remaining = max(0, int(minutes or 0))

    def at(d, h):
        return d.replace(hour=h, minute=0, second=0, microsecond=0)

    def snap(d):
        # Move to the next instant that is inside business hours.
        for _ in range(400):
            if d.weekday() in days and at(d, open_h) <= d < at(d, close_h):
                return d
            if d.weekday() in days and d < at(d, open_h):
                return at(d, open_h)
            d = at(d + timedelta(days=1), open_h)  # next day's open
        return d

    cur = snap(cur)
    for _ in range(1000):
        if remaining <= 0:
            break
        avail = (at(cur, close_h) - cur).total_seconds() / 60.0
        if remaining <= avail:
            cur = cur + timedelta(minutes=remaining)
            remaining = 0
        else:
            remaining -= avail
            cur = snap(at(cur + timedelta(days=1), open_h))

    return cur.astimezone(timezone.utc).replace(tzinfo=None)
