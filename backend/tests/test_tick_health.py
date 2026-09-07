"""BB-OPS-02: a background tick that fails must stop being invisible.

Thirteen ticks run the automated half of this business. Twelve catch
`Exception` at the top and `return {"error": str(e)}`; one (`ical_sync`) lets
it propagate. Before this, both shapes produced a log line and nothing else —
a tick could fail every fifteen minutes for weeks and the first sign would be
a customer asking where their cleaner is.

The important case is the twelve. An APScheduler EVENT_JOB_ERROR listener is
the obvious fix and it would have caught ONE tick in thirteen, because the
other twelve never raise — so a real scheduler is driven here rather than the
listener being called by hand, and both shapes are asserted.
"""
import time

import pytest
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.events import (EVENT_JOB_ERROR, EVENT_JOB_EXECUTED,
                                EVENT_JOB_MISSED)
from apscheduler.triggers.interval import IntervalTrigger
from fastapi.testclient import TestClient

from main import app
from modules.auth.router import get_current_user, current_org_id
from services import tick_health
from scheduler import _record_tick_event


@pytest.fixture(autouse=True)
def _clean_registry():
    tick_health.reset()
    yield
    tick_health.reset()


# ── The registry ─────────────────────────────────────────────────────────────

def test_a_failing_tick_is_remembered_and_a_recovery_clears_it():
    tick_health.record_error("ical_sync", "Connection reset by peer")
    tick_health.record_error("ical_sync", "Connection reset by peer")

    t = _tick(tick_health.snapshot(), "ical_sync")
    assert t["consecutive_errors"] == 2
    assert t["errors"] == 2
    assert t["healthy"] is False
    assert "Connection reset" in t["last_error"]

    tick_health.record_success("ical_sync", {"properties_synced": 3})
    t = _tick(tick_health.snapshot(), "ical_sync")
    assert t["consecutive_errors"] == 0
    assert t["healthy"] is True
    # The error is kept as history — "it broke and recovered" is worth seeing.
    assert t["errors"] == 2
    assert t["last_error"] is not None


def test_result_keeps_counts_and_drops_the_failure_detail():
    """A tick's return carries counts AND a `failures` list with property names
    and provider error strings. The counts belong on a status page; the rest
    does not get copied into a second place."""
    tick_health.record_success("ical_sync", {
        "properties_checked": 9,
        "properties_synced": 8,
        "failures": [{"property_name": "22 Kincaid St", "error": "403 from host"}],
    })
    t = _tick(tick_health.snapshot(), "ical_sync")
    assert t["last_result"] == {"properties_checked": 9, "properties_synced": 8}
    assert "Kincaid" not in repr(t)


def test_error_text_is_truncated():
    tick_health.record_error("gcal_sync", "x" * 5000)
    t = _tick(tick_health.snapshot(), "gcal_sync")
    assert len(t["last_error"]) == tick_health.MAX_ERROR_CHARS


def test_a_missed_run_is_counted_separately_from_a_failure():
    """A miss means the tick never ran, so "last run succeeded" stays true and
    useless. Repeated misses mean the scheduler is blocked or the grace window
    is too tight — a different fix from a failing tick."""
    tick_health.record_missed("recurring_jobs")
    t = _tick(tick_health.snapshot(), "recurring_jobs")
    assert t["misses"] == 1
    assert t["errors"] == 0
    assert t["last_missed_at"] is not None


def test_stale_is_relative_to_the_ticks_own_interval():
    """"The 6-hourly audit hasn't run in 15 minutes" is noise; "the 15-minute
    iCal sync hasn't run in 6 hours" is the thing to say."""
    from datetime import datetime, timedelta, timezone
    long_ago = datetime.now(timezone.utc) - timedelta(hours=2)
    tick_health.record_success("ical_sync", None, when=long_ago)
    tick_health.record_success("schedule_audit", None, when=long_ago)

    jobs = [
        {"id": "ical_sync", "name": "iCal", "interval_seconds": 900},        # 15m
        {"id": "schedule_audit", "name": "Audit", "interval_seconds": 21600},  # 6h
    ]
    snap = tick_health.snapshot(jobs)
    assert _tick(snap, "ical_sync")["stale"] is True
    assert _tick(snap, "schedule_audit")["stale"] is False


def test_snapshot_does_not_invent_history():
    """Asking for the status must not create entries — otherwise every read
    would report every registered tick as having run."""
    jobs = [{"id": "never_ran", "name": "Nope", "interval_seconds": 900}]
    snap = tick_health.snapshot(jobs)
    t = _tick(snap, "never_ran")
    assert t["runs"] == 0 and t["last_run_at"] is None
    assert t["registered"] is True
    assert tick_health._state == {}, "reading the status wrote to the registry"


# ── The listener, driven by a real scheduler ─────────────────────────────────

def _run_once(fn, job_id):
    """Register fn on a real BackgroundScheduler with our listener and let it
    fire once."""
    sched = BackgroundScheduler(job_defaults={"misfire_grace_time": 60, "coalesce": True})
    sched.add_listener(_record_tick_event,
                       EVENT_JOB_EXECUTED | EVENT_JOB_ERROR | EVENT_JOB_MISSED)
    sched.add_job(fn, IntervalTrigger(seconds=1), id=job_id, name=job_id)
    sched.start()
    try:
        for _ in range(100):
            if tick_health._state.get(job_id, {}).get("runs"):
                break
            time.sleep(0.05)
    finally:
        sched.shutdown(wait=False)


def test_listener_catches_a_tick_that_swallows_its_own_exception():
    """THE case that matters. Twelve of thirteen ticks look like this, and an
    EVENT_JOB_ERROR listener alone would never fire for any of them."""
    def swallowing_tick():
        try:
            raise RuntimeError("gmail token expired")
        except Exception as e:                      # exactly what the ticks do
            return {"error": str(e)}

    _run_once(swallowing_tick, "swallower")

    t = _tick(tick_health.snapshot(), "swallower")
    assert t["healthy"] is False, "a swallowed failure was recorded as success"
    assert "gmail token expired" in t["last_error"]


def test_listener_catches_a_tick_that_raises():
    def raising_tick():
        raise ValueError("feed unreachable")

    _run_once(raising_tick, "raiser")

    t = _tick(tick_health.snapshot(), "raiser")
    assert t["healthy"] is False
    assert "feed unreachable" in t["last_error"]
    assert "ValueError" in t["last_error"]


def test_listener_records_a_clean_run_as_healthy():
    _run_once(lambda: {"properties_synced": 2}, "happy")

    t = _tick(tick_health.snapshot(), "happy")
    assert t["healthy"] is True
    assert t["last_error"] is None
    assert t["last_result"] == {"properties_synced": 2}


def test_the_listener_never_raises():
    """It runs inside APScheduler's executor callback; an exception here would
    be swallowed by the very machinery this exists to make visible."""
    class Broken:
        code = EVENT_JOB_EXECUTED
        job_id = "x"
        @property
        def retval(self):
            raise RuntimeError("boom")

    _record_tick_event(Broken())          # must not raise
    _record_tick_event(None)              # must not raise


# ── The two read surfaces ────────────────────────────────────────────────────

class _Admin:
    id, org_id, role, status, active = 9401, 1, "admin", "active", True
    email = "sched-admin@example.com"


class _Cleaner:
    id, org_id, role, status, active = 9402, 1, "cleaner", "active", True
    email = "sched-cleaner@example.com"


@pytest.fixture
def as_role():
    def _use(cls):
        app.dependency_overrides[get_current_user] = lambda: cls()
        app.dependency_overrides[current_org_id] = lambda: 1
        return TestClient(app)
    yield _use
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_public_health_carries_counts_and_nothing_identifying():
    """/api/health is probed by Railway with no credentials. BB-SEC-14 is the
    recent lesson: a public route must not narrate internals."""
    tick_health.record_error("gmail_sync", "OAuth token for hello@maineclean.co expired")

    body = TestClient(app).get("/api/health").json()
    assert body["scheduler"] == {"registered": 0, "failing": 1, "stale": 0}

    blob = repr(body)
    assert "gmail_sync" not in blob, "a public route named a tick"
    assert "maineclean.co" not in blob, "a public route leaked error text"
    assert "OAuth" not in blob


def test_a_failing_tick_does_not_change_the_health_gate():
    """A broken iCal feed must not pull the container out of service — that
    turns one failing integration into an outage.

    Asserted as "the status code does not MOVE", not as "200". Railway's gate
    keys on schema drift, and this shared test DB is built with create_all and
    no alembic_version, so /api/health legitimately reports no_table_drifted
    and 503 here whatever the ticks are doing. Comparing before/after isolates
    the only thing this change could have affected."""
    client = TestClient(app)
    before = client.get("/api/health").status_code

    for _ in range(5):
        tick_health.record_error("ical_sync", "host unreachable")

    after = client.get("/api/health")
    assert after.status_code == before
    assert after.json()["scheduler"]["failing"] == 1, "the failure was not recorded at all"


def test_admin_sees_which_tick_and_why(as_role):
    tick_health.record_error("gmail_sync", "OAuth token expired")

    body = as_role(_Admin).get("/api/admin/scheduler").json()
    t = _tick(body, "gmail_sync")
    assert t["healthy"] is False
    assert "OAuth token expired" in t["last_error"]
    assert body["summary"]["failing"] == 1
    assert "running" in body


def test_crew_cannot_read_the_scheduler_detail(as_role):
    assert as_role(_Cleaner).get("/api/admin/scheduler").status_code == 403


# ── helper ───────────────────────────────────────────────────────────────────

def _tick(payload, job_id):
    for t in payload["ticks"]:
        if t["job_id"] == job_id:
            return t
    raise AssertionError(f"{job_id} not in {[t['job_id'] for t in payload['ticks']]}")
