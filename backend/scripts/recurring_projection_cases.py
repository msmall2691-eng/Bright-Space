"""The rule cases both sides of the recurring projection must agree on.

`frontend/src/components/recurring/helpers.js`'s `computeUpcoming` is a
hand-written mirror of `generate_dates`. Its own test file can only pin it
against ITSELF — the backend is Python and not importable from vitest — so for
as long as that was the only check, the two were free to drift, and they had:
four divergences by the time anyone ran both over the same rules.

This module is the shared input half of a real differential. It is imported by:

  * `scripts/gen_recurring_projection_fixture.py` — writes the backend's answers
    to `frontend/src/components/recurring/__tests__/projection.fixture.json`.
  * `tests/test_recurring_projection_fixture.py` — fails if the committed
    fixture no longer matches what `generate_dates` returns, so a change to the
    backend cadence rules cannot land while the frontend's copy of the answers
    is stale.

and the fixture is read by `__tests__/projectionParity.test.js`, which asserts
`computeUpcoming` returns the same dates.

So: change the backend rules and the backend test tells you to regenerate;
regenerate and the frontend test tells you the mirror needs updating. That loop
is what was missing.

ADDING A CASE: append to CASES, regenerate the fixture, commit both. A case is
worth adding when it distinguishes two plausible readings of a rule — the four
below marked DIVERGED each caught a real bug.
"""
import datetime

# Pinned so the fixture is reproducible and the frontend test can fake its
# clock to the same instant. A Tuesday, deliberately: it makes an off-by-one in
# the weekday maths visible instead of landing on a Monday boundary that hides
# it. `generate_dates` reads `business_today()` (America/New_York) and the
# browser reads the viewer's local midnight — the ONE divergence that cannot be
# closed from the browser, and the reason both sides are pinned here.
TODAY = datetime.date(2027, 1, 5)

#: name -> (rule fields, weeks_ahead, what it is for)
CASES = [
    ("weekly_one_day", dict(frequency="weekly", days_of_week=[1],
                            anchor_date=datetime.date(2026, 6, 2)), 8,
     "the ordinary case"),
    ("weekly_multi_day", dict(frequency="weekly", days_of_week=[0, 2, 4],
                              anchor_date=datetime.date(2026, 6, 1)), 4,
     "Mon/Wed/Fri — ascending order across days, not day-by-day blocks"),
    ("biweekly_anchored", dict(frequency="biweekly", interval_weeks=2, days_of_week=[1],
                               anchor_date=datetime.date(2027, 1, 5)), 10,
     "phase counted from the anchor"),
    ("biweekly_other_phase", dict(frequency="biweekly", interval_weeks=2, days_of_week=[1],
                                  anchor_date=datetime.date(2027, 1, 12)), 10,
     "the opposite week — proves the anchor moves the phase, not just the start"),
    ("every_three_weeks", dict(frequency="weekly", interval_weeks=3, days_of_week=[3],
                               anchor_date=datetime.date(2026, 12, 31)), 12,
     "interval > 2"),
    ("daily_every_day", dict(frequency="daily", interval_weeks=1), 1,
     "empty days_of_week means every day, not a fabricated Monday"),
    ("daily_every_three_days", dict(frequency="daily", interval_weeks=3,
                                    anchor_date=datetime.date(2027, 1, 1)), 2,
     "interval_weeks reused as a DAY step, phased off the anchor"),
    ("daily_weekday_filtered", dict(frequency="daily", interval_weeks=1,
                                    days_of_week=[0, 1, 2, 3, 4]), 1,
     "weekdays only"),
    ("monthly_mid", dict(frequency="monthly", day_of_month=15), 26,
     "a day every month has"),
    ("monthly_31", dict(frequency="monthly", day_of_month=31), 26,
     "DIVERGED: clamps to the month's last day; the mirror skipped short months"),
    ("monthly_29", dict(frequency="monthly", day_of_month=29), 26,
     "DIVERGED: the same clamp, visible only in February"),
    ("ends_on_date", dict(frequency="weekly", days_of_week=[1],
                          anchor_date=datetime.date(2026, 6, 2),
                          series_end_date=datetime.date(2027, 1, 20)), 8,
     "DIVERGED: series_end_date is an EXCLUSIVE bound the mirror never read"),
    ("end_beyond_window", dict(frequency="weekly", days_of_week=[1],
                               anchor_date=datetime.date(2026, 6, 2),
                               series_end_date=datetime.date(2029, 1, 1)), 4,
     "an end past the window must not shorten it"),
    ("future_start", dict(frequency="weekly", days_of_week=[1],
                          series_start_date=datetime.date(2027, 2, 1)), 8,
     "DIVERGED: series_start_date is an INCLUSIVE FLOOR, not just a phase anchor"),
    ("past_start", dict(frequency="weekly", days_of_week=[1],
                        series_start_date=datetime.date(2026, 1, 1)), 4,
     "a start already behind us changes nothing"),
    ("short_window", dict(frequency="weekly", days_of_week=[1],
                          anchor_date=datetime.date(2026, 6, 2)), 2,
     "DIVERGED: the mirror floored the window at 4 weeks; nothing clamps here"),
    ("long_window", dict(frequency="monthly", day_of_month=1), 60,
     "a window past a year"),
    ("legacy_single_day", dict(frequency="weekly", day_of_week=4,
                               anchor_date=datetime.date(2026, 6, 5)), 4,
     "days_of_week absent — the legacy column is the fallback"),
    ("no_anchor_at_all", dict(frequency="biweekly", interval_weeks=2, days_of_week=[2]), 8,
     "a brand-new series: phase falls back to the first upcoming occurrence"),
]


class RuleStub:
    """Attribute bag standing in for a RecurringSchedule row.

    `generate_dates` only ever READS attributes off the schedule, so a stub
    keeps this free of a database, a session and a migration — which matters
    because the generator script runs in CI's frontend job too.
    """

    _DEFAULTS = dict(
        frequency=None, interval_weeks=1, days_of_week=None, day_of_week=None,
        day_of_month=None, anchor_date=None, series_start_date=None,
        series_end_date=None, series_end_occurrences=None, generate_weeks_ahead=8,
    )

    def __init__(self, **fields):
        for key, value in {**self._DEFAULTS, **fields}.items():
            setattr(self, key, value)


def backend_projection():
    """{case name: [ISO date, ...]} as `generate_dates` returns them at TODAY.

    Patches `business_today` rather than the clock: it is the one function the
    expansion reads the current date through, so this pins the answer without
    pretending to control the machine's timezone.
    """
    from unittest.mock import patch

    from modules.recurring import router

    out = {}
    with patch.object(router, "business_today", lambda: TODAY):
        for name, fields, weeks, _why in CASES:
            sched = RuleStub(generate_weeks_ahead=weeks, **fields)
            out[name] = [d.isoformat() for d in router.generate_dates(sched, weeks)]
    return out
