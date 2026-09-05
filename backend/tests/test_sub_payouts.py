"""Paying a subcontractor: the ledger (marketplace pivot, migration 099).

A sub is a vendor, so their money does not travel the employee rail. These
cover the parts of that where being wrong costs real money:

  * generate records completed marketplace work once, and running it again on
    the same period records nothing — the button sits next to a bank account;
  * an unearned job (not completed, cancelled, out of period) is not payable;
  * a crew ID with no login is reported, never silently dropped;
  * year-to-date groups by when the work happened, excludes void, and flags
    the 1099 threshold;
  * the manual rail marks payouts SENT and not PAID, because this code cannot
    know whether a cheque was written;
  * only `due` payouts are sendable, so nobody gets paid twice;
  * `sub_payouts` is in TENANT_TABLES (migration 095 exists because two tables
    sat org-scoped but unprotected for months).
"""
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, SubPayout, User
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 9301, 1, "admin", "active", True
    email = "payout-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


class _Manager:
    id, org_id, role, status, active = 9302, 1, "manager", "active", True
    email = "payout-manager@example.com"
    full_name = "A Manager"
    cleaner_id = None


# Fixed dates so a year boundary is deterministic and never depends on today.
IN_PERIOD = date(2026, 3, 10)
LAST_YEAR = date(2025, 11, 4)


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield ids
    db = SessionLocal()
    db.query(SubPayout).filter(SubPayout.user_id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_sub(ids, name="A Sub", org_id=1):
    cleaner_id = f"CT-{uuid.uuid4().hex[:6]}"
    db = SessionLocal()
    u = User(email=f"sub-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name=name, org_id=org_id, active=True, status="active",
             cleaner_id=cleaner_id)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id); uid = u.id; db.close()
    return uid, cleaner_id


def _mk_job(ids, *, cleaner_ids, agreed_rate=None, when=IN_PERIOD,
            status="completed", org_id=1, title="Weekly clean"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Payout {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"9 Ledger {tag}", address=f"9 Ledger {tag}",
                 org_id=org_id)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=title,
            scheduled_date=when, status=status, cleaner_ids=list(cleaner_ids),
            org_id=org_id, agreed_rate=agreed_rate)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _api(user=None):
    app.dependency_overrides[get_current_user] = lambda: (user or _Admin())
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _generate(api, start="2026-03-01", end="2026-03-31"):
    r = api.post("/api/payroll/subcontractors/payouts/generate",
                 json={"start_date": start, "end_date": end})
    assert r.status_code == 200, r.text
    return r.json()


def _view(api, start="2026-03-01", end="2026-03-31"):
    r = api.get(f"/api/payroll/subcontractors?start_date={start}&end_date={end}")
    assert r.status_code == 200, r.text
    return r.json()


# ── Recording what's owed ───────────────────────────────────────────────────

def test_generate_records_completed_marketplace_work_once(ids):
    """The property that makes the Generate button safe to press twice."""
    uid, cid = _mk_sub(ids, name="Dana Sub")
    jid = _mk_job(ids, cleaner_ids=[cid], agreed_rate=140.0)
    api = _api()
    try:
        first = _generate(api)
        assert first["created"] == 1 and first["total"] == 140.0

        second = _generate(api)
        assert second["created"] == 0, "a re-run must not pay the same job twice"
        assert second["skipped_existing"] == 1

        db = SessionLocal()
        rows = db.query(SubPayout).filter(SubPayout.job_id == jid).all()
        assert len(rows) == 1
        row = rows[0]
        assert (row.user_id, row.cleaner_id, row.amount) == (uid, cid, 140.0)
        assert row.status == "due" and row.paid_at is None
        # earned_on is the WORK date, not today — a YTD total groups by it.
        assert row.earned_on == IN_PERIOD
        db.close()
    finally:
        _clear()


def test_only_completed_marketplace_jobs_in_the_period_are_payable(ids):
    """Three ways a job looks payable and isn't."""
    uid, cid = _mk_sub(ids)
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=90.0, status="scheduled")   # not done
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=90.0, status="cancelled")   # called off
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=90.0, when=date(2026, 4, 2))  # next period
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=None)                       # employee work
    api = _api()
    try:
        assert _generate(api)["created"] == 0
        assert _view(api)["unrecorded_total"] == 0.0
    finally:
        _clear()


def test_a_crew_id_with_no_login_is_reported_not_dropped(ids):
    """The one case where work happened and nothing here can say who to pay.

    Silently skipping it would mean a sub does a job and never appears on any
    screen that owes them money.
    """
    _mk_job(ids, cleaner_ids=["CT-GHOST"], agreed_rate=110.0)
    api = _api()
    try:
        out = _generate(api)
        assert out["created"] == 0
        assert [u["cleaner_id"] for u in out["unmatched"]] == ["CT-GHOST"]
        assert _view(api)["unmatched"][0]["cleaner_id"] == "CT-GHOST"
    finally:
        _clear()


def test_two_subs_on_one_job_are_each_owed_the_agreed_rate(ids):
    """agreed_rate is the price of the job to each person who agreed to it.

    Both rows exist because UNIQUE is (user_id, job_id), not (job_id) — a
    two-person job that paid one of them would be the more expensive bug.
    """
    _, cid_a = _mk_sub(ids, name="Sub A")
    _, cid_b = _mk_sub(ids, name="Sub B")
    _mk_job(ids, cleaner_ids=[cid_a, cid_b], agreed_rate=75.0)
    api = _api()
    try:
        out = _generate(api)
        assert out["created"] == 2 and out["total"] == 150.0
    finally:
        _clear()


# ── The period view ─────────────────────────────────────────────────────────

def test_the_view_separates_earned_from_unrecorded(ids):
    """Both numbers, so pressing Generate is legible rather than a leap."""
    _, cid = _mk_sub(ids)
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=200.0)
    api = _api()
    try:
        before = _view(api)
        assert before["earned_total"] == 200.0
        assert before["unrecorded_total"] == 200.0
        assert before["payouts"] == []
        assert before["rail"] == {"name": "manual", "settles": False}

        _generate(api)
        after = _view(api)
        assert after["earned_total"] == 200.0
        assert after["unrecorded_total"] == 0.0, "already on the ledger"
        assert after["due_total"] == 200.0 and after["paid_total"] == 0.0
        assert len(after["payouts"]) == 1
        assert after["payouts"][0]["name"] == "A Sub"
    finally:
        _clear()


def test_subcontractor_views_are_office_only(ids):
    """A manager can look; only an admin moves money."""
    api = _api(_Manager())
    try:
        assert api.get("/api/payroll/subcontractors"
                       "?start_date=2026-03-01&end_date=2026-03-31").status_code == 200
        r = api.post("/api/payroll/subcontractors/payouts/generate",
                     json={"start_date": "2026-03-01", "end_date": "2026-03-31"})
        assert r.status_code == 403
    finally:
        _clear()


# ── Year to date ────────────────────────────────────────────────────────────

def test_ytd_groups_by_work_date_excludes_void_and_flags_the_threshold(ids):
    uid, cid = _mk_sub(ids, name="Busy Sub")
    api = _api()
    try:
        db = SessionLocal()
        for amount, when, status in ((400.0, IN_PERIOD, "paid"),
                                     (250.0, date(2026, 5, 1), "due"),
                                     (999.0, IN_PERIOD, "void"),
                                     (500.0, LAST_YEAR, "paid")):
            db.add(SubPayout(org_id=1, user_id=uid, cleaner_id=cid, job_id=None,
                             amount=amount, status=status, earned_on=when))
        db.commit(); db.close()

        r = api.get("/api/payroll/subcontractors"
                    "?start_date=2026-03-01&end_date=2026-03-31")
        ytd = r.json()["ytd"]
        assert ytd["year"] == 2026
        row = next(s for s in ytd["subs"] if s["user_id"] == uid)
        # 400 + 250. The void is not money and last year is not this year.
        assert row["total"] == 650.0
        assert row["paid"] == 400.0 and row["outstanding"] == 250.0
        assert row["over_1099_threshold"] is True
    finally:
        _clear()


def test_ytd_threshold_is_not_flagged_below_600(ids):
    uid, cid = _mk_sub(ids, name="Quiet Sub")
    api = _api()
    try:
        db = SessionLocal()
        db.add(SubPayout(org_id=1, user_id=uid, cleaner_id=cid, amount=599.99,
                         status="due", earned_on=IN_PERIOD))
        db.commit(); db.close()
        ytd = _view(api)["ytd"]
        row = next(s for s in ytd["subs"] if s["user_id"] == uid)
        assert row["over_1099_threshold"] is False
    finally:
        _clear()


# ── Moving money ────────────────────────────────────────────────────────────

def test_manual_rail_marks_sent_never_paid_and_returns_a_csv(ids):
    """The rail cannot know whether a cheque was written. Only a person can."""
    _, cid = _mk_sub(ids, name="Casey Sub")
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=125.5, title="Deep clean")
    api = _api()
    try:
        _generate(api)
        pid = _view(api)["payouts"][0]["id"]

        r = api.post("/api/payroll/subcontractors/payouts/send",
                     json={"payout_ids": [pid]})
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["rail"] == "manual" and out["settled"] is False
        assert out["count"] == 1 and out["total"] == 125.5
        header, row = out["csv"].strip().splitlines()[:2]
        assert header.startswith("payout_id,name,cleaner_id")
        assert "Casey Sub" in row and "125.50" in row

        after = _view(api)["payouts"][0]
        assert after["status"] == "sent" and after["method"] == "manual"
        assert after["paid_at"] is None, "sent is not paid"
    finally:
        _clear()


def test_a_payout_already_sent_cannot_be_sent_again(ids):
    """Re-sending is how one person gets paid twice."""
    _, cid = _mk_sub(ids)
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=60.0)
    api = _api()
    try:
        _generate(api)
        pid = _view(api)["payouts"][0]["id"]
        assert api.post("/api/payroll/subcontractors/payouts/send",
                        json={"payout_ids": [pid]}).status_code == 200
        again = api.post("/api/payroll/subcontractors/payouts/send",
                         json={"payout_ids": [pid]})
        assert again.status_code == 422
        assert "aren't due" in again.json()["detail"]
    finally:
        _clear()


def test_marking_paid_stamps_the_date_once(ids):
    """The date money left is a fact; a second click must not move it."""
    _, cid = _mk_sub(ids)
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=80.0)
    api = _api()
    try:
        _generate(api)
        pid = _view(api)["payouts"][0]["id"]
        api.post("/api/payroll/subcontractors/payouts/mark",
                 json={"payout_ids": [pid], "status": "paid",
                       "method": "check", "external_ref": "1042"})
        first = _view(api)["payouts"][0]
        assert first["status"] == "paid" and first["paid_at"] is not None
        assert first["method"] == "check" and first["external_ref"] == "1042"

        api.post("/api/payroll/subcontractors/payouts/mark",
                 json={"payout_ids": [pid], "status": "paid"})
        assert _view(api)["payouts"][0]["paid_at"] == first["paid_at"]
    finally:
        _clear()


def test_void_leaves_the_row_and_drops_out_of_the_totals(ids):
    """A cancelled payout is a thing that happened — voided, never deleted."""
    _, cid = _mk_sub(ids)
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=95.0)
    api = _api()
    try:
        _generate(api)
        pid = _view(api)["payouts"][0]["id"]
        api.post("/api/payroll/subcontractors/payouts/mark",
                 json={"payout_ids": [pid], "status": "void"})
        after = _view(api)
        assert [p["status"] for p in after["payouts"]] == ["void"]
        assert after["due_total"] == 0.0 and after["outstanding_total"] == 0.0
        assert after["ytd"]["total"] == 0.0
    finally:
        _clear()


def test_an_unknown_status_is_refused(ids):
    _, cid = _mk_sub(ids)
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=10.0)
    api = _api()
    try:
        _generate(api)
        pid = _view(api)["payouts"][0]["id"]
        r = api.post("/api/payroll/subcontractors/payouts/mark",
                     json={"payout_ids": [pid], "status": "settled-ish"})
        assert r.status_code == 422
    finally:
        _clear()


# ── Tenancy (MT-3) ──────────────────────────────────────────────────────────

def test_sub_payouts_is_rls_protected():
    """Migration 095 exists because two tables sat org-scoped but unprotected
    for months. 097, 098 and 099 keep the streak."""
    from database.rls import TENANT_TABLES
    assert "sub_payouts" in TENANT_TABLES


def test_another_orgs_marketplace_work_is_not_payable_here(ids):
    _, cid = _mk_sub(ids, name="Other Org Sub", org_id=2)
    _mk_job(ids, cleaner_ids=[cid], agreed_rate=300.0, org_id=2)
    api = _api()          # org 1
    try:
        assert _generate(api)["created"] == 0
        assert _view(api)["earned_total"] == 0.0
    finally:
        _clear()


def test_a_conflicting_row_mid_batch_does_not_discard_the_ones_before_it(ids, monkeypatch):
    """The savepoint, proven.

    generate flushes row by row so a UNIQUE collision can be swallowed per row.
    Without a SAVEPOINT that swallow is a session-wide rollback, and the
    payouts already flushed ahead of the collision go with it — quietly, with
    `created` still counting them. A period where one job was already paid
    would then record only the jobs that came after it.

    The race is forced rather than waited for: preview is patched to report a
    job it would normally skip, which is exactly what a concurrent generate
    produces — a plan written before another process inserted the row.
    """
    from services import sub_payouts

    _, cid = _mk_sub(ids, name="Ordered Sub")
    early = _mk_job(ids, cleaner_ids=[cid], agreed_rate=10.0, when=date(2026, 3, 1))
    middle = _mk_job(ids, cleaner_ids=[cid], agreed_rate=20.0, when=date(2026, 3, 2))
    late = _mk_job(ids, cleaner_ids=[cid], agreed_rate=30.0, when=date(2026, 3, 3))

    db = SessionLocal()
    uid = db.query(User).filter(User.cleaner_id == cid).first().id
    # Already on the ledger — the row the plan below is stale about.
    db.add(SubPayout(org_id=1, user_id=uid, job_id=middle, cleaner_id=cid,
                     amount=20.0, status="due", earned_on=date(2026, 3, 2)))
    db.commit(); db.close()

    real_preview = sub_payouts.preview

    def stale_preview(db, org_id, start, end):
        plan = real_preview(db, org_id, start, end)
        # Put the already-written job back into `new`, in date order, so the
        # collision lands in the MIDDLE of the batch and not at either end.
        plan["new"] = sorted(
            plan["new"] + [{"job_id": middle, "user_id": uid, "cleaner_id": cid,
                            "name": "Ordered Sub", "amount": 20.0,
                            "earned_on": "2026-03-02", "memo": "Weekly clean"}],
            key=lambda r: r["earned_on"])
        return plan
    monkeypatch.setattr(sub_payouts, "preview", stale_preview)

    db = SessionLocal()
    out = sub_payouts.generate(db, 1, date(2026, 3, 1), date(2026, 3, 31))
    db.close()

    db = SessionLocal()
    paid_for = {p.job_id for p in db.query(SubPayout).filter(SubPayout.user_id == uid).all()}
    db.close()
    assert paid_for == {early, middle, late}, "the row before the collision was lost"
    assert out["created"] == 2, "the collision must not be counted as created"
