"""Regression: Connecteam shift times must be business-local, not UTC.

A job's scheduled_date + start_time are business-local wall-clock (America/
New_York). Connecteam stores shifts as absolute epochs rendered in the
scheduler's own timezone, so a naive 9:00 AM pushed as 9:00 UTC would show on
the cleaner's schedule 4-5 hours off. These tests lock the write side to
business-local and prove the two-way read side reverses it back to the same
wall-clock (so drift detection doesn't false-positive).
"""
from datetime import datetime

from integrations.connecteam import _to_epoch_seconds
from integrations.connecteam_twoway import _ct_snapshot, _ct_times
from utils.dates import business_tz


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
    """The core round-trip: push 9-11am, read it back, get 9-11am — not a
    UTC-shifted 1pm/5am."""
    start = _to_epoch_seconds("2026-07-18T09:00:00")
    end = _to_epoch_seconds("2026-07-18T11:00:00")
    snap = _ct_snapshot({"startTimestamp": start, "endTimestamp": end})
    assert snap == {
        "scheduled_date": "2026-07-18",
        "start_time": "09:00:00",
        "end_time": "11:00:00",
    }
    d, st, et = _ct_times({"startTimestamp": start, "endTimestamp": end})
    assert d.isoformat() == "2026-07-18"
    assert st.strftime("%H:%M") == "09:00"
    assert et.strftime("%H:%M") == "11:00"
