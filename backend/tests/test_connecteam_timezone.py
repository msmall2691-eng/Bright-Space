"""Regression: Connecteam shift times must be business-local, not UTC.

A job's scheduled_date + start_time are business-local wall-clock (America/
New_York). Connecteam stores shifts as absolute epochs rendered in the
scheduler's own timezone, so a naive 9:00 AM pushed as 9:00 UTC would show on
the cleaner's schedule 4-5 hours off. These tests lock the write side to
business-local and prove reversing the epoch with the same business tz recovers
the exact wall-clock we pushed.
"""
from datetime import datetime

from integrations.connecteam import _to_epoch_seconds
from utils.dates import business_tz


def _reverse(epoch):
    """Inverse of _to_epoch_seconds: render an absolute epoch back to the
    business-local wall-clock it was pushed as."""
    dt = datetime.fromtimestamp(int(epoch), business_tz())
    return dt.date().isoformat(), dt.strftime("%H:%M:%S")


def test_naive_time_is_interpreted_as_business_local():
    epoch = _to_epoch_seconds("2026-07-18T09:00:00")
    expected = int(datetime(2026, 7, 18, 9, 0, 0, tzinfo=business_tz()).timestamp())
    assert epoch == expected


def test_naive_datetime_object_also_business_local():
    epoch = _to_epoch_seconds(datetime(2026, 7, 18, 9, 0, 0))
    expected = int(datetime(2026, 7, 18, 9, 0, 0, tzinfo=business_tz()).timestamp())
    assert epoch == expected


def test_tz_aware_input_is_left_untouched():
    aware = datetime(2026, 7, 18, 13, 0, 0, tzinfo=business_tz())
    assert _to_epoch_seconds(aware) == int(aware.timestamp())


def test_push_then_read_recovers_the_same_wallclock():
    """The core round-trip: push 9-11am, reverse the epoch, get 9-11am — not a
    UTC-shifted 1pm/5am."""
    start = _to_epoch_seconds("2026-07-18T09:00:00")
    end = _to_epoch_seconds("2026-07-18T11:00:00")
    sd, st = _reverse(start)
    _, et = _reverse(end)
    assert sd == "2026-07-18"
    assert st == "09:00:00"
    assert et == "11:00:00"
