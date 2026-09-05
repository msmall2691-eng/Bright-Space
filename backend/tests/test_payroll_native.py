"""Native payroll (the only source — Connecteam was removed) + per-cleaner
pay rates.

GET /api/payroll/summary computes the breakdown from the native time clock
(time_entries) — classification by each punch's linked job, per-cleaner rate
overrides, per-job hourly bump, weekend turnover piece-rate.

Fixed 2026 dates keep weekday/weekend deterministic: 2026-01-05 is a Monday,
2026-01-03 is a Saturday.
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
    # Reset the shop deep rate.
    set_setting(db, "pay_rate_deep_clean", "")
    db.commit(); db.close()


def _dt(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm)  # naive UTC, as the clock stores


def _mk_cleaner(ids, cleaner_id, res_rate=None, rental_rate=None, deep_rate=None, name="Crew Person", org_id=1):
    db = SessionLocal()
    u = User(email=f"crew-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name=name, org_id=org_id, active=True, status="active",
             cleaner_id=cleaner_id, pay_rate_residential=res_rate, pay_rate_rental=rental_rate,
             pay_rate_deep=deep_rate)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id); uid = u.id; db.close()
    return uid


def _mk_job(ids, job_type="residential", turnover_rate=None, pay_mode=None,
            agreed_rate=None, cleaner_ids=None):
    db = SessionLocal()
    c = Client(name=f"Pay {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name="1 Pay St", address="1 Pay St",
                 property_type=("str" if job_type == "str_turnover" else "residential"),
                 org_id=1, turnover_rate=turnover_rate)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type=job_type, title="Job",
            scheduled_date=date(2026, 1, 5), status="scheduled",
            cleaner_ids=cleaner_ids or [], org_id=1,
            pay_mode=pay_mode, agreed_rate=agreed_rate)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _mk_entry(ids, cleaner_id, clock_in, clock_out, job_id=None, break_min=0, org_id=1, miles=None):
    db = SessionLocal()
    e = TimeEntry(org_id=org_id, cleaner_id=cleaner_id, job_id=job_id,
                  clock_in_at=clock_in, clock_out_at=clock_out, break_minutes=break_min,
                  source="native", miles=miles)
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


def test_native_residential_hours_and_gross(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, name="Jane")
    jid = _mk_job(ids, "residential")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 14), _dt(2026, 1, 5, 17), job_id=jid)  # 3h, Monday
    api = _admin_api()
    try:
        body = _summary(api, "2026-01-05", "2026-01-05")
        assert body["source"] == "native"
        emp = _emp(body, cid)
        assert emp is not None and emp["hours_source"] == "native"
        assert emp["residential_hours"] == 3.0
        assert emp["residential_pay"] == round(3.0 * body["rates"]["residential_rate"], 2)
        assert emp["gross_pay"] == emp["residential_pay"]      # no miles entered on this punch
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
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["rental_weekday_hours"] == 3.0
        assert emp["rental_weekday_pay"] == 90.0   # 3h * $30, weekday → hourly not piece
        assert emp["weekend_turnovers"] == 0
    finally:
        _clear()


def test_native_summary_is_org_scoped(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "residential")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)              # org 1, 2h → counts
    _mk_entry(ids, cid, _dt(2026, 1, 5, 12), _dt(2026, 1, 5, 15), job_id=None, org_id=2)  # org 2 → must be excluded
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["residential_hours"] == 2.0
        assert emp["unclassified_hours"] == 0.0   # the org-2 punch must not leak in
    finally:
        _clear()


def test_native_user_lookup_is_org_scoped(ids):
    # An org-2 user sharing the same crew id must not supply the name or pay-rate
    # override for org-1's payroll (cleaner_id is non-unique; users isn't RLS).
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, res_rate=40.0, name="Org1 Person", org_id=1)
    _mk_cleaner(ids, cid, res_rate=10.0, name="Org2 Person", org_id=2)
    jid = _mk_job(ids, "residential")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)  # org 1, 2h
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["name"] == "Org1 Person"
        assert emp["residential_pay"] == 80.0   # 2h * $40 (org-1), not the org-2 $10 rate
    finally:
        _clear()


def test_square_export_native_requires_square_configured(ids):
    """With Square unconfigured, the export fails with the connect-Square
    message."""
    api = _admin_api()
    try:
        r = api.post("/api/payroll/send-to-square",
                     json={"start_date": "2026-01-05", "end_date": "2026-01-05", "dry_run": True})
        assert r.status_code == 400
        assert "square isn't connected" in r.json()["detail"].lower()
    finally:
        _clear()


def test_native_mileage_reimbursed_into_gross_and_totals(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, name="Miles Driver")
    jid = _mk_job(ids, "residential")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 14), _dt(2026, 1, 5, 17), job_id=jid, miles=20)  # 3h + 20 mi
    api = _admin_api()
    try:
        body = _summary(api, "2026-01-05", "2026-01-05")
        rate = body["rates"]["mileage_rate"]
        emp = _emp(body, cid)
        assert emp["miles"] == 20.0
        assert emp["mileage_reimbursement"] == round(20 * rate, 2)
        # mileage is added ON TOP of the hourly/piece pay
        assert emp["gross_pay"] == round(emp["residential_pay"] + emp["mileage_reimbursement"], 2)
        # and it rolls up into the period totals
        assert body["totals"]["miles"] == 20.0
        assert body["totals"]["mileage_reimbursement"] == round(20 * rate, 2)
    finally:
        _clear()


def test_native_mileage_reimbursed_even_when_unclassified(ids):
    # Driving is driving: miles reimburse regardless of whether the punch's hours
    # landed in a pay bucket — same as the Connecteam path, where mileage is
    # independent of the residential/rental classification.
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=None, miles=10)  # unclassified + 10 mi
    api = _admin_api()
    try:
        body = _summary(api, "2026-01-05", "2026-01-05")
        rate = body["rates"]["mileage_rate"]
        emp = _emp(body, cid)
        assert emp["unclassified_hours"] == 2.0
        assert emp["miles"] == 10.0
        assert emp["mileage_reimbursement"] == round(10 * rate, 2)
        assert emp["gross_pay"] == round(10 * rate, 2)   # only mileage; the hours are unpaid
    finally:
        _clear()


def test_native_no_miles_is_zero_reimbursement_and_warns(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "residential")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 14), _dt(2026, 1, 5, 16), job_id=jid, miles=None)  # no miles
    api = _admin_api()
    try:
        body = _summary(api, "2026-01-05", "2026-01-05")
        emp = _emp(body, cid)
        assert emp["miles"] == 0.0
        assert emp["mileage_reimbursement"] == 0.0
        assert body["totals"]["mileage_reimbursement"] == 0.0
        # the summary flags the no-miles case so the office can chase it if needed
        assert any("no miles" in w.lower() for w in body["warnings"])
    finally:
        _clear()


def test_native_deep_clean_paid_at_deep_rate(ids):
    # A deep_clean job pays the shop deep rate in its OWN bucket, not lumped
    # into residential, and folds into gross + totals.
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "deep_clean")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 12), job_id=jid)  # Monday, 3h
    db = SessionLocal(); set_setting(db, "pay_rate_deep_clean", "40"); db.commit(); db.close()
    api = _admin_api()
    try:
        body = _summary(api, "2026-01-05", "2026-01-05")
        emp = _emp(body, cid)
        assert emp["deep_clean_hours"] == 3.0
        assert emp["deep_clean_pay"] == 120.0        # 3h * $40 deep rate
        assert emp["residential_hours"] == 0.0        # NOT counted as residential
        assert emp["gross_pay"] == 120.0
        assert body["totals"]["deep_clean_hours"] == 3.0
        assert body["totals"]["deep_clean_pay"] == 120.0
    finally:
        _clear()


def test_native_deep_clean_defaults_to_residential_rate(ids):
    # With no shop deep rate and no per-cleaner override, a deep clean pays the
    # residential rate — never LESS than a normal clean; the premium is opt-in.
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "deep_clean")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)  # 2h
    api = _admin_api()
    try:
        body = _summary(api, "2026-01-05", "2026-01-05")
        emp = _emp(body, cid)
        assert emp["deep_clean_hours"] == 2.0
        assert emp["deep_clean_pay"] == round(2.0 * body["rates"]["residential_rate"], 2)
    finally:
        _clear()


def test_native_deep_clean_per_cleaner_override(ids):
    # A per-cleaner pay_rate_deep beats the shop deep rate.
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, deep_rate=45.0)
    jid = _mk_job(ids, "deep_clean")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)  # 2h
    db = SessionLocal(); set_setting(db, "pay_rate_deep_clean", "40"); db.commit(); db.close()
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["deep_clean_pay"] == 90.0   # 2h * $45 override, not the $40 shop rate
    finally:
        _clear()


def test_native_weekend_deep_clean_is_hourly_not_piece(ids):
    # A deep clean on a weekend stays hourly at the deep rate — the weekend
    # piece-rate path is only for str_turnovers.
    assert date(2026, 1, 3).weekday() >= 5   # Saturday
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "deep_clean")
    _mk_entry(ids, cid, _dt(2026, 1, 3, 9), _dt(2026, 1, 3, 12), job_id=jid)  # Saturday, 3h
    db = SessionLocal(); set_setting(db, "pay_rate_deep_clean", "40"); db.commit(); db.close()
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-03", "2026-01-03"), cid)
        assert emp["deep_clean_hours"] == 3.0
        assert emp["deep_clean_pay"] == 120.0    # 3h * $40 hourly, NOT a piece rate
        assert emp["weekend_turnovers"] == 0
    finally:
        _clear()


def test_deep_clean_rate_setting_roundtrips():
    api = _admin_api()
    try:
        assert "deep_clean_rate" in api.get("/api/payroll/rates").json()
        r = api.put("/api/payroll/rates", json={"deep_clean_rate": 42.5})
        assert r.status_code == 200
        assert r.json()["deep_clean_rate"] == 42.5
        assert api.put("/api/payroll/rates", json={"deep_clean_rate": -1}).status_code == 422
    finally:
        db = SessionLocal(); set_setting(db, "pay_rate_deep_clean", ""); db.commit(); db.close()
        _clear()


def test_admin_can_set_deep_pay_rate(ids):
    uid = _mk_cleaner(ids, f"CT-{uuid.uuid4().hex[:6]}")
    api = _admin_api()
    try:
        r = api.patch(f"/api/auth/users/{uid}", json={"pay_rate_deep": 38})
        assert r.status_code == 200
        assert r.json()["pay_rate_deep"] == 38
        assert api.patch(f"/api/auth/users/{uid}", json={"pay_rate_deep": -5}).status_code == 422
    finally:
        _clear()


def test_native_weekend_turnover_hourly_override(ids):
    # A weekend str_turnover set to pay_mode="hourly" is paid hourly at the
    # rental rate, NOT the piece rate.
    assert date(2026, 1, 3).weekday() >= 5   # Saturday
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, rental_rate=30.0)
    jid = _mk_job(ids, "str_turnover", turnover_rate=90.0, pay_mode="hourly")
    _mk_entry(ids, cid, _dt(2026, 1, 3, 9), _dt(2026, 1, 3, 12), job_id=jid)  # Saturday, 3h
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-03", "2026-01-03"), cid)
        assert emp["rental_weekday_hours"] == 3.0
        assert emp["rental_weekday_pay"] == 90.0     # 3h * $30 hourly
        assert emp["weekend_turnovers"] == 0          # NOT paid as a piece turnover
        assert emp["weekend_pay"] == 0.0
        assert emp["gross_pay"] == 90.0
    finally:
        _clear()


def test_native_weekday_turnover_forced_piece(ids):
    # A weekday str_turnover set to pay_mode="piece" is paid the property piece
    # rate instead of hourly.
    assert date(2026, 1, 5).weekday() < 5    # Monday
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, rental_rate=30.0)
    jid = _mk_job(ids, "str_turnover", turnover_rate=85.0, pay_mode="piece")
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 12), job_id=jid)  # Monday, 3h
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["weekend_turnovers"] == 1        # counted as a piece turnover
        assert emp["weekend_pay"] == 85.0
        assert emp["rental_weekday_hours"] == 0.0    # NOT hourly
        assert emp["gross_pay"] == 85.0
    finally:
        _clear()


def test_native_weekend_turnover_auto_still_piece(ids):
    # Regression on the pay-mode restructure: with pay_mode unset (auto), a
    # weekend turnover is still paid piece rate.
    assert date(2026, 1, 3).weekday() >= 5
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "str_turnover", turnover_rate=90.0)   # pay_mode None → auto
    _mk_entry(ids, cid, _dt(2026, 1, 3, 14), _dt(2026, 1, 3, 17), job_id=jid)
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-03", "2026-01-03"), cid)
        assert emp["weekend_turnovers"] == 1
        assert emp["weekend_pay"] == 90.0
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


# ── Per-job hourly bump (Job.pay_rate_bump) ──────────────────────────────────

def test_hourly_bump_raises_hourly_pay_but_not_piece(ids):
    """The '+$1/hr for a two-cleaner deep clean / weekday immediate turnover'
    offer: hourly pay uses (rate + bump); a piece-rate turnover pays the flat
    property rate regardless of any bump on the job."""
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, res_rate=25.0)
    # Hourly residential with a $1 bump: 3h × (25 + 1) = 78.
    jid = _mk_job(ids, "residential")
    db = SessionLocal()
    db.query(Job).filter(Job.id == jid).update({"pay_rate_bump": 1.0})
    db.commit(); db.close()
    _mk_entry(ids, cid, _dt(2026, 1, 5, 14), _dt(2026, 1, 5, 17), job_id=jid)
    # Weekend piece turnover with a (meaningless) bump: still the flat 90.
    jid2 = _mk_job(ids, "str_turnover", turnover_rate=90.0)
    db = SessionLocal()
    db.query(Job).filter(Job.id == jid2).update({"pay_rate_bump": 5.0})
    db.commit(); db.close()
    _mk_entry(ids, cid, _dt(2026, 1, 3, 14), _dt(2026, 1, 3, 16), job_id=jid2)

    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-03", "2026-01-05"), cid)
        assert emp["residential_pay"] == 78.0
        assert emp["weekend_pay"] == 90.0
        assert emp["gross_pay"] == 168.0
        bumped = next(s for s in emp["shifts"] if s["kind"] == "residential")
        assert bumped["rate_bump"] == 1.0
    finally:
        _clear()


def test_job_patch_sets_and_rejects_negative_bump(ids):
    jid = _mk_job(ids, "residential")
    api = _admin_api()
    try:
        r = api.patch(f"/api/jobs/{jid}", json={"pay_rate_bump": 1.5})
        assert r.status_code == 200, r.text
        assert r.json()["pay_rate_bump"] == 1.5
        assert api.patch(f"/api/jobs/{jid}", json={"pay_rate_bump": -2}).status_code == 400
    finally:
        _clear()


# ── Native Send-to-Square (dry run — no Square network calls) ────────────────

def test_native_send_to_square_dry_run(ids, monkeypatch):
    """With payroll_source='native' the Square export builds timecards from the
    native clock: hourly punches at the cleaner's effective BrightBase rate
    (override + job bump), piece turnovers as adjustments, people matched by the
    native user's email. Dry run — nothing is written to Square."""
    from integrations import square as sq

    cid = f"CT-{uuid.uuid4().hex[:6]}"
    uid = _mk_cleaner(ids, cid, res_rate=25.0, name="Sam Match")
    db = SessionLocal()
    u = db.query(User).filter(User.id == uid).first()
    match_email = u.email  # native matching key
    db.close()

    # Hourly residential, $1 bump: 3h @ 26.00 → one timecard.
    jid = _mk_job(ids, "residential")
    db = SessionLocal(); db.query(Job).filter(Job.id == jid).update({"pay_rate_bump": 1.0}); db.commit(); db.close()
    e_hourly = _mk_entry(ids, cid, _dt(2026, 1, 5, 14), _dt(2026, 1, 5, 17), job_id=jid, miles=10.0)
    # Saturday piece turnover @ 90 → an adjustment, not a timecard.
    jid2 = _mk_job(ids, "str_turnover", turnover_rate=90.0)
    _mk_entry(ids, cid, _dt(2026, 1, 3, 14), _dt(2026, 1, 3, 16), job_id=jid2)
    # A second cleaner with no Square counterpart → listed unmatched.
    cid2 = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid2, name="No Square")
    jid3 = _mk_job(ids, "residential")
    _mk_entry(ids, cid2, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid3)

    monkeypatch.setattr(sq, "is_configured", lambda: True)
    monkeypatch.setattr(sq, "_get_location", lambda: "LOC-1")

    async def fake_members(location_id=None):
        return [{"id": "TM-1", "name": "Sam Match", "email": match_email}]
    monkeypatch.setattr(sq, "list_team_members", fake_members)

    called = {"created": 0}

    async def fake_create(**kw):  # must NOT be reached on a dry run
        called["created"] += 1
        return {"ok": True}
    monkeypatch.setattr(sq, "create_timecard", fake_create)

    api = _admin_api()
    try:
        r = api.post("/api/payroll/send-to-square",
                     json={"start_date": "2026-01-03", "end_date": "2026-01-05", "dry_run": True})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["dry_run"] is True and body["source"] == "native"
        assert body["matched"] == 1
        assert body["unmatched"] == ["No Square"]
        sam = next(e for e in body["employees"] if e["employee_id"] == cid)
        assert sam["timecard_count"] == 1
        tc = sam["timecards"][0]
        assert tc["shift_id"] == f"native:{e_hourly}"
        assert tc["hours"] == 3.0
        assert tc["rate_cents"] == 2600           # 25 override + 1 bump
        assert tc["rate_source"] == "brightbase"
        assert sam["piece_total"] == 90.0 and sam["piece_count"] == 1
        assert sam["mileage_reimbursement"] == round(10.0 * body_rates_mileage(api), 2)
        assert called["created"] == 0             # dry run never writes
    finally:
        _clear()


def body_rates_mileage(api):
    return api.get("/api/payroll/rates").json()["mileage_rate"]


def test_native_shift_detail_carries_job_and_property_ids(ids):
    """The payroll UI links each shift row to its job/property record, so the
    /summary shift payload must carry ids alongside the display strings — and
    null them for an unlinked punch (nothing to link to)."""
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "residential")
    pid = ids["properties"][-1]
    e_linked = _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 12), job_id=jid)
    e_unlinked = _mk_entry(ids, cid, _dt(2026, 1, 5, 13), _dt(2026, 1, 5, 14), job_id=None)
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        by_id = {s["shift_id"]: s for s in emp["shifts"]}
        linked = by_id[f"native:{e_linked}"]
        assert linked["job_id"] == jid
        assert linked["property_id"] == pid
        unlinked = by_id[f"native:{e_unlinked}"]
        assert unlinked["job_id"] is None
        assert unlinked["property_id"] is None
    finally:
        _clear()


# ── Marketplace jobs: the agreed rate is the pay ────────────────────────────
#
# A job whose claim request was approved carries agreed_rate — the flat price
# a subcontractor negotiated for the whole job (migration 097). Before this,
# payroll never read the column: the office would post $95, approve $95, and
# the sub's cheque would come out of pay_rate_residential × hours. The number
# both sides shook on reached the database and stopped there.
#
# The hourly/piece ladder is the EMPLOYEE model and doesn't apply to a sub, so
# a marketplace job short-circuits it entirely and gets its own bucket rather
# than inflating the residential/rental numbers.

def test_marketplace_job_pays_the_agreed_rate_not_the_hourly_rate(ids):
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, res_rate=25.0, name="Sub Contractor")
    jid = _mk_job(ids, "residential", agreed_rate=95.0, cleaner_ids=[cid])
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 12), job_id=jid)   # 3h
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["marketplace_jobs"] == 1
        assert emp["marketplace_pay"] == 95.0     # the agreed price...
        assert emp["marketplace_hours"] == 3.0    # ...hours still tracked for the timesheet
        # NOT 3h × $25 — and it never touches the employee buckets.
        assert emp["residential_hours"] == 0.0
        assert emp["residential_pay"] == 0.0
        assert emp["gross_pay"] == 95.0
    finally:
        _clear()


def test_two_punches_on_one_marketplace_job_are_one_flat_payment(ids):
    # A sub who clocks out for lunch and back in has worked one job for one
    # agreed price, not two.
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid)
    jid = _mk_job(ids, "residential", agreed_rate=120.0, cleaner_ids=[cid])
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)
    _mk_entry(ids, cid, _dt(2026, 1, 5, 12), _dt(2026, 1, 5, 14), job_id=jid)
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["marketplace_jobs"] == 1
        assert emp["marketplace_pay"] == 120.0    # once, not twice
        assert emp["marketplace_hours"] == 4.0
        assert emp["gross_pay"] == 120.0
    finally:
        _clear()


def test_an_agreed_rate_only_pays_the_cleaner_it_was_agreed_with(ids):
    # agreed_rate is one sub's negotiated price for the job. A second cleaner
    # who worked the same job but isn't on it gets the ordinary hourly
    # treatment — the flat price is not a per-head bounty.
    sub = f"CT-{uuid.uuid4().hex[:6]}"
    helper = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, sub, name="The Sub")
    _mk_cleaner(ids, helper, res_rate=30.0, name="Not The Sub")
    jid = _mk_job(ids, "residential", agreed_rate=100.0, cleaner_ids=[sub])
    _mk_entry(ids, sub, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)
    _mk_entry(ids, helper, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 11), job_id=jid)
    api = _admin_api()
    try:
        body = _summary(api, "2026-01-05", "2026-01-05")
        assert _emp(body, sub)["marketplace_pay"] == 100.0
        other = _emp(body, helper)
        assert other["marketplace_pay"] == 0.0
        assert other["residential_pay"] == 60.0     # 2h × $30, the employee path
    finally:
        _clear()


def test_an_ordinary_job_is_untouched_by_the_marketplace_branch(ids):
    # agreed_rate is NULL on every job that never went through the
    # marketplace, which is most of them — the employee model must be
    # exactly as it was.
    cid = f"CT-{uuid.uuid4().hex[:6]}"
    _mk_cleaner(ids, cid, res_rate=20.0)
    jid = _mk_job(ids, "residential", cleaner_ids=[cid])   # no agreed_rate
    _mk_entry(ids, cid, _dt(2026, 1, 5, 9), _dt(2026, 1, 5, 12), job_id=jid)
    api = _admin_api()
    try:
        emp = _emp(_summary(api, "2026-01-05", "2026-01-05"), cid)
        assert emp["marketplace_jobs"] == 0 and emp["marketplace_pay"] == 0.0
        assert emp["residential_hours"] == 3.0
        assert emp["residential_pay"] == 60.0
        assert emp["gross_pay"] == 60.0
    finally:
        _clear()


def test_send_to_square_excludes_subcontractor_punches(ids, monkeypatch):
    """A punch on an agreed_rate job never becomes a Square timecard.

    This is the guarantee that keeps a subcontractor out of Square Payroll. A
    timecard there states an hourly wage and an employment relationship; before
    the guard in _native_send_to_square the export didn't know agreed_rate
    existed, so a sub who clocked into a job they'd claimed would have been
    pushed at pay_rate_residential — wrong money AND wrong classification.

    The same cleaner's ORDINARY employee punch in the same period must still
    export, so the exclusion is proven to be per-job and not per-person.
    """
    from integrations import square as sq

    cid = f"CT-{uuid.uuid4().hex[:6]}"
    uid = _mk_cleaner(ids, cid, res_rate=25.0, name="Sub And Staff")
    db = SessionLocal()
    match_email = db.query(User).filter(User.id == uid).first().email
    db.close()

    # Claimed at a flat $140 — three hours of punch that must not be exported.
    sub_job = _mk_job(ids, "residential", agreed_rate=140.0, cleaner_ids=[cid])
    _mk_entry(ids, cid, _dt(2026, 1, 5, 8), _dt(2026, 1, 5, 11), job_id=sub_job, miles=25.0)
    # An ordinary employee job the same day — 2h, must still export.
    emp_job = _mk_job(ids, "residential", cleaner_ids=[cid])
    e_emp = _mk_entry(ids, cid, _dt(2026, 1, 5, 13), _dt(2026, 1, 5, 15), job_id=emp_job, miles=4.0)

    monkeypatch.setattr(sq, "is_configured", lambda: True)
    monkeypatch.setattr(sq, "_get_location", lambda: "LOC-1")

    async def fake_members(location_id=None):
        return [{"id": "TM-9", "name": "Sub And Staff", "email": match_email}]
    monkeypatch.setattr(sq, "list_team_members", fake_members)

    api = _admin_api()
    try:
        r = api.post("/api/payroll/send-to-square",
                     json={"start_date": "2026-01-05", "end_date": "2026-01-05", "dry_run": True})
        assert r.status_code == 200, r.text
        body = r.json()
        person = next(e for e in body["employees"] if e["employee_id"] == cid)

        shifts = [tc["shift_id"] for tc in person["timecards"]]
        assert shifts == [f"native:{e_emp}"], shifts
        assert person["marketplace_excluded"] == 1
        assert body["marketplace_excluded"] == 1
        # The withheld punch's mileage goes with it: reimbursement is an
        # employee benefit, and a sub's driving is priced into their rate.
        assert person["miles"] == 4.0
    finally:
        _clear()
