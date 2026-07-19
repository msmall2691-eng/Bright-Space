"""Tests for Connecteam auto-dispatch (Pillar 2).

Hermetic: the Connecteam HTTP layer and the integration-event logger are
monkeypatched, so these exercise the orchestration logic with no network or DB.
"""
from datetime import time as _time
from types import SimpleNamespace

import pytest

import integrations.connecteam_auto as ca


class FakeDB:
    """Minimal stand-in: auto-dispatch only calls commit()/refresh()."""
    def __init__(self):
        self.commits = 0
    def commit(self):
        self.commits += 1
    def refresh(self, _obj):
        pass


def _job(**over):
    base = dict(
        id=1, status="scheduled", title="Turnover", job_type="residential",
        scheduled_date="2026-06-20", start_time="09:00", end_time="11:00",
        address="1 Main St", notes=None,
        cleaner_ids=["emp_a", "emp_b"], connecteam_shift_ids=[], dispatched=False,
    )
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def _capture_logs(monkeypatch):
    logs = []
    monkeypatch.setattr(ca, "_log", lambda *a, **k: logs.append(k))
    return logs


def test_not_configured_is_a_clean_noop(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: False)
    job = _job()
    out = ca.auto_dispatch_job(FakeDB(), job)
    assert out["dispatched"] is False and out["reason"] == "not_configured"
    assert job.connecteam_shift_ids == []


def test_unassigned_regular_job_pushes_one_open_draft(monkeypatch, _capture_logs):
    """A regular job with no cleaner yet now goes out as a single OPEN draft
    shift (not a no-op), so the slot still shows on the Connecteam schedule."""
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    calls = []
    monkeypatch.setattr(ca, "create_open_shift_sync",
                        lambda **kw: (calls.append(kw), {"id": "open_1"})[1])
    monkeypatch.setattr(ca, "create_shift_sync",
                        lambda **k: pytest.fail("should not create an assigned shift"))
    job = _job(cleaner_ids=[])
    out = ca.auto_dispatch_job(FakeDB(), job)
    assert out["dispatched"] is True and out["count"] == 1
    assert job.connecteam_shift_ids == ["open_1"]
    assert calls[0]["is_published"] is False  # DRAFT


def test_str_turnover_pushes_open_draft_even_with_cleaners(monkeypatch):
    """Airbnb/STR turnovers always go out as OPEN drafts, regardless of any
    auto-assigned cleaner."""
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    calls = []
    monkeypatch.setattr(ca, "create_open_shift_sync",
                        lambda **kw: (calls.append(kw), {"id": "open_str"})[1])
    monkeypatch.setattr(ca, "create_shift_sync",
                        lambda **k: pytest.fail("turnover must not create assigned shifts"))
    job = _job(job_type="str_turnover", cleaner_ids=["emp_a"])
    out = ca.auto_dispatch_job(FakeDB(), job)
    assert out["dispatched"] is True and job.connecteam_shift_ids == ["open_str"]
    assert calls[0]["is_published"] is False


def test_shift_times_normalizes_strings_and_time_objects():
    # "HH:MM" string, as it arrives fresh off the API request
    assert ca._shift_times(_job(start_time="09:00", end_time="11:00")) == (
        "2026-06-20T09:00:00", "2026-06-20T11:00:00")
    # datetime.time, as it arrives after the row is read/refreshed from the DB
    # (the recurring generator's path) — must NOT become "09:00:00:00"
    assert ca._shift_times(_job(start_time=_time(9, 0), end_time=_time(11, 30))) == (
        "2026-06-20T09:00:00", "2026-06-20T11:30:00")


def test_open_draft_produces_valid_iso_for_time_objects(monkeypatch):
    """Regression (Codex P2): a turnover whose times are datetime.time (as in
    the recurring path after a refresh) still yields a valid ISO datetime."""
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    calls = []
    monkeypatch.setattr(ca, "create_open_shift_sync",
                        lambda **kw: (calls.append(kw), {"id": "open_t"})[1])
    job = _job(job_type="str_turnover", cleaner_ids=[],
               start_time=_time(9, 0), end_time=_time(11, 0))
    out = ca.auto_dispatch_job(FakeDB(), job)
    assert out["dispatched"] is True
    assert calls[0]["start_datetime"] == "2026-06-20T09:00:00"
    assert calls[0]["end_datetime"] == "2026-06-20T11:00:00"


def test_missing_times_is_non_dispatchable(monkeypatch):
    """A job with NULL start/end time must be skipped, not pushed as a midnight
    shift (Codex P1) — those rows get repaired then dispatch later."""
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "create_open_shift_sync",
                        lambda **k: pytest.fail("must not push a midnight shift"))
    monkeypatch.setattr(ca, "create_shift_sync",
                        lambda **k: pytest.fail("must not push a midnight shift"))
    out = ca.auto_dispatch_job(FakeDB(), _job(start_time=None, end_time=None))
    assert out["reason"] == "missing_times" and out["dispatched"] is False
    # ...and the same for a turnover (open-shift path).
    out2 = ca.auto_dispatch_job(FakeDB(), _job(job_type="str_turnover", cleaner_ids=[], end_time=None))
    assert out2["reason"] == "missing_times" and out2["dispatched"] is False


def test_cancelled_job_not_dispatched(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    out = ca.auto_dispatch_job(FakeDB(), _job(status="cancelled"))
    assert out["reason"] == "inactive_status"


def test_dispatch_creates_one_shift_per_cleaner(monkeypatch, _capture_logs):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    calls = []
    def fake_create(**kw):
        calls.append(kw)
        return {"id": f"shift_{kw['employee_id']}"}
    monkeypatch.setattr(ca, "create_shift_sync", fake_create)

    job = _job()
    out = ca.auto_dispatch_job(FakeDB(), job)

    assert out["dispatched"] is True and out["count"] == 2
    assert job.connecteam_shift_ids == ["shift_emp_a", "shift_emp_b"]
    assert job.dispatched is True
    # ISO datetimes assembled from date + HH:MM
    assert calls[0]["start_datetime"] == "2026-06-20T09:00:00"
    assert calls[0]["end_datetime"] == "2026-06-20T11:00:00"
    # pushed as DRAFTs, not published live
    assert calls[0]["is_published"] is False and calls[1]["is_published"] is False
    # one ok log per shift
    assert sum(1 for k in _capture_logs if k.get("status") == "ok") == 2


def test_already_dispatched_does_not_duplicate(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "create_shift_sync", lambda **k: pytest.fail("should not create"))
    out = ca.auto_dispatch_job(FakeDB(), _job(connecteam_shift_ids=["x"]))
    assert out["reason"] == "already_dispatched"


def test_partial_failure_records_errors(monkeypatch, _capture_logs):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    def fake_create(**kw):
        if kw["employee_id"] == "emp_b":
            raise RuntimeError("boom")
        return {"id": "shift_a"}
    monkeypatch.setattr(ca, "create_shift_sync", fake_create)

    job = _job()
    out = ca.auto_dispatch_job(FakeDB(), job)
    assert job.connecteam_shift_ids == ["shift_a"]
    assert out["dispatched"] is True  # one succeeded
    assert len(out["errors"]) == 1 and out["errors"][0]["employee_id"] == "emp_b"


def test_remove_deletes_all_and_clears(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    deleted = []
    monkeypatch.setattr(ca, "delete_shift_sync", lambda sid: deleted.append(sid))
    job = _job(connecteam_shift_ids=["s1", "s2"], dispatched=True)
    out = ca.remove_job_from_connecteam(FakeDB(), job)
    assert deleted == ["s1", "s2"]
    assert job.connecteam_shift_ids == [] and job.dispatched is False
    assert out["removed"] is True


def test_remove_keeps_failed_shifts_to_retry(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    def fake_delete(sid):
        if sid == "s2":
            raise RuntimeError("still there")
    monkeypatch.setattr(ca, "delete_shift_sync", fake_delete)
    job = _job(connecteam_shift_ids=["s1", "s2"], dispatched=True)
    out = ca.remove_job_from_connecteam(FakeDB(), job)
    assert job.connecteam_shift_ids == ["s2"]  # the failed one is kept
    assert job.dispatched is True
    assert out["removed"] is False and len(out["errors"]) == 1


def test_resync_replaces_shifts(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "delete_shift_sync", lambda sid: None)
    monkeypatch.setattr(ca, "create_shift_sync", lambda **k: {"id": f"new_{k['employee_id']}"})
    job = _job(connecteam_shift_ids=["old1", "old2"], dispatched=True)
    out = ca.resync_job(FakeDB(), job)
    assert job.connecteam_shift_ids == ["new_emp_a", "new_emp_b"]
    assert out["dispatched"] is True


def test_dispatch_stamps_synced_schedule_snapshot(monkeypatch):
    """auto_dispatch_job must record what it just pushed so drift-detection
    has a baseline to compare against later."""
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "create_shift_sync", lambda **k: {"id": f"shift_{k['employee_id']}"})
    job = _job()
    ca.auto_dispatch_job(FakeDB(), job)
    assert job.connecteam_synced_schedule == {
        "scheduled_date": "2026-06-20", "start_time": "09:00", "end_time": "11:00",
    }


# ---------------------------------------------------------------------------
# reconcile_connecteam_drift — the reconcile-sweep drift repair (audit #2, #4)
# ---------------------------------------------------------------------------

def _synced_job(**over):
    """A job that already has a live Connecteam shift, with a matching
    synced-schedule baseline unless overridden."""
    base = _job(connecteam_shift_ids=["shift_1"], dispatched=True,
                connecteam_synced_schedule={
                    "scheduled_date": "2026-06-20", "start_time": "09:00", "end_time": "11:00",
                })
    for k, v in over.items():
        setattr(base, k, v)
    return base


def test_reconcile_drift_skips_jobs_with_no_shifts(monkeypatch):
    monkeypatch.setattr(ca, "resync_job", lambda *a, **k: pytest.fail("should not resync"))
    monkeypatch.setattr(ca, "remove_job_from_connecteam", lambda *a, **k: pytest.fail("should not remove"))
    job = _job(connecteam_shift_ids=[])
    out = ca.reconcile_connecteam_drift(FakeDB(), [job])
    assert out == {"resynced": 0, "removed": 0, "errors": []}


def test_reconcile_drift_removes_shifts_from_cancelled_job(monkeypatch):
    job = _synced_job(status="cancelled")
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "delete_shift_sync", lambda sid: None)

    out = ca.reconcile_connecteam_drift(FakeDB(), [job])

    assert out["removed"] == 1 and out["resynced"] == 0
    assert job.connecteam_shift_ids == []
    assert job.connecteam_synced_schedule is None


def test_reconcile_drift_resyncs_job_with_time_drift(monkeypatch):
    # Job's actual time (11:00-13:00) no longer matches what was pushed (09:00-11:00).
    job = _synced_job(start_time="11:00", end_time="13:00")
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    monkeypatch.setattr(ca, "delete_shift_sync", lambda sid: None)
    monkeypatch.setattr(ca, "create_shift_sync", lambda **k: {"id": f"new_{k['employee_id']}"})

    out = ca.reconcile_connecteam_drift(FakeDB(), [job])

    assert out["resynced"] == 1 and out["removed"] == 0
    assert job.connecteam_shift_ids == ["new_emp_a", "new_emp_b"]
    assert job.connecteam_synced_schedule == {
        "scheduled_date": "2026-06-20", "start_time": "11:00", "end_time": "13:00",
    }


def test_reconcile_drift_no_op_when_schedule_matches(monkeypatch):
    job = _synced_job()  # synced_schedule already matches current schedule
    monkeypatch.setattr(ca, "resync_job", lambda *a, **k: pytest.fail("should not resync"))
    monkeypatch.setattr(ca, "remove_job_from_connecteam", lambda *a, **k: pytest.fail("should not remove"))

    out = ca.reconcile_connecteam_drift(FakeDB(), [job])
    assert out == {"resynced": 0, "removed": 0, "errors": []}


def test_reconcile_drift_no_op_without_a_synced_baseline(monkeypatch):
    """A job with shift ids but no recorded synced_schedule (legacy data from
    before this snapshot existed) has no baseline to compare against — must
    not be treated as drifted just because the field is empty."""
    job = _job(connecteam_shift_ids=["shift_1"], dispatched=True,
               connecteam_synced_schedule=None)
    monkeypatch.setattr(ca, "resync_job", lambda *a, **k: pytest.fail("should not resync"))

    out = ca.reconcile_connecteam_drift(FakeDB(), [job])
    assert out == {"resynced": 0, "removed": 0, "errors": []}
