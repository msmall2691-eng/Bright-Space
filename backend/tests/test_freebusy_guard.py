"""Tests for the Google Free/Busy double-booking guard (Pillar 1).

Two layers:
- free_busy_conflicts(): parses Google's freebusy response and fails OPEN.
- create_job(): blocks a booking that lands on a busy slot (409), overridable
  via allow_conflicts, and skippable via the freebusy_check setting.
"""
import pytest

import integrations.google_calendar as gcal
import modules.settings.router as settings_router
from fastapi import HTTPException
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import create_job, JobCreate


# ── free_busy_conflicts() unit tests (no network) ──

class _FakeFreeBusy:
    def __init__(self, busy):
        self._busy = busy
    def query(self, body):
        self._cal = body["items"][0]["id"]
        return self
    def execute(self):
        return {"calendars": {self._cal: {"busy": self._busy}}}


class _FakeService:
    def __init__(self, busy):
        self._busy = busy
    def freebusy(self):
        return _FakeFreeBusy(self._busy)


def test_freebusy_not_configured_returns_empty(monkeypatch):
    monkeypatch.setattr(gcal, "is_configured", lambda: False)
    assert gcal.free_busy_conflicts("residential", "2026-12-15", "09:00", "12:00") == []


def test_freebusy_parses_busy_blocks(monkeypatch):
    monkeypatch.setattr(gcal, "is_configured", lambda: True)
    blocks = [{"start": "2026-12-15T10:00:00-05:00", "end": "2026-12-15T11:00:00-05:00"}]
    monkeypatch.setattr(gcal, "_get_service", lambda: _FakeService(blocks))
    out = gcal.free_busy_conflicts("residential", "2026-12-15", "09:00", "12:00")
    assert out == blocks


def test_freebusy_empty_when_free(monkeypatch):
    monkeypatch.setattr(gcal, "is_configured", lambda: True)
    monkeypatch.setattr(gcal, "_get_service", lambda: _FakeService([]))
    assert gcal.free_busy_conflicts("residential", "2026-12-15", "09:00", "12:00") == []


def test_freebusy_end_before_start_skips(monkeypatch):
    monkeypatch.setattr(gcal, "is_configured", lambda: True)
    monkeypatch.setattr(gcal, "_get_service", lambda: pytest.fail("should not query"))
    assert gcal.free_busy_conflicts("residential", "2026-12-15", "12:00", "09:00") == []


def test_freebusy_fails_open_on_error(monkeypatch):
    monkeypatch.setattr(gcal, "is_configured", lambda: True)
    def boom():
        raise RuntimeError("google down")
    monkeypatch.setattr(gcal, "_get_service", boom)
    assert gcal.free_busy_conflicts("residential", "2026-12-15", "09:00", "12:00") == []


# ── create_job guard tests (real DB session) ──

@pytest.fixture
def bare_client():
    db = SessionLocal()
    c = Client(name="FreeBusy Test", email="fb@example.com", status="active", org_id=None)
    db.add(c); db.commit(); db.refresh(c)
    yield db, c
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit()
    db.close()


def _payload(client_id, allow_conflicts=False):
    return JobCreate(
        client_id=client_id, title="FB Clean", job_type="residential",
        scheduled_date="2026-12-16", start_time="09:00", end_time="12:00",
        allow_conflicts=allow_conflicts,
    )


def test_blocks_when_slot_busy(bare_client, monkeypatch):
    db, c = bare_client
    monkeypatch.setattr(settings_router, "freebusy_check_enabled", lambda _db: True, raising=False)
    monkeypatch.setattr(gcal, "free_busy_conflicts",
                        lambda *a, **k: [{"start": "x", "end": "y"}])
    with pytest.raises(HTTPException) as ei:
        create_job(_payload(c.id), db=db, org_id=None)
    assert ei.value.status_code == 409
    assert "already booked" in str(ei.value.detail).lower()
    assert db.query(Job).filter(Job.client_id == c.id).count() == 0


def test_allow_conflicts_bypasses_guard(bare_client, monkeypatch):
    db, c = bare_client
    monkeypatch.setattr(settings_router, "freebusy_check_enabled", lambda _db: True, raising=False)
    monkeypatch.setattr(gcal, "free_busy_conflicts",
                        lambda *a, **k: pytest.fail("guard must be skipped"))
    out = create_job(_payload(c.id, allow_conflicts=True), db=db, org_id=None)
    assert out["id"] and db.query(Job).filter(Job.client_id == c.id).count() == 1


def test_free_slot_creates(bare_client, monkeypatch):
    db, c = bare_client
    monkeypatch.setattr(settings_router, "freebusy_check_enabled", lambda _db: True, raising=False)
    monkeypatch.setattr(gcal, "free_busy_conflicts", lambda *a, **k: [])
    out = create_job(_payload(c.id), db=db, org_id=None)
    assert out["id"]


def test_disabled_setting_skips_guard(bare_client, monkeypatch):
    db, c = bare_client
    monkeypatch.setattr(settings_router, "freebusy_check_enabled", lambda _db: False, raising=False)
    monkeypatch.setattr(gcal, "free_busy_conflicts",
                        lambda *a, **k: pytest.fail("guard must be skipped when disabled"))
    out = create_job(_payload(c.id), db=db, org_id=None)
    assert out["id"]
