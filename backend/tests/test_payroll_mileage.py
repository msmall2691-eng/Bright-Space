"""Pre-calculated drive mileage (GET /api/payroll/mileage).

Chains a cleaner's scheduled jobs per day (home → first job → between houses →
back home) with per-leg distances. These tests run with NO Google key, so every
distance is the haversine straight-line × 1.3 road-factor fallback and every
leg is flagged estimated — the honest degraded mode. Coordinates are pre-cached
on the rows (as the lazy geocoder would have done), so no network is involved.

Display/report only: nothing here touches gross pay — that stays on the miles
crew enter at clock-out (see test_payroll_native.py).
"""
import uuid
from datetime import date, time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, User, Org
from modules.auth.router import get_current_user, current_org_id
from services.geocoding import haversine_miles, ROAD_FACTOR


class _Admin:
    id, org_id, role, status, active = 9301, 1, "admin", "active", True
    email = "mileage-admin@example.com"
    cleaner_id = None


class _Cleaner:
    id, org_id, role, status, active = 9302, 1, "cleaner", "active", True
    email = "mileage-cleaner@example.com"
    cleaner_id = "mi-crew"


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture(autouse=True)
def _no_google_key(monkeypatch):
    monkeypatch.delenv("GOOGLE_PLACES_API_KEY", raising=False)


def _mk_cleaner(ids, cleaner_id, home_address=None, home_lat=None, home_lng=None,
                name="Mileage Crew", org_id=1):
    db = SessionLocal()
    u = User(email=f"mi-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name=name, org_id=org_id, active=True, status="active",
             cleaner_id=cleaner_id, home_address=home_address,
             home_lat=home_lat, home_lng=home_lng)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id); uid = u.id; db.close()
    return uid


def _mk_job(ids, cleaner_id, d, start, prop_name, lat=None, lng=None, org_id=1):
    db = SessionLocal()
    if org_id != 1 and not db.query(Org).filter(Org.id == org_id).first():
        db.add(Org(id=org_id, name=f"Other {org_id}", slug=f"other-{org_id}"))
        db.commit()
    c = Client(name=f"Mi {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=prop_name, address=prop_name,
                 property_type="residential", org_id=org_id, lat=lat, lng=lng)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=prop_name,
            scheduled_date=d, start_time=start, status="scheduled",
            cleaner_ids=[cleaner_id], org_id=org_id)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _api(user=_Admin):
    app.dependency_overrides[get_current_user] = lambda: user()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _report(api, start, end, cid):
    r = api.get(f"/api/payroll/mileage?start_date={start}&end_date={end}&cleaner_id={cid}")
    assert r.status_code == 200, r.text
    return r.json()


def _est(a, b):
    """Expected fallback miles for one leg: haversine × road factor."""
    return round(haversine_miles(a, b) * ROAD_FACTOR, 1)


HOME = (44.0, -70.0)
PROP_A = (44.1, -70.0)   # 0.1° lat north of home ≈ 6.9 straight-line miles
PROP_B = (44.2, -70.0)


def test_haversine_known_pairs():
    # One degree of longitude at 44°N ≈ 69.09 mi × cos(44°) ≈ 49.7 mi.
    assert haversine_miles((44.0, -70.0), (44.0, -71.0)) == pytest.approx(49.7, abs=0.3)
    # One degree of latitude ≈ 69.09 mi anywhere.
    assert haversine_miles((44.0, -70.0), (45.0, -70.0)) == pytest.approx(69.1, abs=0.3)
    assert haversine_miles((44.0, -70.0), (44.0, -70.0)) == 0.0


def test_chain_orders_by_start_time_with_home_and_return_legs(ids):
    cid = f"mi-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, home_address="1 Home Rd", home_lat=HOME[0], home_lng=HOME[1])
    d = date(2026, 3, 10)
    # Created OUT of visit order — the later job first — to prove ordering
    # comes from start_time, not insertion/id order.
    _mk_job(ids, cid, d, time(12, 0), "B Farmhouse", *PROP_B)
    _mk_job(ids, cid, d, time(9, 0), "A Cottage", *PROP_A)
    api = _api()
    try:
        body = _report(api, "2026-03-10", "2026-03-10", cid)
        c = body["cleaners"][0]
        assert c["has_home"] is True
        legs = c["days"][0]["legs"]
        assert [(l["from"], l["to"]) for l in legs] == [
            ("Home", "A Cottage"), ("A Cottage", "B Farmhouse"), ("B Farmhouse", "Home"),
        ]
        assert [l["kind"] for l in legs] == ["from_home", "between", "return_home"]
        # No key → every leg is the labeled straight-line × 1.3 estimate.
        assert body["method"] == "estimated"
        assert all(l["estimated"] for l in legs)
        assert legs[0]["miles"] == _est(HOME, PROP_A)
        assert legs[1]["miles"] == _est(PROP_A, PROP_B)
        assert legs[2]["miles"] == _est(PROP_B, HOME)
        # The return leg is included in the total but reported separately.
        assert c["return_miles"] == legs[2]["miles"]
        assert c["work_miles"] == pytest.approx(legs[0]["miles"] + legs[1]["miles"], abs=0.11)
        assert c["total_miles"] == pytest.approx(sum(l["miles"] for l in legs), abs=0.11)
        assert c["estimated"] is True
    finally:
        _clear()


def test_missing_home_address_still_computes_between_houses(ids):
    cid = f"mi-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, home_address=None, name="No Home On File")
    d = date(2026, 3, 11)
    _mk_job(ids, cid, d, time(9, 0), "A Cottage", *PROP_A)
    _mk_job(ids, cid, d, time(12, 0), "B Farmhouse", *PROP_B)
    api = _api()
    try:
        body = _report(api, "2026-03-11", "2026-03-11", cid)
        c = body["cleaners"][0]
        assert c["has_home"] is False
        legs = c["days"][0]["legs"]
        # No home legs — just the between-houses drive.
        assert [(l["from"], l["to"], l["kind"]) for l in legs] == [
            ("A Cottage", "B Farmhouse", "between"),
        ]
        assert c["return_miles"] == 0.0
        assert c["total_miles"] == _est(PROP_A, PROP_B)
        # And the office is told why, by name.
        assert any("No Home On File" in n for n in body["notes"])
    finally:
        _clear()


def test_ungeocoded_stop_is_skipped_and_flagged(ids):
    cid = f"mi-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, home_address="1 Home Rd", home_lat=HOME[0], home_lng=HOME[1])
    d = date(2026, 3, 12)
    _mk_job(ids, cid, d, time(9, 0), "A Cottage", *PROP_A)
    # No coords and no key → the geocoder can't fill them; the stop is skipped.
    _mk_job(ids, cid, d, time(12, 0), "Mystery House")
    api = _api()
    try:
        body = _report(api, "2026-03-12", "2026-03-12", cid)
        c = body["cleaners"][0]
        assert c["unknown_stops"] == 1
        legs = c["days"][0]["legs"]
        # Only the legs with both endpoints known survive.
        assert all("Mystery House" not in (l["from"], l["to"]) for l in legs)
        assert ("Home", "A Cottage") in [(l["from"], l["to"]) for l in legs]
    finally:
        _clear()


def test_other_orgs_jobs_never_enter_the_chain(ids):
    cid = f"mi-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, home_address="1 Home Rd", home_lat=HOME[0], home_lng=HOME[1])
    d = date(2026, 3, 13)
    _mk_job(ids, cid, d, time(9, 0), "A Cottage", *PROP_A)
    # Same crew ID, same day — different org. Must not appear as a stop.
    _mk_job(ids, cid, d, time(12, 0), "Other Org House", *PROP_B, org_id=2)
    api = _api()
    try:
        body = _report(api, "2026-03-13", "2026-03-13", cid)
        c = body["cleaners"][0]
        assert c["days"][0]["stops"] == 1
        labels = [l["from"] for l in c["days"][0]["legs"]] + [l["to"] for l in c["days"][0]["legs"]]
        assert "Other Org House" not in labels
    finally:
        _clear()


def test_cancelled_jobs_and_role_gate(ids):
    cid = f"mi-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, home_address="1 Home Rd", home_lat=HOME[0], home_lng=HOME[1])
    d = date(2026, 3, 14)
    _mk_job(ids, cid, d, time(9, 0), "A Cottage", *PROP_A)
    jid = _mk_job(ids, cid, d, time(12, 0), "B Farmhouse", *PROP_B)
    db = SessionLocal()
    db.query(Job).filter(Job.id == jid).update({"status": "cancelled"})
    db.commit(); db.close()
    api = _api()
    try:
        body = _report(api, "2026-03-14", "2026-03-14", cid)
        assert body["cleaners"][0]["days"][0]["stops"] == 1  # cancelled stop dropped
    finally:
        _clear()
    # Office-only: a cleaner login can't pull the mileage report (it maps
    # everyone's day, not just their own).
    api = _api(_Cleaner)
    try:
        r = api.get("/api/payroll/mileage")
        assert r.status_code == 403
    finally:
        _clear()
