"""Multi-tenancy MT-2: the job "action" endpoints (complete/skip/invite-client/
auto-assign/crew-suggestions/reminder-settings), the client GCal timeline, and
cleaner time-off must all be scoped to the caller's org.

These endpoints used to do a bare `db.query(Job).filter(Job.id == job_id)
.first()` (or worse, no filter at all) with no org check — a cross-tenant
IDOR: any authenticated caller could act on, or read, another org's data by
guessing/incrementing an id. Same pattern/idiom as test_tenancy_scope_jobs.py:
the master-API-key test caller resolves to the default org, so a row planted
in OTHER_ORG must 404 (not 200/403 — a 403 would confirm the id exists).
"""
import uuid
from datetime import date, time, timedelta
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, CleanerTimeOff

client = TestClient(app)
OTHER_ORG = 99999

# POST /api/jobs refuses a date in the past (400) BEFORE it checks who owns the
# client/property (404). A hardcoded date here is therefore a time bomb: it
# tests tenancy until the calendar passes it, then tests the past-date guard
# instead — same assertion, silently different subject. "2026-09-01" reached
# that day and turned this file red, and the sibling test below survived only
# because its foreign client_id happens to 404 first.
FUTURE_DATE = (date.today() + timedelta(days=30)).isoformat()


def _seed(db, org_id):
    c = Client(name=f"ActionOwner {uuid.uuid4().hex[:6]}", status="active",
               email="owner@example.com", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Action St",
                 property_type="residential", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Scoped Action Job",
            scheduled_date=date(2026, 8, 1),
            start_time=time(9, 0), end_time=time(12, 0),
            status="scheduled", org_id=org_id)
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def _cleanup(db, c, p, j):
    db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_cross_org_complete_returns_404():
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        assert client.post(f"/api/jobs/{j.id}/complete", json={}).status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_skip_returns_404():
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        assert client.post(f"/api/jobs/{j.id}/skip").status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_invite_client_returns_404():
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        assert client.post(f"/api/jobs/{j.id}/invite-client").status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_crew_suggestions_returns_404():
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        assert client.get(f"/api/jobs/{j.id}/crew-suggestions").status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_auto_assign_returns_404():
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        assert client.post(f"/api/jobs/{j.id}/auto-assign").status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_reminder_settings_returns_404():
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        r = client.patch(f"/api/jobs/{j.id}/reminder-settings", json={"skip_reminder": True})
        assert r.status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_gcal_events_returns_404():
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        assert client.get(f"/api/jobs/client/{c.id}/gcal-events").status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_create_job_with_foreign_client_id_returns_404():
    """POST /api/jobs must validate ownership of the caller-supplied client_id —
    previously unchecked, so a user could seed a Job linked to (and leaking the
    name/address of) another org's client."""
    db = SessionLocal()
    c, p, j = _seed(db, OTHER_ORG)
    try:
        r = client.post("/api/jobs", json={
            "client_id": c.id,
            "title": "Should not be creatable",
            "scheduled_date": FUTURE_DATE,
            "start_time": "09:00",
            "end_time": "12:00",
        })
        assert r.status_code == 404
    finally:
        _cleanup(db, c, p, j)


def test_cross_org_create_job_with_foreign_property_id_returns_404():
    """POST /api/jobs must validate ownership of a caller-supplied property_id
    when the caller's own client_id is used but the property belongs to another
    org — previously unchecked."""
    db = SessionLocal()
    other_c, other_p, other_j = _seed(db, OTHER_ORG)
    own_c = Client(name=f"OwnClient {uuid.uuid4().hex[:6]}", status="active")
    db.add(own_c); db.commit(); db.refresh(own_c)
    try:
        r = client.post("/api/jobs", json={
            "client_id": own_c.id,
            "property_id": other_p.id,
            "title": "Should not be creatable",
            "scheduled_date": FUTURE_DATE,
            "start_time": "09:00",
            "end_time": "12:00",
        })
        assert r.status_code == 404
    finally:
        db.query(Client).filter(Client.id == own_c.id).delete(synchronize_session=False)
        db.commit()
        _cleanup(db, other_c, other_p, other_j)


def test_cross_org_time_off_delete_returns_404():
    db = SessionLocal()
    row = CleanerTimeOff(cleaner_id="c1", cleaner_name="Cleaner One",
                         start_date=date(2026, 8, 1), end_date=date(2026, 8, 5),
                         org_id=OTHER_ORG)
    db.add(row); db.commit(); db.refresh(row)
    try:
        assert client.delete(f"/api/jobs/time-off/{row.id}").status_code == 404
    finally:
        db.query(CleanerTimeOff).filter(CleanerTimeOff.id == row.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_cross_org_time_off_is_invisible_in_list():
    db = SessionLocal()
    row = CleanerTimeOff(cleaner_id="c2", cleaner_name="Cleaner Two",
                         start_date=date(2026, 8, 1), end_date=date(2026, 8, 5),
                         org_id=OTHER_ORG)
    db.add(row); db.commit(); db.refresh(row)
    try:
        ids = {r["id"] for r in client.get("/api/jobs/time-off?upcoming_only=false").json()}
        assert row.id not in ids, "cross-tenant time-off entry leaked into the list"
    finally:
        db.query(CleanerTimeOff).filter(CleanerTimeOff.id == row.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_legacy_null_org_action_endpoints_stay_reachable():
    """Legacy NULL-org rows (pre-tenancy data) must stay visible/actionable —
    the permissive or_(org_id == X, org_id.is_(None)) scope, not a strict
    NOT NULL filter."""
    db = SessionLocal()
    c, p, j = _seed(db, None)
    try:
        assert client.post(f"/api/jobs/{j.id}/skip").status_code == 200
    finally:
        _cleanup(db, c, p, j)
