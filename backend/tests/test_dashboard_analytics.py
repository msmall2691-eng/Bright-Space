"""Owner-analytics widgets: GET /api/dashboard/property-economics and
GET /api/dashboard/week-capacity (modules/dashboard/analytics.py).

Property economics is asserted on seeded rows directly (each test owns a
freshly created property, so its row in the response is fully determined by
what the test seeded). Week capacity aggregates the whole org, so it is
verified by DELTA against a pre-seed snapshot — same approach as
test_dashboard_board — making it robust against whatever else lives in the
shared test DB.
"""
import uuid
from datetime import datetime, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    CleanerTimeOff, CleanerWeekAvailability, Client, Invoice, Job, Property,
    TimeEntry, User,
)
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today, week_monday


class _Admin:
    id, org_id, role, status, active = 8601, 1, "admin", "active", True
    email = "analytics-admin@example.com"
    cleaner_id = None


class _Viewer:
    id, org_id, role, status, active = 8602, 1, "viewer", "active", True
    email = "analytics-viewer@example.com"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: user.org_id
    return TestClient(app)


@pytest.fixture
def ids():
    """Track everything a test seeds; delete it afterwards (shared DB)."""
    created = {"clients": [], "properties": [], "jobs": [], "invoices": [],
               "entries": [], "users": [], "weeks": [], "timeoff": []}
    yield created
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    db.query(TimeEntry).filter(TimeEntry.id.in_(created["entries"] or [0])).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.id.in_(created["invoices"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(created["jobs"] or [0])).delete(synchronize_session=False)
    db.query(CleanerWeekAvailability).filter(CleanerWeekAvailability.id.in_(created["weeks"] or [0])).delete(synchronize_session=False)
    db.query(CleanerTimeOff).filter(CleanerTimeOff.id.in_(created["timeoff"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(created["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(created["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(created["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seed_property(ids, org_id=1):
    db = SessionLocal()
    c = Client(name=f"Econ {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"{uuid.uuid4().hex[:4]} Econ Lane",
                 address="1 Econ Lane", property_type="residential", org_id=org_id,
                 access_notes="lockbox 4251", house_code="9999")
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id)
    out = (c.id, p.id); db.close()
    return out


def _seed_job(ids, cid, pid, *, org_id=1, status="completed", scheduled=None,
              start=None, end=None, job_type="residential"):
    db = SessionLocal()
    j = Job(client_id=cid, property_id=pid, job_type=job_type, title="Econ job",
            scheduled_date=scheduled or business_today(), start_time=start,
            end_time=end, status=status, cleaner_ids=[], org_id=org_id)
    db.add(j); db.commit(); db.refresh(j)
    ids["jobs"].append(j.id); jid = j.id; db.close()
    return jid


def _seed_invoice(ids, cid, jid, *, org_id=1, status="paid", total=100.0):
    db = SessionLocal()
    inv = Invoice(client_id=cid, job_id=jid, total=total, subtotal=total,
                  status=status, org_id=org_id,
                  paid_at=datetime.utcnow() if status == "paid" else None)
    db.add(inv); db.commit(); db.refresh(inv)
    ids["invoices"].append(inv.id); iid = inv.id; db.close()
    return iid


def _seed_punch(ids, jid, *, hours=2.0, break_minutes=0, org_id=1,
                cleaner="econ-cleaner"):
    db = SessionLocal()
    out_at = datetime.utcnow() - timedelta(hours=1)
    in_at = out_at - timedelta(hours=hours)
    e = TimeEntry(cleaner_id=cleaner, job_id=jid, clock_in_at=in_at,
                  clock_out_at=out_at, break_minutes=break_minutes, org_id=org_id)
    db.add(e); db.commit(); db.refresh(e)
    ids["entries"].append(e.id); db.close()


def _econ_row(api, pid):
    r = api.get("/api/dashboard/property-economics?limit=50&window_days=90")
    assert r.status_code == 200
    body = r.json()
    return body, next((p for p in body["properties"] if p["property_id"] == pid), None)


# ── property economics ──────────────────────────────────────────────────────

def test_property_economics_math(ids):
    """Paid vs invoiced split, draft exclusion, visit count, punch hours, $/hr."""
    cid, pid = _seed_property(ids)
    j1 = _seed_job(ids, cid, pid)                       # completed visit 1
    j2 = _seed_job(ids, cid, pid)                       # completed visit 2
    _seed_job(ids, cid, pid, status="scheduled",
              scheduled=business_today() + timedelta(days=2))  # future — not a visit
    _seed_invoice(ids, cid, j1, status="paid", total=300.0)
    _seed_invoice(ids, cid, j2, status="sent", total=200.0)
    _seed_invoice(ids, cid, j2, status="draft", total=999.0)   # not invoiced yet
    _seed_punch(ids, j1, hours=3.0, break_minutes=30)   # 2.5 worked hours
    _seed_punch(ids, j2, hours=1.5)                     # 1.5 worked hours

    api = _as(_Admin())
    body, row = _econ_row(api, pid)
    assert row is not None
    assert row["revenue_paid"] == 300.0
    assert row["revenue_invoiced"] == 500.0     # paid + sent, draft excluded
    assert row["invoice_count"] == 2
    assert row["visits"] == 2                   # completed only
    # crew_hours and effective_hourly are gone with the employee model: a
    # subcontractor is paid for the job, not the hour, so there are no hours to
    # divide revenue by — and a "$/hr" for a sub would derive exactly the
    # number this arrangement must never be priced on.
    assert "crew_hours" not in row
    assert "effective_hourly" not in row
    assert row["client_id"] == cid
    assert body["window_days"] == 90


def test_property_economics_no_hours_and_shape(ids):
    """No punches → effective_hourly is None (never a divide-by-zero rate);
    and the row carries ONLY the whitelisted aggregate keys — no access
    details (door codes, wifi, notes) can ride along."""
    cid, pid = _seed_property(ids)
    j = _seed_job(ids, cid, pid)
    _seed_invoice(ids, cid, j, status="paid", total=150.0)

    api = _as(_Admin())
    _, row = _econ_row(api, pid)
    assert row is not None
    assert set(row.keys()) == {
        "property_id", "property_name", "property_type", "client_id",
        "invoice_count", "revenue_paid", "revenue_invoiced", "visits",
    }


def test_property_economics_tenant_scope(ids):
    """Another org's property never appears in org 1's payload."""
    cid2, pid2 = _seed_property(ids, org_id=2)
    j2 = _seed_job(ids, cid2, pid2, org_id=2)
    _seed_invoice(ids, cid2, j2, org_id=2, status="paid", total=5000.0)

    api = _as(_Admin())
    _, row = _econ_row(api, pid2)
    assert row is None


def test_property_economics_role_gate(ids):
    """Per-property financials are owner-facing: viewers are refused, same
    as /api/dashboard/owner."""
    api = _as(_Viewer())
    assert api.get("/api/dashboard/property-economics").status_code == 403


# ── week capacity ───────────────────────────────────────────────────────────

def _snapshot(api):
    r = api.get("/api/dashboard/week-capacity")
    assert r.status_code == 200
    return r.json()


def _seed_cleaner(ids, *, week=None):
    """A roster cleaner (org 1) with an optional explicit week-availability
    row for the CURRENT week. Returns the crew id."""
    crew_id = f"cap-{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    u = User(email=f"{crew_id}@example.com", full_name=f"Cap {crew_id}",
             role="cleaner", active=True, status="active", org_id=1,
             cleaner_id=crew_id)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id)
    if week is not None:
        row = CleanerWeekAvailability(org_id=1, cleaner_id=crew_id,
                                      week_start=week_monday(business_today()),
                                      week=week)
        db.add(row); db.commit(); db.refresh(row)
        ids["weeks"].append(row.id)
    db.close()
    return crew_id


def test_week_capacity_booked_and_available_deltas(ids):
    api = _as(_Admin())
    before = _snapshot(api)
    assert before["week_start"] == week_monday(business_today()).isoformat()

    # One cleaner available AM-only every day → 7 × 4h = 28h.
    _seed_cleaner(ids, week={d: ["am"] for d in
                             ("mon", "tue", "wed", "thu", "fri", "sat", "sun")})
    # One 3h job today (9–12).
    cid, pid = _seed_property(ids)
    _seed_job(ids, cid, pid, status="scheduled", scheduled=business_today(),
              start=time(9, 0), end=time(12, 0))
    # A cancelled job must not count.
    _seed_job(ids, cid, pid, status="cancelled", scheduled=business_today(),
              start=time(9, 0), end=time(17, 0))

    after = _snapshot(api)
    assert round(after["available_hours"] - before["available_hours"], 1) == 28.0
    assert round(after["booked_hours"] - before["booked_hours"], 1) == 3.0

    today_iso = business_today().isoformat()
    day_before = next(d for d in before["days"] if d["date"] == today_iso)
    day_after = next(d for d in after["days"] if d["date"] == today_iso)
    assert round(day_after["booked_hours"] - day_before["booked_hours"], 1) == 3.0
    assert day_after["jobs"] - day_before["jobs"] == 1


def test_week_capacity_time_off_zeroes_the_day(ids):
    api = _as(_Admin())
    crew_id = _seed_cleaner(ids, week={d: ["am", "pm"] for d in
                                       ("mon", "tue", "wed", "thu", "fri", "sat", "sun")})
    before = _snapshot(api)

    db = SessionLocal()
    off = CleanerTimeOff(org_id=1, cleaner_id=crew_id, status="approved",
                         start_date=business_today(), end_date=business_today())
    db.add(off); db.commit(); db.refresh(off)
    ids["timeoff"].append(off.id); db.close()

    after = _snapshot(api)
    # Approved day off removes that day's 8h (am+pm) from availability.
    assert round(before["available_hours"] - after["available_hours"], 1) == 8.0


def test_week_capacity_no_pattern_assumes_full_time(ids):
    api = _as(_Admin())
    before = _snapshot(api)
    _seed_cleaner(ids, week=None)   # roster cleaner with no availability data
    after = _snapshot(api)
    assert round(after["available_hours"] - before["available_hours"], 1) == 56.0  # 7 × 8h
    assert after["crew_without_pattern"] - before["crew_without_pattern"] == 1
    assert after["crew_count"] - before["crew_count"] == 1


def test_week_capacity_viewer_allowed(ids):
    """No financials in the capacity payload — viewers may read it."""
    api = _as(_Viewer())
    assert api.get("/api/dashboard/week-capacity").status_code == 200
