"""Regression test for the UTC 'today' drift bug.

Before ``business_today()`` existed, ``date.today()`` on the UTC Railway box
flipped to *tomorrow* at 8pm Eastern, shifting schedules/reminders/dashboards
by a day every evening. This test locks in that ``business_today()`` returns
the Eastern calendar date even when UTC has already rolled over.
"""
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from utils import dates


def _patch_now(fixed_utc: datetime):
    """Return a context manager that pins ``datetime.now`` inside utils.dates
    to a fixed UTC instant (still converts correctly to any tz argument)."""

    class _FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return fixed_utc.replace(tzinfo=None)
            return fixed_utc.astimezone(tz)

    return patch.object(dates, "datetime", _FakeDatetime)


def test_business_today_is_eastern_not_utc_after_8pm_eastern():
    # 3:30am UTC on the 6th == 11:30pm Eastern on the 5th (EDT). The old
    # date.today() would return the 6th; business_today() must stay on the 5th.
    fixed = datetime(2026, 7, 6, 3, 30, tzinfo=ZoneInfo("UTC"))
    with _patch_now(fixed):
        assert dates.business_today().isoformat() == "2026-07-05"


def test_business_today_flips_only_at_eastern_midnight():
    # 4:30am UTC on the 6th == 12:30am Eastern on the 6th (EDT). Both agree.
    fixed = datetime(2026, 7, 6, 4, 30, tzinfo=ZoneInfo("UTC"))
    with _patch_now(fixed):
        assert dates.business_today().isoformat() == "2026-07-06"


def test_business_tz_env_override(monkeypatch):
    monkeypatch.setenv("BUSINESS_TIMEZONE", "America/Los_Angeles")
    # 3:30am UTC on the 6th == 8:30pm Pacific on the 5th.
    fixed = datetime(2026, 7, 6, 3, 30, tzinfo=ZoneInfo("UTC"))
    with _patch_now(fixed):
        assert dates.business_today().isoformat() == "2026-07-05"


def test_business_tz_falls_back_to_gcal_timezone(monkeypatch):
    monkeypatch.delenv("BUSINESS_TIMEZONE", raising=False)
    monkeypatch.setenv("GCAL_TIMEZONE", "Europe/London")
    assert dates.business_tz().key == "Europe/London"


def test_business_tz_defaults_to_eastern(monkeypatch):
    monkeypatch.delenv("BUSINESS_TIMEZONE", raising=False)
    monkeypatch.delenv("GCAL_TIMEZONE", raising=False)
    assert dates.business_tz().key == "America/New_York"
