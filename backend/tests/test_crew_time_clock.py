"""Native crew time clock (Phase 2a): POST /api/crew/clock-in, /clock-out, and
the clock status folded into /api/crew/my-day.

Punches land in the `time_entries` table and are scoped to the caller's crew ID
and org. Native payroll reads these punches."""
import uuid
from datetime import datetime, time as dtime, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, TimeEntry
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today, business_tz


class _Cleaner:
    def __init__(self, uid, cleaner_id, org_id=1):
        self.id, self.org_id, self.role, self.status, self.active = uid, org_id, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.cleaner_id = cleaner_id


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "entries": []}
    yield ids
    db = SessionLocal()
    db.query(TimeEntry).filter(TimeEntry.id.in_(ids["entries"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _crew_id():
    # Unique per test so `hours_today` is deterministic in the shared DB.
    return f"CT-{uuid.uuid4().hex[:8]}"


def _today_utc(hour_local, minute=0):
    """A naive-UTC timestamp for HH:MM in the business timezone, today."""
    local = datetime.combine(business_today(), dtime(hour_local, minute), tzinfo=business_tz())
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def _mk_entry(ids, cleaner_id, in_dt, out_dt=None, break_min=0, org_id=1, job_id=None):
    db = SessionLocal()
    e = TimeEntry(org_id=org_id, cleaner_id=cleaner_id, job_id=job_id,
                  clock_in_at=in_dt, clock_out_at=out_dt, break_minutes=break_min, source="native")
    db.add(e); db.commit(); db.refresh(e)
    ids["entries"].append(e.id); eid = e.id; db.close()
    return eid


def _mk_job(ids, cleaner_id):
    db = SessionLocal()
    c = Client(name=f"Crew {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name="1 Test St", address="1 Test St",
                 property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Clean",
            scheduled_date=business_today(), cleaner_ids=[cleaner_id], status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _override(cleaner):
    app.dependency_overrides[get_current_user] = lambda: cleaner
    app.dependency_overrides[current_org_id] = lambda: cleaner.org_id


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_clock_in_then_out_round_trip(ids):
    _override(_Cleaner(9101, _crew_id()))
    api = TestClient(app)
    try:
        r = api.post("/api/crew/clock-in", json={})
        assert r.status_code == 200
        e = r.json()
        ids["entries"].append(e["id"])
        assert e["open"] is True and e["clock_out_at"] is None and e["hours"] is None

        r2 = api.post("/api/crew/clock-out", json={})
        assert r2.status_code == 200
        e2 = r2.json()
        assert e2["open"] is False and e2["clock_out_at"] is not None
        assert e2["hours"] is not None and e2["hours"] >= 0
    finally:
        _clear()


def test_double_clock_in_conflicts(ids):
    _override(_Cleaner(9102, _crew_id()))
    api = TestClient(app)
    try:
        r = api.post("/api/crew/clock-in", json={})
        assert r.status_code == 200
        ids["entries"].append(r.json()["id"])
        assert api.post("/api/crew/clock-in", json={}).status_code == 409
    finally:
        _clear()


def test_clock_out_without_clock_in():
    _override(_Cleaner(9103, _crew_id()))
    api = TestClient(app)
    try:
        r = api.post("/api/crew/clock-out", json={})
        assert r.status_code == 400
        assert "not clocked in" in r.json()["detail"].lower()
    finally:
        _clear()


def test_clock_requires_linked_crew_id():
    _override(_Cleaner(9104, None))
    api = TestClient(app)
    try:
        assert api.post("/api/crew/clock-in", json={}).status_code == 400
        assert api.post("/api/crew/clock-out", json={}).status_code == 400
    finally:
        _clear()


def test_non_cleaner_cannot_clock_in():
    class _Admin:
        id, org_id, role, status, active = 9108, 1, "admin", "active", True
        email = "admin@example.com"
        cleaner_id = None
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        assert api.post("/api/crew/clock-in", json={}).status_code == 403
    finally:
        _clear()


def test_my_day_surfaces_hours_and_break_math(ids):
    cid = _crew_id()
    # A completed 8:00–11:00 punch with a 30-min break → 2.5h.
    _mk_entry(ids, cid, _today_utc(8), _today_utc(11), break_min=30)
    _override(_Cleaner(9105, cid))
    api = TestClient(app)
    try:
        body = api.get("/api/crew/my-day").json()
        assert body["clock"]["hours_today"] == 2.5
        assert body["clock"]["active"] is None
        assert len(body["clock"]["entries_today"]) == 1
        assert body["clock"]["entries_today"][0]["hours"] == 2.5
    finally:
        _clear()


def test_my_day_shows_active_open_punch(ids):
    cid = _crew_id()
    _mk_entry(ids, cid, _today_utc(9))  # open — no clock-out
    _override(_Cleaner(9106, cid))
    api = TestClient(app)
    try:
        active = api.get("/api/crew/my-day").json()["clock"]["active"]
        assert active is not None and active["open"] is True and active["hours"] is None
    finally:
        _clear()


def test_hours_scoped_to_cleaner_and_org(ids):
    mine, other = _crew_id(), _crew_id()
    _mk_entry(ids, mine, _today_utc(8), _today_utc(11), break_min=30, org_id=1)   # counts → 2.5h
    _mk_entry(ids, other, _today_utc(8), _today_utc(11), org_id=1)                # other cleaner → excluded
    _mk_entry(ids, mine, _today_utc(8), _today_utc(11), org_id=2)                 # other org → excluded
    _override(_Cleaner(9107, mine, org_id=1))
    api = TestClient(app)
    try:
        body = api.get("/api/crew/my-day").json()
        assert body["clock"]["hours_today"] == 2.5
        assert len(body["clock"]["entries_today"]) == 1
    finally:
        _clear()


def test_clock_in_links_job(ids):
    cid = _crew_id()
    jid = _mk_job(ids, cid)
    _override(_Cleaner(9109, cid))
    api = TestClient(app)
    try:
        assert api.post("/api/crew/clock-in", json={"job_id": 999999}).status_code == 404
        r = api.post("/api/crew/clock-in", json={"job_id": jid})
        assert r.status_code == 200
        ids["entries"].append(r.json()["id"])
        assert r.json()["job_id"] == jid
    finally:
        _clear()


class _Admin:
    id, org_id, role, status, active = 9110, 1, "admin", "active", True
    email = "recon-admin@example.com"
    cleaner_id = None


def test_clock_in_captures_location(ids):
    _override(_Cleaner(9113, _crew_id()))
    api = TestClient(app)
    try:
        r = api.post("/api/crew/clock-in", json={"lat": 43.6591, "lng": -70.2568, "accuracy_m": 12.5})
        assert r.status_code == 200
        e = r.json()
        ids["entries"].append(e["id"])
        assert e["has_location"] is True
        assert abs(e["clock_in_lat"] - 43.6591) < 1e-6
        assert abs(e["clock_in_lng"] - (-70.2568)) < 1e-6
    finally:
        _clear()


def test_clock_in_without_location_stores_no_coords(ids):
    _override(_Cleaner(9114, _crew_id()))
    api = TestClient(app)
    try:
        r = api.post("/api/crew/clock-in", json={})
        assert r.status_code == 200
        e = r.json()
        ids["entries"].append(e["id"])
        assert e["has_location"] is False
        assert e["clock_in_lat"] is None
    finally:
        _clear()


def test_clock_in_rejects_unassigned_job(ids):
    mine = _crew_id()
    jid = _mk_job(ids, "CT-someone-else")   # job assigned to a different crew id
    _override(_Cleaner(9115, mine))
    api = TestClient(app)
    try:
        r = api.post("/api/crew/clock-in", json={"job_id": jid})
        assert r.status_code == 403
        assert "assigned" in r.json()["detail"].lower()
    finally:
        _clear()


def test_one_open_punch_enforced_at_db(ids):
    from sqlalchemy.exc import IntegrityError
    cid = _crew_id()
    _mk_entry(ids, cid, _today_utc(8))   # first open punch (clock_out NULL)
    db = SessionLocal()
    try:
        db.add(TimeEntry(org_id=1, cleaner_id=cid, clock_in_at=_today_utc(9),
                         clock_out_at=None, source="native"))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    finally:
        db.close()


def test_clock_out_records_miles(ids):
    _override(_Cleaner(9116, _crew_id()))
    api = TestClient(app)
    try:
        ids["entries"].append(api.post("/api/crew/clock-in", json={}).json()["id"])
        r = api.post("/api/crew/clock-out", json={"miles": 12.5})
        assert r.status_code == 200
        assert r.json()["miles"] == 12.5
    finally:
        _clear()


def test_clock_out_miles_clamped(ids):
    # Negative clamps to 0; an absurd fat-finger clamps to the 2000-mile ceiling.
    # Clock-out must never fail over a mileage typo, so these clamp, not 422.
    for uid, sent, expected in [(9117, -5, 0.0), (9118, 99999, 2000.0)]:
        _override(_Cleaner(uid, _crew_id()))
        api = TestClient(app)
        try:
            ids["entries"].append(api.post("/api/crew/clock-in", json={}).json()["id"])
            r = api.post("/api/crew/clock-out", json={"miles": sent})
            assert r.status_code == 200
            assert r.json()["miles"] == expected
        finally:
            _clear()


def test_clock_out_without_miles_leaves_none(ids):
    # A no-drive punch (miles omitted) stays NULL — not silently zeroed — so
    # payroll can tell "no driving" from "0 recorded".
    _override(_Cleaner(9119, _crew_id()))
    api = TestClient(app)
    try:
        ids["entries"].append(api.post("/api/crew/clock-in", json={}).json()["id"])
        r = api.post("/api/crew/clock-out", json={})
        assert r.status_code == 200
        assert r.json()["miles"] is None
    finally:
        _clear()


def test_patch_entry_miles_corrects_own_punch(ids):
    cid = _crew_id()
    eid = _mk_entry(ids, cid, _today_utc(8), _today_utc(11))   # closed, no miles
    _override(_Cleaner(9120, cid))
    api = TestClient(app)
    try:
        r = api.patch(f"/api/crew/entry/{eid}/miles", json={"miles": 8})
        assert r.status_code == 200
        assert r.json()["miles"] == 8.0
        # negative clamps to 0 on the correction path too
        assert api.patch(f"/api/crew/entry/{eid}/miles", json={"miles": -3}).json()["miles"] == 0.0
    finally:
        _clear()


def test_patch_entry_miles_scoped_to_own_cleaner(ids):
    owner = _crew_id()
    eid = _mk_entry(ids, owner, _today_utc(8), _today_utc(11))   # belongs to `owner`
    _override(_Cleaner(9121, _crew_id()))   # a DIFFERENT cleaner
    api = TestClient(app)
    try:
        assert api.patch(f"/api/crew/entry/{eid}/miles", json={"miles": 50}).status_code == 404
    finally:
        _clear()
    # and the owner's punch was untouched by the rejected edit
    db = SessionLocal()
    try:
        assert db.get(TimeEntry, eid).miles is None
    finally:
        db.close()
