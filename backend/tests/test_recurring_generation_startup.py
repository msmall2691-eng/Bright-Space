"""Visit generation has to actually run.

The owner's Recurring health scan kept getting WORSE with nobody touching
anything — 31 series, 9 healthy one day and 6 the next. Series don't vanish;
they DRAIN. A live series whose last generated visit slides into the past
becomes "active but no upcoming visits" on the scan, so the number climbs on
its own.

The cause: an APScheduler IntervalTrigger fires first one whole interval AFTER
registration. Visit generation is on a 24-hour interval, and every deploy
restarts the container and restarts that clock — so on any day this app was
deployed, generation never ran. Three deploys in a day meant three days of no
generated visits. Nothing logged it, nothing surfaced it; the calendar just
quietly stopped filling in.

Every other tick in scheduler.py uses a minutes-long interval and self-heals
within the hour. This is the only one long enough for a deploy to starve.

Pinned here: the recurring job is registered to run SOON after start, not a
day later. Asserted against APScheduler's real trigger/job objects rather than
a mock of them, since the whole bug was a wrong belief about what the real
scheduler does with an interval job.
"""
import os
from datetime import datetime, timedelta, timezone

import pytest

from apscheduler.triggers.interval import IntervalTrigger


def test_an_interval_trigger_really_does_wait_a_whole_interval():
    """The premise, stated as a test so nobody has to take it on faith.

    If a future APScheduler ever changed this, the startup run below would be
    belt-and-braces rather than load-bearing — and this test is where you'd
    find that out.
    """
    now = datetime.now(timezone.utc)
    first = IntervalTrigger(hours=24).get_next_fire_time(None, now)
    assert first - now > timedelta(hours=23), \
        "an interval job's first fire is one full interval out — that is the bug"


def _registered_recurring_job(monkeypatch):
    """Start the scheduler in-process and hand back its recurring job.

    The singleton lock is bypassed rather than mocked away wholesale: the point
    is to exercise the real add_job/trigger path in start_scheduler.
    """
    import scheduler as sched_mod

    monkeypatch.setattr(sched_mod, "_claim_scheduler_singleton_lock", lambda: True)
    # Registration only — never let a real tick fire during the test.
    monkeypatch.setattr(sched_mod.BackgroundScheduler, "start", lambda self, *a, **k: None)
    sched_mod.start_scheduler()
    try:
        yield sched_mod._scheduler.get_job("recurring_jobs")
    finally:
        sched_mod._scheduler = None


@pytest.fixture
def recurring_job(monkeypatch):
    yield from _registered_recurring_job(monkeypatch)


def _first_run_delay(job):
    """How long after registration the job first runs.

    `next_run_time` is only set on a job once the scheduler is running OR the
    caller passed one explicitly — which is exactly the fix. So its ABSENCE is
    the bug, not a test artifact: without an explicit first run, the answer
    comes from the trigger, and the trigger says tomorrow.
    """
    now = datetime.now(timezone.utc)
    explicit = getattr(job, "next_run_time", None)
    return (explicit or job.trigger.get_next_fire_time(None, now)) - now


def test_generation_runs_shortly_after_startup_not_a_day_later(recurring_job):
    assert recurring_job is not None, "recurring generation must be registered at all"
    due_in = _first_run_delay(recurring_job)
    assert due_in < timedelta(minutes=30), (
        f"first generation run is {due_in} away — every deploy would reset that "
        "clock and generation would never run on a day anything shipped"
    )


def test_it_still_repeats_on_the_configured_interval(recurring_job):
    # The startup run must not have replaced the daily cadence with a one-shot.
    assert isinstance(recurring_job.trigger, IntervalTrigger)
    assert recurring_job.trigger.interval == timedelta(hours=24)


def test_the_startup_delay_is_configurable(monkeypatch):
    # Deployments differ in how long they take to become healthy; the delay
    # exists so generation doesn't compete with a boot, not as a magic number.
    monkeypatch.setenv("RECURRING_AUTO_GENERATE_STARTUP_DELAY_SECONDS", "5")
    gen = _registered_recurring_job(monkeypatch)
    job = next(gen)
    try:
        assert _first_run_delay(job) < timedelta(seconds=30)
    finally:
        next(gen, None)


def test_the_kill_switch_still_wins(monkeypatch):
    # A deployment that turned generation off must stay off — the startup run
    # is inside that gate, not a way around it.
    monkeypatch.setenv("RECURRING_AUTO_GENERATE_ENABLED", "0")
    gen = _registered_recurring_job(monkeypatch)
    job = next(gen)
    try:
        assert job is None
    finally:
        next(gen, None)
