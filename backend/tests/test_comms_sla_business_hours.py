"""Business-hours-aware SLA: a message that lands outside business hours must
not burn its response clock overnight / on the weekend.

The old SLA was plain wall-clock (2h), so a Friday-evening text was "Overdue"
by Friday night and stayed red all weekend — for a 1–2 person office that made
nearly every conversation breach and the label meaningless. add_business_minutes
counts only business hours (default Mon–Fri, 8am–6pm, company timezone).
"""
from datetime import datetime
from zoneinfo import ZoneInfo

from utils.dates import add_business_minutes

ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")


def _run(local_et: datetime, minutes: int) -> datetime:
    """Feed an ET wall-clock time in, get the deadline back as ET (DST-safe)."""
    start_utc = local_et.replace(tzinfo=ET).astimezone(UTC)
    out_naive_utc = add_business_minutes(start_utc, minutes)
    return out_naive_utc.replace(tzinfo=UTC).astimezone(ET)


def test_within_hours_simple():
    # Monday 9:00am + 120 business min → 11:00am same day.
    got = _run(datetime(2026, 7, 13, 9, 0), 120)   # 2026-07-13 is a Monday
    assert (got.year, got.month, got.day, got.hour, got.minute) == (2026, 7, 13, 11, 0)


def test_before_open_snaps_to_open():
    # Monday 6:00am (before 8am open) + 30 → 8:30am.
    got = _run(datetime(2026, 7, 13, 6, 0), 30)
    assert (got.hour, got.minute, got.day) == (8, 30, 13)


def test_rolls_over_close_to_next_business_day():
    # Monday 5:00pm + 120: 60 min to 6pm close, remaining 60 → Tue 8–9am.
    got = _run(datetime(2026, 7, 13, 17, 0), 120)
    assert (got.day, got.hour, got.minute) == (14, 9, 0)  # Tuesday 9:00am


def test_friday_evening_does_not_burn_the_weekend():
    # Friday 5:00pm + 120: 60 min Friday, remaining 60 → MONDAY 8–9am, not Sat.
    got = _run(datetime(2026, 7, 17, 17, 0), 120)       # 2026-07-17 is a Friday
    assert got.weekday() == 0                            # Monday
    assert (got.hour, got.minute) == (9, 0)


def test_saturday_inbound_snaps_to_monday_open():
    # Saturday 10:00am + 60 → Monday 8–9am (no business time on the weekend).
    got = _run(datetime(2026, 7, 18, 10, 0), 60)        # Saturday
    assert got.weekday() == 0 and (got.hour, got.minute) == (9, 0)


def test_full_business_day_normal_target():
    # 480 business min (the new "normal" default) from Monday 9am, with a
    # 10-hour business day (8–18): 9am + 8h = 5pm same day.
    got = _run(datetime(2026, 7, 13, 9, 0), 480)
    assert (got.day, got.hour) == (13, 17)


def test_terminates_and_stays_a_business_instant():
    # Sanity: a large value still returns a weekday inside business hours.
    got = _run(datetime(2026, 7, 17, 17, 0), 5000)
    assert got.weekday() in {0, 1, 2, 3, 4}
    assert 8 <= got.hour <= 18
