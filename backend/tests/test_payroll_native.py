"""Native payroll source (flag-gated) + per-cleaner pay rates.

When payroll_source='native', GET /api/payroll/summary computes the same
breakdown shape from the native time clock (time_entries) instead of Connecteam
— classification by each punch's linked job, per-cleaner rate overrides, weekend
turnover piece-rate. Default stays 'connecteam' and is restored after each test.

These tests never exercise the Connecteam path (that needs live Connecteam), so
they're hermetic. Fixed 2026 dates keep weekday/weekend deterministic:
2026-01-05 is a Monday, 2026-01-03 is a Saturday.
"""
import uuid
from datetime import datetime, date

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, User, TimeEntry
from modules.auth.router import get_current_user, current_org_id
from modules.settings.router import set_setting


class _Admin:
    id, org_id, role, status, active = 9201, 1, "admin", "active", True
    email = "pay-admin@example.com"
    cleaner_id = None


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "entries": [], "users": []}
    yield ids
    db = SessionLocal()
    db.query(TimeEntry).filter(TimeEntry.id.in_(ids["entries"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    # Always restore the default source so other tests see Connecteam.
    set_setting(db, "payroll_source", "connecteam")
    db.commit(); db.close()


def _dt(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm)  # naive UTC, as the clock stores


def _mk_cleaner(ids, cleaner_id, res_rate=None, rental_rate=None, name="Crew Person"):
    db = SessionLocal()
    u = User(email=f"crew-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name=name, org_id=1, active=True, status="active",
             cleaner_id=cleaner_id, pay_rate_residential=res_rate, pay_rate_rental=rental_rate)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id); uid = u.id; db.close()
    return uid


def _mk_job(ids, job_type="residential", turnover_rate=None):
    db = SessionLocal()
    c = Client(name=f"Pay {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name="1 Pay St", address="1 Pay St",
                 property_type=("str" if job_type == "str_turnover" else "residential"),
                 org_id=1, turnover_rate=turnover_rate)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type=job_type, title="Job",
            scheduled_date=date(2026, 1, 5), status="scheduled", cleaner_ids=[], org_id=1)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _mk_entry(ids, cleaner_id, clock_in, clock_out, job_id=None, break_min=0):
    db = SessionLocal()
    e = TimeEntry(org_id=1, cleaner_id=cleaner_id, job_id=job_id,
                  clock_in_at=clock_in, clock_out_at=clock_out, break_minutes=break_min, source="native")
    db.add(e); db.commit(); db.refresh(e)
    ids["entries"].append(e.id); eid = e.id; db.close()
    return eid


def _admin_api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _summary(api, start, end):
    r = api.get(f"/api/payroll/summary?start_date={start}&end_date={end}")
    assert r.status_code == 200, r.text
    return r.json()


def _emp(body, cleaner_id):
    return next((e for e in body["employees"] if str(e["employee_id"]) == str(cleaner_id)), None)


def test_source_defaults_to_connecteam_and_validates():
    api = _admin_api()
    try:
        assert api.get("/api/payroll/source").json()["source"] == "connecteam"
        assert api.put("/api/payroll/source", json={"source": "nonsense"}).status_code == 422
        assert api.put("/api/payroll/source", json={"source": "native"}).json()["source"] == "native"
    finally:
        # reset (no `ids` fixture here)
        db = SessionLocal(); set_setting(db, "payroll_source", "connecteam"); db.commit(); db.close()
        _clear()


def test_native_residential_hours_and_gross(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, name="Jane")
    jid = _mk_job(ids, "residential")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 14), _dt(2026, 1, 5, 17), job_id=jid)  # 3h, Monday
    api = _admin_api()
    try:
        api.put("/api/payroll/source", json={"source": "native"})
        body = _summary(api, "2026-01-05", "2026-01-05")
        assert body["source"] == "native"
        emp = _emp(body, cid)
        assert emp is not None and emp["hours_source"] == "native"
        assert emp["residential_hours"] == 3.0
        assert emp["residential_pay"] == round(3.0 * body["rates"]["residential_rate"], 2)
        assert emp["gross_pay"] == emp["residential_pay"]      # no mileage natively
        assert emp["mileage_reimbursement"] == 0.0
    finally:
        _clear()


def test_native_per_cleaner_rate_override(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, res_rate=40.0)   # override the shop default
    jid = _mk_job(ids, "residential")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)  # 2h
    api = _admin_api()
    try:
        api.put("/api/payroll/source", json={"source": "native"})
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["residential_hours"] == 2.0
        assert emp["residential_pay"] == 80.0   # 2h * $40 override, not the global rate
    finally:
        _clear()


def test_native_unlinked_punch_is_unclassified_and_unpaid(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=None)  # no job link
    api = _admin_api()
    try:
        api.put("/api/payroll/source", json={"source": "native"})
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["unclassified_hours"] == 2.0
        assert emp["residential_hours"] == 0.0
        assert emp["gross_pay"] == 0.0
    finally:
        _clear()


def test_native_weekend_turnover_piece_rate(ids):
    assert date(2026, 1, 3).weekday() >= 5   # sanity: Saturday
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "str_turnover", turnover_rate=90.0)
    _mk_entry(ids, cid, _dt(2026, 1, 3, 14), _dt(2026, 1, 3, 17), job_id=jid)  # Saturday
    api = _admin_api()
    try:
        api.put("/api/payroll/source", json={"source": "native"})
        emp = _emp(_summary(api, "2026-01-03", "2026-01-03"), cid)
        assert emp["weekend_turnovers"] == 1
        assert emp["weekend_pay"] == 90.0
        assert emp["gross_pay"] == 90.0        # piece rate, not hourly
        assert emp["rental_weekday_hours"] == 0.0
    finally:
        _clear()


def test_native_weekday_rental_is_hourly(ids):
    assert date(2026, 1, 5).weekday() < 5     # sanity: Monday
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, rental_rate=30.0)
    jid = _mk_job(ids, "str_turnover", turnover_rate=90.0)
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 12), job_id=jid)  # Monday, 3h
    api = _admin_api()
    try:
        api.put("/api/payroll/source", json={"source": "native"})
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["rental_weekday_hours"] == 3.0
        assert emp["rental_weekday_pay"] == 90.0   # 3h * $30, weekday → hourly not piece
        assert emp["weekend_turnovers"] == 0
    finally:
        _clear()


def test_admin_can_set_and_clear_pay_rates(ids):
    uid = _mk_cleaner(ids, f"CT-{uuid.uuid4().hex[:6]}")
    api = _admin_api()
    try:
        r = api.patch(f"/api/auth/users/{uid}", json={"pay_rate_residential": 30, "pay_rate_rental": 32})
        assert r.status_code == 200
        assert r.json()["pay_rate_residential"] == 30 and r.json()["pay_rate_rental"] == 32

        # Explicit null clears just that field; the omitted one is untouched.
        r2 = api.patch(f"/api/auth/users/{uid}", json={"pay_rate_residential": None})
        assert r2.status_code == 200
        assert r2.json()["pay_rate_residential"] is None
        assert r2.json()["pay_rate_rental"] == 32

        assert api.patch(f"/api/auth/users/{uid}", json={"pay_rate_rental": -5}).status_code == 422
    finally:
        _clear()
