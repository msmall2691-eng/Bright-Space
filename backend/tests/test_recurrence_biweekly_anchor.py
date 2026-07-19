"""Regression: biweekly cadence must follow a fixed anchor, not `today`.

Before anchor_date (migration 060), generate_dates() phased the on-week/off-week
cadence off business_today(). Because the generation tick re-runs every day and
`today` advances, a biweekly series re-seated its phase daily and filled in the
off-weeks it was meant to skip — biweekly silently became weekly. These tests
lock the phase to anchor_date so it stays put.
"""
from datetime import timedelta
from database.models import RecurringSchedule
from modules.recurring.router import generate_dates, _nth_occurrence_date, _is_on_phase
from utils.dates import business_today


def _biweekly(anchor, dow=0, interval=2):
    s = RecurringSchedule(
        frequency="biweekly", interval_weeks=interval,
        days_of_week=[dow], day_of_week=dow, day_of_month=None,
    )
    s.anchor_date = anchor
    return s


def test_biweekly_dates_are_all_on_anchor_parity():
    """Every generated occurrence is a whole number of *interval* weeks from the
    anchor — i.e. 14-day multiples for biweekly, never an off-week 7 days out."""
    today = business_today()
    # An anchor Monday safely in the past so generation (which starts at today)
    # still produces plenty of future dates phased to it.
    anchor = (today - timedelta(days=today.weekday())) - timedelta(weeks=6)
    s = _biweekly(anchor, dow=0)
    dates = generate_dates(s, weeks_ahead=12)
    assert dates, "expected biweekly Mondays in the next 12 weeks"
    for d in dates:
        assert d.weekday() == 0
        assert (d - anchor).days % 14 == 0, f"{d} is off the biweekly phase from {anchor}"
    for a, b in zip(dates, dates[1:]):
        assert (b - a).days == 14


def test_two_offset_anchors_produce_disjoint_alternating_weeks():
    """A series anchored to the even week and one anchored to the odd week must
    clean on opposite weeks — proof the phase is honoured, not collapsed to
    every week."""
    today = business_today()
    monday = today - timedelta(days=today.weekday())
    even_anchor = monday - timedelta(weeks=6)   # same parity as `monday`
    odd_anchor = monday - timedelta(weeks=5)    # opposite parity

    even = set(generate_dates(_biweekly(even_anchor, dow=0), weeks_ahead=12))
    odd = set(generate_dates(_biweekly(odd_anchor, dow=0), weeks_ahead=12))

    assert even and odd
    assert even.isdisjoint(odd), "offset biweekly series should never share a week"
    # Together they cover consecutive Mondays (each single one is biweekly).
    union = sorted(even | odd)
    for a, b in zip(union, union[1:]):
        assert (b - a).days == 7


def test_anchor_falls_back_to_first_occurrence_when_unset():
    """With no anchor_date/series_start_date (a brand-new series before
    generate_jobs pins it), the phase derives from the first upcoming
    occurrence, so spacing is still a clean 14 days."""
    s = RecurringSchedule(
        frequency="biweekly", interval_weeks=2,
        days_of_week=[0], day_of_week=0, day_of_month=None,
    )
    # anchor_date left as None on purpose
    dates = sorted(generate_dates(s, weeks_ahead=8))
    for a, b in zip(dates, dates[1:]):
        assert (b - a).days == 14


def test_nth_occurrence_matches_generate_dates_phase():
    """The 'ends after N occurrences' count must land on the same phased dates
    generation produces, so the series-end date is computed correctly."""
    today = business_today()
    anchor = (today - timedelta(days=today.weekday())) - timedelta(weeks=6)
    s = _biweekly(anchor, dow=0)
    dates = generate_dates(s, weeks_ahead=20)
    assert len(dates) >= 3
    # The 3rd occurrence from _nth_occurrence_date should be the 3rd generated.
    assert _nth_occurrence_date(s, 3) == dates[2]


def test_is_on_phase_classifies_off_week_duplicates():
    """The cleanup classifier: a biweekly-Monday series treats the anchor week
    (and every 2nd week after) as on-phase, and the weeks between as off-phase
    (the drift duplicates)."""
    today = business_today()
    anchor = today - timedelta(days=today.weekday())  # a Monday
    s = _biweekly(anchor, dow=0)
    assert _is_on_phase(s, anchor) is True                       # anchor week
    assert _is_on_phase(s, anchor + timedelta(weeks=2)) is True  # on week
    assert _is_on_phase(s, anchor + timedelta(weeks=1)) is False # off week (drift)
    assert _is_on_phase(s, anchor + timedelta(weeks=3)) is False # off week (drift)
    # A different weekday is never this series' occurrence.
    assert _is_on_phase(s, anchor + timedelta(days=1)) is False
