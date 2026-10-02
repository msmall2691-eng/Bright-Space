"""Monthly recurring series clamp the day-of-month to the month's last day.

Before this, the monthly branch of _occurs_on was a bare `d.day == day_of_month`
equality, so a series set to the 29th/30th/31st generated NOTHING in any month
that lacks that day — a "clean on the 31st, monthly" series silently produced no
visit in Feb/Apr/Jun/Sep/Nov (~5 months a year). A day_of_month of 31 plainly
means "end of month"; the clamp delivers that (the last calendar day), and never
more than one occurrence per month.
"""
from calendar import monthrange
from datetime import date, timedelta
from types import SimpleNamespace

from modules.recurring.router import _occurs_on, generate_dates
from utils.dates import business_today


def _monthly(dom):
    return SimpleNamespace(
        frequency="monthly", day_of_month=dom, interval_weeks=1,
        anchor_date=None, series_start_date=None, series_end_date=None,
    )


def _year_hits(dom, year):
    s, today = _monthly(dom), date(year, 1, 1)
    out, d = [], date(year, 1, 1)
    while d <= date(year, 12, 31):
        if _occurs_on(s, d, today):
            out.append(d)
        d += timedelta(days=1)
    return out


def test_monthly_31_runs_every_month_clamped_to_end():
    hits = _year_hits(31, 2026)  # 2026 is NOT a leap year
    assert len(hits) == 12, "a monthly-on-the-31st series must run every month"
    # exactly one occurrence per month — the clamp never doubles up
    assert len({d.month for d in hits}) == 12
    by_month = {d.month: d for d in hits}
    assert by_month[1] == date(2026, 1, 31)   # 31-day month -> 31st
    assert by_month[2] == date(2026, 2, 28)   # short month -> last day
    assert by_month[4] == date(2026, 4, 30)   # 30-day month -> 30th
    assert by_month[9] == date(2026, 9, 30)


def test_monthly_29_hits_leap_day_only_in_a_leap_year():
    assert [d for d in _year_hits(29, 2028) if d.month == 2] == [date(2028, 2, 29)]
    assert [d for d in _year_hits(29, 2026) if d.month == 2] == [date(2026, 2, 28)]


def test_monthly_safe_day_is_unchanged():
    # Days 1..28 always exist, so clamping is a no-op for them.
    assert [d.day for d in _year_hits(15, 2026)] == [15] * 12


def test_generate_dates_materializes_the_clamped_end_of_month():
    """End-to-end through the real generation walk (time-robust): floor the
    window into the next February and assert the clamped last-day occurrence —
    and only it — is generated for that month."""
    today = business_today()
    y = today.year if today.month < 2 else today.year + 1  # next February
    s = _monthly(31)
    s.series_start_date = date(y, 2, 1)
    weeks = ((date(y, 2, 1) - today).days // 7) + 5  # reach Feb 1 .. into March
    dates = generate_dates(s, weeks_ahead=weeks)
    feb = [d for d in dates if d.year == y and d.month == 2]
    assert feb == [date(y, 2, monthrange(y, 2)[1])]
