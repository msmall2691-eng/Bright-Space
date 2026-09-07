"""BB-OPS-02: remember how each background tick last went.

Thirteen ticks run the automated half of this business — recurring job
generation, iCal turnover ingest, Google Calendar push, SMS reminders, invoice
dunning, quote expiry. Twelve of them catch `Exception` at the top and
`return {"error": str(e)}`; the thirteenth lets it propagate. Either way the
outcome was the same: a line in the container log, and nothing anywhere a
person looks. A tick could fail every 15 minutes for three weeks and the first
sign would be a customer asking where their cleaner is.

This module is the memory. `scheduler.py` registers one APScheduler listener
that feeds it, and two endpoints read it:

  * GET /api/health          — counts only. It is PUBLIC (Railway probes it
                               unauthenticated), so it must never carry tick
                               names or error text. BB-SEC-14 is the recent
                               lesson about what leaks out of a public route.
  * GET /api/admin/scheduler — the detail, admin/manager only.

Deliberately IN-MEMORY, not a table:

  * The scheduler is a singleton (one process holds an flock), so there is
    exactly one writer and no coordination to do.
  * A DB write per tick per 10 minutes, forever, to store something only read
    when someone asks, is the kind of background write `brightbase-economy`
    exists to prevent.
  * It resets on redeploy, which reads as "no run recorded yet" — honest, and
    distinguishable from "ran and failed".

Not a new background tick (scheduling-invariants R1): nothing here runs on a
timer. It records what the ticks already do and answers when asked.
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any, Optional

# A tick is STALE when it has gone this many times its own interval without a
# run. A multiplier rather than a fixed clock: "the 6-hourly audit hasn't run
# in 15 minutes" is noise, "the 15-minute iCal sync hasn't run in 6 hours" is
# the thing you want to be told.
STALE_INTERVAL_MULTIPLIER = 3

# Error text is truncated before it is stored. A traceback string pasted into
# a JSON response helps nobody and is the shape of thing that ends up in a
# screenshot; the full detail is in the logs where it belongs.
MAX_ERROR_CHARS = 300

_lock = threading.Lock()
_state: dict[str, dict[str, Any]] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def reset() -> None:
    """Forget everything. For tests, and for nothing else."""
    with _lock:
        _state.clear()


def _entry(job_id: str) -> dict[str, Any]:
    return _state.setdefault(job_id, {
        "job_id": job_id,
        "last_run_at": None,
        "last_ok_at": None,
        "last_error_at": None,
        "last_error": None,
        "last_result": None,
        "runs": 0,
        "errors": 0,
        "consecutive_errors": 0,
        "misses": 0,
        "last_missed_at": None,
    })


def record_success(job_id: str, result: Any = None, when: Optional[datetime] = None) -> None:
    when = when or _now()
    with _lock:
        e = _entry(job_id)
        e["last_run_at"] = when
        e["last_ok_at"] = when
        e["runs"] += 1
        e["consecutive_errors"] = 0
        e["last_result"] = _summarize(result)


def record_error(job_id: str, message: str, when: Optional[datetime] = None) -> None:
    when = when or _now()
    with _lock:
        e = _entry(job_id)
        e["last_run_at"] = when
        e["last_error_at"] = when
        e["last_error"] = (message or "")[:MAX_ERROR_CHARS] or "unknown error"
        e["runs"] += 1
        e["errors"] += 1
        e["consecutive_errors"] += 1


def record_missed(job_id: str, when: Optional[datetime] = None) -> None:
    """A run APScheduler skipped because it came up past its grace period.

    Worth counting separately from an error: a miss means the tick never ran,
    so "last run succeeded" is true and useless. Repeated misses point at the
    scheduler being blocked or the grace window being too tight, which is a
    different fix from a failing tick.
    """
    when = when or _now()
    with _lock:
        e = _entry(job_id)
        e["misses"] += 1
        e["last_missed_at"] = when


def _summarize(result: Any) -> Optional[dict]:
    """Keep the small scalar counters a tick returns, drop everything else.

    Ticks return things like {"properties_synced": 4, "failures": [...]}. The
    counts are what you want on a status page; `failures` carries property
    names and provider error strings, so it is not kept here.
    """
    if not isinstance(result, dict):
        return None
    return {k: v for k, v in result.items() if isinstance(v, (int, float, bool))}


def _is_stale(entry: dict, interval_seconds: Optional[float], now: datetime) -> bool:
    if not interval_seconds:
        return False
    last = entry.get("last_run_at")
    if last is None:
        # Never run. Only stale once it has had time to run at least once —
        # right after a deploy, "hasn't run yet" is the correct state, not a
        # problem to page about.
        return False
    return (now - last).total_seconds() > interval_seconds * STALE_INTERVAL_MULTIPLIER


def snapshot(jobs: Optional[list[dict]] = None) -> dict:
    """Full per-tick detail. `jobs` is what the scheduler currently has
    registered: [{"id", "name", "next_run_time", "interval_seconds"}].

    Registered-but-never-run and ran-but-no-longer-registered are both real
    states and both visible: the first is a fresh deploy, the second is a tick
    that was disabled by config while its history is still in memory.
    """
    now = _now()
    jobs = jobs or []
    by_id = {j["id"]: j for j in jobs}

    # A pure read: never call _entry() here, or asking for the status would
    # itself invent history for every registered tick.
    blank = {
        "last_run_at": None, "last_ok_at": None, "last_error_at": None,
        "last_error": None, "last_result": None, "runs": 0, "errors": 0,
        "consecutive_errors": 0, "misses": 0, "last_missed_at": None,
    }
    with _lock:
        ids = sorted(set(by_id) | set(_state))
        out = []
        for jid in ids:
            e = _state.get(jid) or blank
            j = by_id.get(jid, {})
            interval = j.get("interval_seconds")
            stale = _is_stale(e, interval, now)
            healthy = e["consecutive_errors"] == 0 and not stale
            out.append({
                "job_id": jid,
                "name": j.get("name") or jid,
                "registered": jid in by_id,
                "healthy": healthy,
                "stale": stale,
                "next_run_at": j.get("next_run_time"),
                "interval_seconds": interval,
                "last_run_at": _iso(e["last_run_at"]),
                "last_ok_at": _iso(e["last_ok_at"]),
                "last_error_at": _iso(e["last_error_at"]),
                "last_error": e["last_error"],
                "last_result": e["last_result"],
                "runs": e["runs"],
                "errors": e["errors"],
                "consecutive_errors": e["consecutive_errors"],
                "misses": e["misses"],
                "last_missed_at": _iso(e["last_missed_at"]),
            })
    return {"ticks": out, "checked_at": _iso(now)}


def summary(jobs: Optional[list[dict]] = None) -> dict:
    """Counts only — safe for the PUBLIC /api/health.

    No tick names, no error text, no timestamps that would let someone map the
    schedule. Just enough for "is the automation running" to be answerable
    without a login, and for Railway to see a number move.
    """
    detail = snapshot(jobs)
    ticks = detail["ticks"]
    return {
        "registered": sum(1 for t in ticks if t["registered"]),
        "failing": sum(1 for t in ticks if t["consecutive_errors"] > 0),
        "stale": sum(1 for t in ticks if t["stale"]),
    }
