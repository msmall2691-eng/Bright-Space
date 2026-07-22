"""The three recurrence expansions (generate_dates, _nth_occurrence_date,
_is_on_phase) are now built on ONE predicate (_occurs_on). These tests lock that
in: they were hand-copied branch ladders that drifted (the biweekly-anchor bug
had to be patched in each), so this guards against a future re-divergence.

Pure functions — no DB, no SQLite date-coercion caveat.
"""
from datetime import date, time, timedelta

from database.models import RecurringSchedule
from modules.recurring.router import (
    generate_dates, _nth_occurrence_date, _is_on_phase, _iter_occurrences,
)
from utils.dates import business_today


def _sched(**kw):
    base = dict(frequency="weekly", interval_weeks=1, days_of_week=[0], day_of_week=0,
                day_of_month=None, start_time=time(9), end_time=time(11),
                anchor_date=None, series_start_date=None, series_end_date=None)
    base.update(kw)
    return RecurringSchedule(**base)


_TODAY = business_today()
_MON = _TODAY - timedelta(days=_TODAY.weekday())  # a Monday, for stable phase

CONFIGS = [
    # weekly single + multi-day
    _sched(frequency="weekly", interval_weeks=1, days_of_week=[0], day_of_week=0),
    _sched(frequency="weekly", interval_weeks=1, days_of_week=[0, 2, 4], day_of_week=0),
    # biweekly / tri-weekly, anchored in the past so parity is fixed
    _sched(frequency="biweekly", interval_weeks=2, days_of_week=[2], day_of_week=2,
           anchor_date=_MON - timedelta(weeks=6)),
    _sched(frequency="biweekly", interval_weeks=2, days_of_week=[0, 4], day_of_week=0,
           anchor_date=_MON - timedelta(weeks=3)),
    _sched(frequency="weekly", interval_weeks=3, days_of_week=[1], day_of_week=1,
           anchor_date=_MON - timedelta(weeks=9)),
    # daily: every day, every 2 days, weekday-filtered
    _sched(frequency="daily", interval_weeks=1, days_of_week=[]),
    _sched(frequency="daily", interval_weeks=2, days_of_week=[],
           anchor_date=_TODAY - timedelta(days=10)),
    _sched(frequency="daily", interval_weeks=1, days_of_week=[0, 1, 2, 3, 4], day_of_week=0),
    # monthly on various days-of-month
    _sched(frequency="monthly", interval_weeks=1, days_of_week=None, day_of_month=1),
    _sched(frequency="monthly", interval_weeks=1, days_of_week=None, day_of_month=15),
    _sched(frequency="monthly", interval_weeks=1, days_of_week=None, day_of_month=31),
    # a series that starts in the future (split floor) and one that ends soon
    _sched(frequency="weekly", interval_weeks=1, days_of_week=[3], day_of_week=3,
           series_start_date=_TODAY + timedelta(days=10)),
    _sched(frequency="weekly", interval_weeks=1, days_of_week=[3], day_of_week=3,
           series_end_date=_TODAY + timedelta(days=21)),
]


def _range_bounds(s, weeks):
    """Replicate generate_dates' own [start, end] window."""
    start = business_today()
    if s.series_start_date and s.series_start_date > start:
        start = s.series_start_date
    end = start + timedelta(weeks=weeks)
    if s.series_end_date and s.series_end_date <= end:
        end = s.series_end_date - timedelta(days=1)
    return start, end


def test_generate_dates_equals_predicate_filtered_range():
    """generate_dates == exactly the dates in its window that _is_on_phase
    accepts — the list expansion and the single-date classifier can't disagree."""
    for s in CONFIGS:
        start, end = _range_bounds(s, 8)
        expected, d = [], start
        while d <= end:
            if _is_on_phase(s, d):
                expected.append(d)
            d += timedelta(days=1)
        assert generate_dates(s, 8) == expected, s.frequency


def test_generate_dates_is_sorted_and_unique():
    for s in CONFIGS:
        out = generate_dates(s, 12)
        assert out == sorted(out)
        assert len(out) == len(set(out))


def test_nth_matches_the_expansion_from_origin():
    """_nth_occurrence_date(k) is the kth occurrence counted from the pinned
    origin — the same sequence, bounded by count instead of a date window."""
    for s in CONFIGS:
        origin = s.anchor_date or s.series_start_date or business_today()
        seq = list(_iter_occurrences(s, origin, origin + timedelta(days=365 * 4), origin))
        for k in (1, 2, 3, 5, 8):
            expected = seq[k - 1] if len(seq) >= k else None
            assert _nth_occurrence_date(s, k) == expected, (s.frequency, k)


def test_biweekly_stays_biweekly():
    """The original drift bug: biweekly filled its off-weeks and became weekly."""
    s = _sched(frequency="biweekly", interval_weeks=2, days_of_week=[0], day_of_week=0,
               anchor_date=_MON - timedelta(weeks=6))
    dates = generate_dates(s, 16)
    for a, b in zip(dates, dates[1:]):
        assert (b - a).days == 14
    for d in dates:
        assert (d - s.anchor_date).days % 14 == 0


def test_daily_every_two_days_spacing():
    s = _sched(frequency="daily", interval_weeks=2, days_of_week=[],
               anchor_date=business_today())
    dates = generate_dates(s, 3)
    for a, b in zip(dates, dates[1:]):
        assert (b - a).days == 2
