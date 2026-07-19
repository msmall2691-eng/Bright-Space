"""Manual Connecteam dispatch + duplicate/orphan schedule audit."""
from datetime import date, time

import modules.settings.router as sr
from database.db import SessionLocal
from database.models import Client, Property, Job
from modules.scheduling.router import find_schedule_issues


def _mk_client(db, name="Audit Test"):
    c = Client(name=name, email=f"{name.replace(' ', '').lower()}@x.co", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Test St")
    db.add(p); db.commit(); db.refresh(p)
    return c, p


def test_auto_dispatch_on_by_default(monkeypatch):
    monkeypatch.setattr(sr, "get_setting", lambda db, k: None)
    assert sr.connecteam_auto_dispatch_enabled(None) is True   # LIVE push by default
    monkeypatch.setattr(sr, "get_setting", lambda db, k: "false")
    assert sr.connecteam_auto_dispatch_enabled(None) is False  # explicit manual mode


def test_find_duplicate_jobs():
    db = SessionLocal()
    try:
        c, p = _mk_client(db, "Dupe Client")
        common = dict(client_id=c.id, property_id=p.id, title="Clean", job_type="residential",
                      scheduled_date=date(2026, 8, 20), start_time=time(10, 0), end_time=time(13, 0),
                      status="scheduled")
        j1 = Job(**common); j2 = Job(**common)
        # A different time for the same client should NOT be flagged.
        j3 = Job(**{**common, "start_time": time(14, 0)})
        db.add_all([j1, j2, j3]); db.commit()
        for j in (j1, j2, j3):
            db.refresh(j)
        issues = find_schedule_issues(db)
        dupe_ids = {tuple(sorted(g["job_ids"])) for g in issues["duplicate_jobs"]}
        assert tuple(sorted([j1.id, j2.id])) in dupe_ids
        assert all(j3.id not in g["job_ids"] for g in issues["duplicate_jobs"])
    finally:
        db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_find_orphaned_shifts():
    db = SessionLocal()
    try:
        c, p = _mk_client(db, "Orphan Client")
        # Cancelled job that still carries a Connecteam shift id = orphan.
        j = Job(client_id=c.id, property_id=p.id, title="Clean", job_type="residential",
                scheduled_date=date(2026, 8, 21), start_time=time(10, 0), end_time=time(13, 0),
                status="cancelled", connecteam_shift_ids=["shift-123"])
        db.add(j); db.commit(); db.refresh(j)
        issues = find_schedule_issues(db)
        assert any(o["job_id"] == j.id for o in issues["orphaned_shifts"])
        assert issues["counts"]["orphaned_shifts"] >= 1
    finally:
        db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
