"""Scheduler singleton lock (Codex P1 on #525).

Under multi-worker uvicorn the FastAPI `startup` event fires in every
worker, so without a guard each worker starts its own BackgroundScheduler
and every tick (SMS reminders, invoice dunning, Gmail/GCal sync, etc.)
races in every process — producing duplicate customer texts / dunning
emails / external pushes.

These tests pin the flock-based singleton:

  1. The first process to try wins.
  2. A second process trying while the first holds the lock is refused
     (no scheduler starts in that worker).
  3. After stop_scheduler() releases the lock, a NEW process can claim it.
  4. DISABLE_SCHEDULER=1 short-circuits the claim entirely.
  5. On a platform without flock we fall back to allowing the claim,
     with a warning — better than not running at all.
"""
import os
import sys
import tempfile
from unittest.mock import patch


def _fresh_scheduler_module(monkeypatch, lock_path=None):
    """Reimport scheduler.py with a scratch lock path and reset globals.

    Each test wants an isolated singleton state; reload avoids the file-lock
    file-handle leaking between tests.
    """
    if lock_path is None:
        f = tempfile.NamedTemporaryFile(delete=False, suffix=".lock")
        f.close()
        lock_path = f.name
    monkeypatch.setenv("SCHEDULER_LOCK_PATH", lock_path)
    # Delete any prior copy so the import runs fresh (globals reset).
    sys.modules.pop("scheduler", None)
    import scheduler as scheduler_mod
    return scheduler_mod, lock_path


def test_first_worker_wins_lock(monkeypatch):
    scheduler, _ = _fresh_scheduler_module(monkeypatch)
    monkeypatch.delenv("DISABLE_SCHEDULER", raising=False)
    assert scheduler._claim_scheduler_singleton_lock() is True


def test_second_worker_refused_while_lock_held(monkeypatch):
    scheduler, lock_path = _fresh_scheduler_module(monkeypatch)
    monkeypatch.delenv("DISABLE_SCHEDULER", raising=False)
    assert scheduler._claim_scheduler_singleton_lock() is True

    # Simulate a second worker via a subprocess so it has its own fd table.
    import subprocess
    script = (
        f"import os; os.environ['SCHEDULER_LOCK_PATH']={lock_path!r};"
        "os.environ.pop('DISABLE_SCHEDULER', None);"
        # Path setup so `import scheduler` works from the subprocess.
        f"import sys; sys.path.insert(0, {os.path.dirname(scheduler.__file__)!r});"
        "import scheduler as s; print(s._claim_scheduler_singleton_lock())"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True, text=True, check=True,
        env={**os.environ, "SCHEDULER_LOCK_PATH": lock_path},
    )
    assert out.stdout.strip() == "False", (
        f"second worker unexpectedly won the lock. stdout={out.stdout!r} "
        f"stderr={out.stderr!r}"
    )


def test_lock_releases_on_stop_scheduler(monkeypatch):
    scheduler, lock_path = _fresh_scheduler_module(monkeypatch)
    monkeypatch.delenv("DISABLE_SCHEDULER", raising=False)
    assert scheduler._claim_scheduler_singleton_lock() is True
    scheduler.stop_scheduler()
    # A "second worker" (subprocess again) should now win.
    import subprocess
    script = (
        f"import os; os.environ['SCHEDULER_LOCK_PATH']={lock_path!r};"
        "os.environ.pop('DISABLE_SCHEDULER', None);"
        f"import sys; sys.path.insert(0, {os.path.dirname(scheduler.__file__)!r});"
        "import scheduler as s; print(s._claim_scheduler_singleton_lock())"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True, text=True, check=True,
        env={**os.environ, "SCHEDULER_LOCK_PATH": lock_path},
    )
    assert out.stdout.strip() == "True"


def test_disable_scheduler_env_short_circuits(monkeypatch):
    scheduler, _ = _fresh_scheduler_module(monkeypatch)
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")
    assert scheduler._claim_scheduler_singleton_lock() is False


def test_flock_oserror_falls_back_to_allowing_the_claim(monkeypatch):
    """On a platform / filesystem without flock we log a warning and allow
    the claim (single process = still safe). Simulated by patching
    fcntl.flock to raise OSError.
    """
    scheduler, _ = _fresh_scheduler_module(monkeypatch)
    monkeypatch.delenv("DISABLE_SCHEDULER", raising=False)
    import fcntl
    with patch.object(fcntl, "flock", side_effect=OSError("EINVAL")):
        assert scheduler._claim_scheduler_singleton_lock() is True
