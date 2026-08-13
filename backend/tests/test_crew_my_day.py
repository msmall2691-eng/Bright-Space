"""GET /api/crew/my-day — a cleaner-role login sees only jobs assigned to
their linked crew ID (Job.cleaner_ids), scoped to today + a short window.
Additive feature: doesn't touch dispatch, Connecteam, or payroll."""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, User
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.cleaner_id = cleaner_id


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(ids):
    db = SessionLocal()
    c = Client(name=f"Crew {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def _mk_str_property(ids, cid):
    db = SessionLocal()
    p = Property(client_id=cid, name="9 Lakeshore Dr", address="9 Lakeshore Dr",
                 property_type="str", org_id=1,
                 check_out_time="10:00", check_in_time="16:00", house_code="4521",
                 access_notes="Side door lockbox")
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id); pid = p.id; db.close()
    return pid


def _mk_job(ids, cid, pid, cleaner_ids, offset_days=0, job_type="str_turnover"):
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type=job_type,
            title="Turnover", scheduled_date=business_today() + timedelta(days=offset_days),
            start_time=time(10, 0), end_time=time(13, 0),
            cleaner_ids=cleaner_ids, status="scheduled", org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id); jid = j.id; db.close()
    return jid


def test_my_day_returns_only_this_cleaners_jobs(ids):
    cid = _mk_client(ids)
    pid = _mk_str_property(ids, cid)
    mine_today = _mk_job(ids, cid, pid, ["CT-101"], offset_days=0)
    mine_later = _mk_job(ids, cid, pid, ["CT-101"], offset_days=2)
    # A distinct property/date/type combo — (property, date, job_type) is
    # unique, so this can't share `mine_today`'s slot.
    pid2 = _mk_str_property(ids, cid)
    someone_elses = _mk_job(ids, cid, pid2, ["CT-202"], offset_days=0)

    app.dependency_overrides[get_current_user] = lambda: _Cleaner(9001, "CT-101")
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.get("/api/crew/my-day")
        assert res.status_code == 200
        body = res.json()
        today_ids = {j["id"] for j in body["today"]}
        upcoming_ids = {j["id"] for j in body["upcoming"]}
        assert today_ids == {mine_today}
        assert upcoming_ids == {mine_later}
        assert someone_elses not in today_ids and someone_elses not in upcoming_ids

        # Turnover context surfaces without needing the job-detail drawer.
        row = body["today"][0]
        assert row["turnover_line"] == "Guest out 10:00 → in 16:00 · Code 4521"
        assert row["access_notes"] == "Side door lockbox"
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


def test_my_day_requires_a_linked_crew_id():
    app.dependency_overrides[get_current_user] = lambda: _Cleaner(9002, None)
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.get("/api/crew/my-day")
        assert res.status_code == 400
        assert "crew ID" in res.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


def test_non_cleaner_role_is_rejected():
    class _Admin:
        id, org_id, role, status, active = 9003, 1, "admin", "active", True
        email = "admin@example.com"
        cleaner_id = None

    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.get("/api/crew/my-day")
        assert res.status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


def test_admin_can_link_a_cleaner_id_via_users_endpoint():
    """AdminUserUpdate.cleaner_id round-trips through the existing Users
    admin screen's PATCH endpoint."""
    db = SessionLocal()
    u = User(email=f"crew-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="Test Crew", org_id=1, active=True, status="active")
    db.add(u); db.commit(); db.refresh(u)
    uid = u.id; db.close()

    class _Admin:
        id, org_id, role, status, active = 9004, 1, "admin", "active", True
        email = "admin2@example.com"

    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.patch(f"/api/auth/users/{uid}", json={"cleaner_id": " CT-303 "})
        assert res.status_code == 200
        assert res.json()["cleaner_id"] == "CT-303"  # trimmed

        res2 = api.patch(f"/api/auth/users/{uid}", json={"cleaner_id": ""})
        assert res2.status_code == 200
        assert res2.json()["cleaner_id"] is None  # "" clears the link
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)
        db = SessionLocal()
        db.query(User).filter(User.id == uid).delete()
        db.commit(); db.close()


# ── /my-week: earned-so-far + predicted pay ──────────────────────────────────

class _PaidCleaner(_Cleaner):
    """my-week reads the caller's per-cleaner rates off the User object, so the
    stub carries them (None on the base stub would be an AttributeError)."""
    def __init__(self, uid, cleaner_id, res=30.0, rental=None, deep=None):
        super().__init__(uid, cleaner_id)
        self.pay_rate_residential = res
        self.pay_rate_rental = rental
        self.pay_rate_deep = deep


def test_my_week_predicts_upcoming_and_excludes_punched_jobs(ids):
    """The cleaner's week view: a job already worked (closed punch) counts in
    'earned' via the payroll engine and is NOT double-counted as a prediction;
    remaining assigned jobs are predicted at scheduled-hours × (rate + bump),
    piece jobs at the property's flat rate."""
    from datetime import datetime, time as dtime
    from database.models import TimeEntry

    crew = f"CT-{uuid.uuid4().hex[:6]}"
    cid = _mk_client(ids)

    # Job A — worked already: 2h closed punch. Shop default residential rate
    # (no DB user for this crew ID) → earned = 2 × $25 = $50.
    pid_a = _mk_str_property(ids, cid)
    job_a = _mk_job(ids, cid, pid_a, [crew], offset_days=0, job_type="residential")
    db = SessionLocal()
    e = TimeEntry(org_id=1, cleaner_id=crew, job_id=job_a,
                  clock_in_at=datetime.combine(business_today(), dtime(12, 0)),
                  clock_out_at=datetime.combine(business_today(), dtime(14, 0)),
                  source="native")
    db.add(e); db.commit(); db.refresh(e); entry_id = e.id
    db.close()

    # Job B — still ahead today, 10:00–13:00 (3h), +$1/hr bump → 3 × (30+1) = 93
    # at the caller's residential override.
    pid_b = _mk_str_property(ids, cid)
    job_b = _mk_job(ids, cid, pid_b, [crew], offset_days=0, job_type="residential")
    db = SessionLocal()
    db.query(Job).filter(Job.id == job_b).update({"pay_rate_bump": 1.0})
    db.commit(); db.close()

    # Job C — a turnover forced to piece rate, $80 flat (deterministic on any
    # weekday, so the test doesn't care which day of the week 'today' is).
    pid_c = _mk_str_property(ids, cid)
    job_c = _mk_job(ids, cid, pid_c, [crew], offset_days=0, job_type="str_turnover")
    db = SessionLocal()
    db.query(Job).filter(Job.id == job_c).update({"pay_mode": "piece"})
    db.query(Property).filter(Property.id == pid_c).update({"turnover_rate": 80.0})
    db.commit(); db.close()

    app.dependency_overrides[get_current_user] = lambda: _PaidCleaner(9005, crew)
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        res = api.get("/api/crew/my-week")
        assert res.status_code == 200, res.text
        body = res.json()

        # Earned = 2h at the CURRENT shop residential rate (no DB user carries
        # this crew ID, so the engine falls back to the settings default —
        # read it live so an earlier test tweaking rates can't flake this).
        from modules.payroll.router import _get_rates
        db = SessionLocal(); shop_res = _get_rates(db)["residential_rate"]; db.close()
        expected_earned = round(2.0 * shop_res, 2)
        assert body["earned"]["gross_pay"] == expected_earned
        assert body["earned"]["hours"] == 2.0

        by_id = {j["id"]: j for j in body["upcoming"]}
        assert job_a not in by_id          # worked → earned, never predicted too
        assert by_id[job_b]["predicted_pay"] == 93.0
        assert by_id[job_b]["bump"] == 1.0
        assert by_id[job_c]["piece"] is True
        assert by_id[job_c]["predicted_pay"] == 80.0

        assert body["predicted_upcoming_total"] == 173.0
        assert body["predicted_week_total"] == round(expected_earned + 173.0, 2)
    finally:
        db = SessionLocal()
        db.query(TimeEntry).filter(TimeEntry.id == entry_id).delete(synchronize_session=False)
        db.commit(); db.close()
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


# ── Mark done (Phase 2c): POST /api/crew/jobs/{id}/complete ──────────────────

def _as_cleaner(uid, crew_id):
    app.dependency_overrides[get_current_user] = lambda: _Cleaner(uid, crew_id)
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear_overrides():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_mark_done_completes_own_job_with_note_invoice_and_activity(ids):
    """The embarrassing-if-broken path: cleaner marks their own job done →
    status flips, the note is stored (on its own column, NOT Job.notes — crew
    notes must never reach the invoice the client sees), the client timeline
    gets ONE job_completed activity carrying the note, and ONE draft invoice
    is created. Re-marking refreshes the note without duplicating either."""
    from database.models import Activity, Invoice

    crew = f"CT-{uuid.uuid4().hex[:6]}"
    cid = _mk_client(ids)
    pid = _mk_str_property(ids, cid)
    jid = _mk_job(ids, cid, pid, [crew], offset_days=0)

    # Count deltas, not absolutes: SQLite recycles deleted job IDs, so a fresh
    # job can inherit orphaned Activity/Invoice rows from earlier tests.
    db = SessionLocal()
    pre_inv = db.query(Invoice).filter(Invoice.job_id == jid).count()
    pre_act = db.query(Activity).filter(Activity.job_id == jid,
                                        Activity.activity_type == "job_completed").count()
    db.close()

    api = _as_cleaner(9101, crew)
    try:
        res = api.post(f"/api/crew/jobs/{jid}/complete",
                       json={"note": "  Lockbox was empty — left key under mat  "})
        assert res.status_code == 200, res.text
        row = res.json()
        assert row["status"] == "completed"
        assert row["completion_note"] == "Lockbox was empty — left key under mat"  # trimmed
        assert row["completed_at"] is not None

        db = SessionLocal()
        j = db.query(Job).filter(Job.id == jid).first()
        assert j.status == "completed"
        assert j.completed_by == 9101              # forced to the caller, never client-supplied
        assert j.completion_note.startswith("Lockbox")
        assert not (j.notes or "")                 # crew note did NOT touch Job.notes

        invoices = (db.query(Invoice).filter(Invoice.job_id == jid)
                    .order_by(Invoice.id.desc()).all())
        assert len(invoices) == pre_inv + 1 and invoices[0].status == "draft"
        acts = (db.query(Activity)
                .filter(Activity.job_id == jid,
                        Activity.activity_type == "job_completed")
                .order_by(Activity.id.desc()).all())
        assert len(acts) == pre_act + 1
        assert "Lockbox was empty" in acts[0].summary
        assert acts[0].extra_data.get("note", "").startswith("Lockbox")
        db.close()

        # Idempotent re-mark with a fresh note: note refreshed, no dupes.
        res2 = api.post(f"/api/crew/jobs/{jid}/complete", json={"note": "Also low on towels"})
        assert res2.status_code == 200
        assert res2.json()["completion_note"] == "Also low on towels"
        db = SessionLocal()
        assert db.query(Invoice).filter(Invoice.job_id == jid).count() == pre_inv + 1
        assert db.query(Activity).filter(Activity.job_id == jid,
                                         Activity.activity_type == "job_completed").count() == pre_act + 1
        db.close()
    finally:
        _clear_overrides()
        db = SessionLocal()
        db.query(Invoice).filter(Invoice.job_id == jid).delete(synchronize_session=False)
        db.query(Activity).filter(Activity.job_id == jid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_mark_done_refuses_a_job_not_assigned_to_caller(ids):
    """Object-level authorization — the check the office endpoint never had:
    a valid cleaner token must not complete someone else's job. Reads as 404
    so job IDs can't be probed."""
    cid = _mk_client(ids)
    pid = _mk_str_property(ids, cid)
    jid = _mk_job(ids, cid, pid, ["CT-OTHER"], offset_days=0)

    api = _as_cleaner(9102, "CT-NOT-ON-JOB")
    try:
        res = api.post(f"/api/crew/jobs/{jid}/complete", json={"note": "sneaky"})
        assert res.status_code == 404
        db = SessionLocal()
        j = db.query(Job).filter(Job.id == jid).first()
        assert j.status == "scheduled" and j.completion_note is None  # untouched
        db.close()
    finally:
        _clear_overrides()


def test_mark_done_refuses_cancelled_and_office_complete_refuses_cleaner(ids):
    """Two guardrails: a cancelled job can't be 'completed' from the field, and
    the office POST /api/jobs/{id}/complete no longer accepts cleaner tokens
    (it has no assignment check — regression-lock the closed hole)."""
    crew = f"CT-{uuid.uuid4().hex[:6]}"
    cid = _mk_client(ids)
    pid = _mk_str_property(ids, cid)
    jid = _mk_job(ids, cid, pid, [crew], offset_days=0)
    db = SessionLocal()
    db.query(Job).filter(Job.id == jid).update({"status": "cancelled"})
    db.commit(); db.close()

    api = _as_cleaner(9103, crew)
    try:
        assert api.post(f"/api/crew/jobs/{jid}/complete").status_code == 400
        assert api.post(f"/api/jobs/{jid}/complete", json={}).status_code == 403
    finally:
        _clear_overrides()


def test_my_day_keeps_todays_completed_job_visible(ids):
    """Marking done must not make the job vanish from the phone — today's list
    keeps it (as status=completed, for the Done ✓ card); upcoming never shows
    completed jobs."""
    crew = f"CT-{uuid.uuid4().hex[:6]}"
    cid = _mk_client(ids)
    pid = _mk_str_property(ids, cid)
    jid_today = _mk_job(ids, cid, pid, [crew], offset_days=0)
    pid2 = _mk_str_property(ids, cid)
    jid_future = _mk_job(ids, cid, pid2, [crew], offset_days=2)
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_([jid_today, jid_future])).update(
        {"status": "completed"}, synchronize_session=False)
    db.commit(); db.close()

    api = _as_cleaner(9104, crew)
    try:
        body = api.get("/api/crew/my-day").json()
        today = {j["id"]: j for j in body["today"]}
        assert jid_today in today and today[jid_today]["status"] == "completed"
        assert jid_future not in {j["id"] for j in body["upcoming"]}
    finally:
        _clear_overrides()


def test_my_week_requires_cleaner_role_and_crew_id():
    # Wrong role → 403 (the roster/payroll surface stays staff-only).
    class _Member(_PaidCleaner):
        def __init__(self):
            super().__init__(9006, "CT-X")
            self.role = "member"
    app.dependency_overrides[get_current_user] = lambda: _Member()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    try:
        assert api.get("/api/crew/my-week").status_code == 403
        # No crew ID linked yet → 400 with the setup message.
        app.dependency_overrides[get_current_user] = lambda: _PaidCleaner(9007, None)
        assert api.get("/api/crew/my-week").status_code == 400
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)
