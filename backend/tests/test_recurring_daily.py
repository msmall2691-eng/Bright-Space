"""Daily recurrence generation (every day / every N days / weekday-limited)."""
from datetime import date, timedelta
from database.models import RecurringSchedule
from modules.recurring.router import generate_dates


def _sched(**kw):
    defaults = dict(frequency="daily", interval_weeks=1, days_of_week=[], day_of_week=0,
                    day_of_month=None)
    defaults.update(kw)
    return RecurringSchedule(**defaults)


def test_daily_every_day():
    dates = generate_dates(_sched(), weeks_ahead=1)
    # today .. today+7 inclusive = 8 consecutive days
    assert dates[0] == date.today()
    assert len(dates) == 8
    for a, b in zip(dates, dates[1:]):
        assert (b - a) == timedelta(days=1)


def test_daily_every_other_day():
    dates = generate_dates(_sched(interval_weeks=2), weeks_ahead=2)
    for a, b in zip(dates, dates[1:]):
        assert (b - a) == timedelta(days=2)


def test_daily_limited_to_weekdays():
    dates = generate_dates(_sched(days_of_week=[0, 1, 2, 3, 4]), weeks_ahead=2)
    assert dates, "expected some weekday dates"
    assert all(d.weekday() < 5 for d in dates)  # Mon-Fri only
