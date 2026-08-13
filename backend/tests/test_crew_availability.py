"""Crew weekly availability (cleaner_availability, crew app Phase 4).

Owner decision #3 under test: per-day AM/PM/Off, and it's a SIGNAL — the
office endpoint reports "usually_off", it never blocks an assignment. Also:
input is clamped, not validated (a phone must not be able to save a broken
week); real time-off always outranks the weekly pattern; a cleaner whose
pattern covers the requested window stays absent from the payload (= free).
"""
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import CleanerAvailability, CleanerTimeOff
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = f"Cleaner {uid}"
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9970, 1, "admin", "active", True
    email = "admin@example.com"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _next_friday():
    d = business_today() + timedelta(days=1)
    while d.weekday() != 4:   # Friday
        d += timedelta(days=1)
    return d


@pytest.fixture
def cid():
    cid = f"CT-av-{uuid.uuid4().hex[:6]}"
    yield cid
    db = SessionLocal()
    db.query(CleanerAvailability).filter(CleanerAvailability.cleaner_id == cid).delete(synchronize_session=False)
    db.query(CleanerTimeOff).filter(CleanerTimeOff.cleaner_id == cid).delete(synchronize_session=False)
    db.commit(); db.close()


def test_put_normalizes_and_roundtrips(cid):
    try:
        api = _as(_Cleaner(9971, cid))
        assert api.get("/api/crew/me/availability").json()["week"] is None  # never set

        r = api.put("/api/crew/me/availability", json={"week": {
            "mon": ["AM ", "pm", "night"],   # case/space clamped, unknown dropped
            "fri": [],
            "funday": ["am"],                # unknown day dropped
        }})
        assert r.status_code == 200
        week = r.json()["week"]
        assert week["mon"] == ["am", "pm"]
        assert week["fri"] == []
        assert week["tue"] == []             # absent days filled as off
        assert "funday" not in week

        assert _as(_Cleaner(9971, cid)).get("/api/crew/me/availability").json()["week"] == week
    finally:
        _clear()


def test_usually_off_signal_windows(cid):
    fri = _next_friday().isoformat()
    try:
        api = _as(_Cleaner(9972, cid))
        # Friday mornings only.
        api.put("/api/crew/me/availability", json={"week": {"fri": ["am"]}})
        _clear()

        office = _as(_Admin())
        by_cid = lambda rows: {r["cleaner_id"]: r for r in rows}

        # Afternoon window → usually off.
        rows = by_cid(office.get(f"/api/jobs/cleaner-availability?date={fri}&start=13:00&end=15:00").json())
        row = rows.get(cid)
        assert row and row["status"] == "usually_off"
        assert "afternoons" in row["detail"]

        # Morning window → covered by their pattern → absent (free).
        rows = by_cid(office.get(f"/api/jobs/cleaner-availability?date={fri}&start=09:00&end=11:00").json())
        assert cid not in rows

        # No window (day-level, the dispatch board's call) → partially
        # available, so NOT flagged.
        rows = by_cid(office.get(f"/api/jobs/cleaner-availability?date={fri}").json())
        assert cid not in rows
    finally:
        _clear()


def test_time_off_outranks_weekly_pattern(cid):
    fri = _next_friday()
    db = SessionLocal()
    db.add(CleanerTimeOff(org_id=1, cleaner_id=cid, start_date=fri, end_date=fri, reason="vacation"))
    db.add(CleanerAvailability(org_id=1, cleaner_id=cid, week={"fri": []}))
    db.commit(); db.close()
    try:
        office = _as(_Admin())
        rows = {r["cleaner_id"]: r for r in
                office.get(f"/api/jobs/cleaner-availability?date={fri.isoformat()}").json()}
        assert rows[cid]["status"] == "off"          # real time off wins
        assert "vacation" in rows[cid]["detail"]
    finally:
        _clear()


def test_office_cannot_write_crew_availability():
    try:
        office = _as(_Admin())
        assert office.put("/api/crew/me/availability", json={"week": {}}).status_code == 403
        assert office.get("/api/crew/me/availability").status_code == 403
    finally:
        _clear()
