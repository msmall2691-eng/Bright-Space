"""Tests for Connecteam auto-dispatch (Pillar 2).

Hermetic: the Connecteam HTTP layer and the integration-event logger are
monkeypatched, so these exercise the orchestration logic with no network or DB.
"""
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
        id=1, status="scheduled", title="Turnover",
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


def test_no_cleaners_is_a_clean_noop(monkeypatch):
    monkeypatch.setattr(ca, "is_configured", lambda: True)
    out = ca.auto_dispatch_job(FakeDB(), _job(cleaner_ids=[]))
    assert out["reason"] == "no_cleaners" and out["dispatched"] is False


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
