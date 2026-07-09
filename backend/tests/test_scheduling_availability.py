"""Coverage for the two "is this slot free?" endpoints JobEditModal calls
while editing: GET /api/jobs/cleaner-availability (pre-existing) and
GET /api/jobs/property-availability (new — Tier 1 roadmap item: soft warning
for a property already double-booked, independent of which cleaner is
assigned or the job_type).

Also pins the _overlaps() fix: cleaner_availability had NO test coverage at
all, and comparing a raw "HH:MM" start/end query param against a real
Job.start_time/end_time `time` object raised TypeError — a 500 — in exactly
the case the endpoint exists to detect (a genuine same-day conflict).
"""
import uuid
from datetime import date, time
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property

client = TestClient(app)
OTHER_ORG = 99999


def _seed(db, org_id=None):
    c = Client(name=f"AvailOwner {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Avail St",
                 property_type="residential", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    return c, p


def _make_job(db, c, p, *, start=time(9, 0), end=time(11, 0), cleaner_ids=None,
              status="scheduled", org_id=None, sched_date=None):
    j = Job(client_id=c.id, property_id=p.id, title="Existing Job",
            job_type="residential", scheduled_date=sched_date or date(2026, 8, 1),
            start_time=start, end_time=end, status=status,
            cleaner_ids=cleaner_ids or [], org_id=org_id)
    db.add(j); db.commit(); db.refresh(j)
    return j


def _cleanup(db, c, p, jobs):
    for j in jobs:
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


# ---------------------------------------------------------------------------
# _overlaps bug fix: cleaner-availability must not 500 on a genuine conflict
# ---------------------------------------------------------------------------
def test_cleaner_availability_with_start_end_does_not_500_on_real_conflict():
    db = SessionLocal()
    c, p = _seed(db)
    existing = _make_job(db, c, p, start=time(9, 0), end=time(11, 0), cleaner_ids=["cleaner-1"])
    try:
        r = client.get(
            f"/api/jobs/cleaner-availability?date=2026-08-01&start=10:00&end=12:00"
        )
        assert r.status_code == 200, r.text
        rows = {row["cleaner_id"]: row for row in r.json()}
        assert rows["cleaner-1"]["status"] == "conflict"
        assert rows["cleaner-1"]["conflict_job_id"] == existing.id
    finally:
        _cleanup(db, c, p, [existing])


def test_cleaner_availability_with_start_end_reports_same_day_not_conflict():
    """A same-day job that DOESN'T overlap the requested window is 'same_day',
    not 'conflict' — this branch also runs _overlaps and used to 500."""
    db = SessionLocal()
    c, p = _seed(db)
    existing = _make_job(db, c, p, start=time(9, 0), end=time(11, 0), cleaner_ids=["cleaner-2"])
    try:
        r = client.get(
            f"/api/jobs/cleaner-availability?date=2026-08-01&start=13:00&end=15:00"
        )
        assert r.status_code == 200, r.text
        rows = {row["cleaner_id"]: row for row in r.json()}
        assert rows["cleaner-2"]["status"] == "same_day"
    finally:
        _cleanup(db, c, p, [existing])


# ---------------------------------------------------------------------------
# property-availability: the new soft-warning endpoint
# ---------------------------------------------------------------------------
def test_property_availability_no_conflicts_on_empty_day():
    db = SessionLocal()
    c, p = _seed(db)
    try:
        r = client.get(f"/api/jobs/property-availability?property_id={p.id}&date=2026-08-01")
        assert r.status_code == 200, r.text
        assert r.json()["conflicts"] == []
    finally:
        _cleanup(db, c, p, [])


def test_property_availability_reports_overlapping_job():
    db = SessionLocal()
    c, p = _seed(db)
    existing = _make_job(db, c, p, start=time(9, 0), end=time(11, 0))
    try:
        r = client.get(
            f"/api/jobs/property-availability?property_id={p.id}&date=2026-08-01"
            f"&start=10:00&end=12:00"
        )
        assert r.status_code == 200, r.text
        conflicts = r.json()["conflicts"]
        assert len(conflicts) == 1
        assert conflicts[0]["job_id"] == existing.id
        assert conflicts[0]["overlaps"] is True
    finally:
        _cleanup(db, c, p, [existing])


def test_property_availability_reports_non_overlapping_job_as_not_overlaps():
    db = SessionLocal()
    c, p = _seed(db)
    existing = _make_job(db, c, p, start=time(9, 0), end=time(11, 0))
    try:
        r = client.get(
            f"/api/jobs/property-availability?property_id={p.id}&date=2026-08-01"
            f"&start=13:00&end=15:00"
        )
        assert r.status_code == 200, r.text
        conflicts = r.json()["conflicts"]
        assert len(conflicts) == 1
        assert conflicts[0]["overlaps"] is False
    finally:
        _cleanup(db, c, p, [existing])


def test_property_availability_excludes_cancelled_jobs():
    db = SessionLocal()
    c, p = _seed(db)
    existing = _make_job(db, c, p, status="cancelled")
    try:
        r = client.get(f"/api/jobs/property-availability?property_id={p.id}&date=2026-08-01")
        assert r.json()["conflicts"] == []
    finally:
        _cleanup(db, c, p, [existing])


def test_property_availability_excludes_self_via_exclude_job_id():
    db = SessionLocal()
    c, p = _seed(db)
    existing = _make_job(db, c, p)
    try:
        r = client.get(
            f"/api/jobs/property-availability?property_id={p.id}&date=2026-08-01"
            f"&exclude_job_id={existing.id}"
        )
        assert r.json()["conflicts"] == []
    finally:
        _cleanup(db, c, p, [existing])


def test_property_availability_scoped_to_org():
    db = SessionLocal()
    c, p = _seed(db, org_id=OTHER_ORG)
    existing = _make_job(db, c, p, org_id=OTHER_ORG)
    try:
        r = client.get(f"/api/jobs/property-availability?property_id={p.id}&date=2026-08-01")
        assert r.status_code == 200, r.text
        assert r.json()["conflicts"] == [], \
            "cross-tenant job leaked into another org's property-availability check"
    finally:
        _cleanup(db, c, p, [existing])
