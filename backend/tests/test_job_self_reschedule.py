"""Customer self-reschedule: open slots move instantly, busy slots (double-book)
are held as a pending approval the owner approves/declines. Recurring visits
carry a this/future scope. Mirrors the quote self-schedule flow."""
import uuid
from datetime import date, time, timedelta
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Activity, Client, Job, Property
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today

client = TestClient(app)


class _Admin:
    id, org_id, role, status, active = 7401, 1, "admin", "active", True
    email = "resched-admin@example.com"


def _seed(db, sched=date(2026, 9, 1), cleaner_ids=None):
    c = Client(name=f"ReschedOwner {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="42 Reschedule Ave",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Portland — Residential Cleaning",
            job_type="residential", scheduled_date=sched,
            start_time=time(14, 0), end_time=time(16, 0), status="scheduled",
            cleaner_ids=cleaner_ids or [], org_id=1)
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def _cleanup(db, c, p, j):
    db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _next_open_day(min_lead=2):
    d = business_today() + timedelta(days=min_lead)
    while d.weekday() == 6:
        d += timedelta(days=1)
    return d


def _set_self_reschedule(enabled: bool):
    from database.db import SessionLocal as _S
    from modules.settings.router import set_setting
    s = _S()
    set_setting(s, "customer_self_reschedule", "true" if enabled else "false")
    s.commit(); s.close()


def _token(j):
    from modules.scheduling.router import _ensure_job_public_token
    db = SessionLocal()
    jj = db.query(Job).filter(Job.id == j.id).first()
    tok = _ensure_job_public_token(jj); db.commit(); db.close()
    return tok


def test_availability_lists_days_with_busy_flags():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        token = _token(j)
        _set_self_reschedule(True)
        r = client.get(f"/api/jobs/public/{token}/availability")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["enabled"] is True
        target = _next_open_day()
        hit = next((d for d in body["dates"] if d["date"] == target.isoformat()), None)
        assert hit is not None
        keys = {w["key"] for w in hit["windows"]}
        assert keys == {"morning", "afternoon"}
        # No crew + no Google → nothing busy.
        assert all(w["busy"] is False for w in hit["windows"])
    finally:
        _cleanup(db, c, p, j)


def test_open_slot_moves_instantly():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        token = _token(j)
        _set_self_reschedule(True)
        target = _next_open_day()
        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "morning"})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "rescheduled"
        db.refresh(j)
        assert str(j.scheduled_date) == target.isoformat()
        assert str(j.start_time) == "09:00:00"
        assert j.customer_confirmed_at is not None
        assert j.reschedule_requested_at is None
    finally:
        _cleanup(db, c, p, j)


def test_busy_slot_holds_for_approval_then_approves():
    """A double-book (crew already booked in the window) is held pending, not
    moved; the owner approves and it lands."""
    db = SessionLocal()
    c, p, j = _seed(db, cleaner_ids=["77"])
    try:
        target = _next_open_day()
        # Block cleaner 77's morning on the target day with another job.
        c2 = Client(name="Other", status="active", org_id=1)
        db.add(c2); db.commit(); db.refresh(c2)
        p2 = Property(client_id=c2.id, name="P2", address="9 Other St",
                      property_type="residential", active=True, org_id=1)
        db.add(p2); db.commit(); db.refresh(p2)
        blocker = Job(client_id=c2.id, property_id=p2.id, title="Blocker",
                      job_type="residential", scheduled_date=target,
                      start_time=time(9, 0), end_time=time(12, 0), status="scheduled",
                      cleaner_ids=["77"], org_id=1)
        db.add(blocker); db.commit(); db.refresh(blocker)

        token = _token(j)
        _set_self_reschedule(True)
        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "morning"})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "pending_approval"
        db.refresh(j)
        # Not moved yet — held.
        assert str(j.scheduled_date) == "2026-09-01"
        assert str(j.reschedule_requested_date) == target.isoformat()

        # Owner approves (admin auth) → the job actually moves.
        app.dependency_overrides[get_current_user] = lambda: _Admin()
        app.dependency_overrides[current_org_id] = lambda: 1
        try:
            ap = client.post(f"/api/jobs/{j.id}/approve-reschedule")
            assert ap.status_code == 200, ap.text
        finally:
            app.dependency_overrides.pop(get_current_user, None)
            app.dependency_overrides.pop(current_org_id, None)
        db.refresh(j)
        assert str(j.scheduled_date) == target.isoformat()
        assert str(j.start_time) == "09:00:00"
        assert j.reschedule_requested_date is None

        db.query(Job).filter(Job.id == blocker.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == p2.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c2.id).delete(synchronize_session=False)
        db.commit()
    finally:
        _cleanup(db, c, p, j)


def test_pending_request_appears_in_queue_and_declines():
    db = SessionLocal()
    c, p, j = _seed(db, cleaner_ids=["88"])
    try:
        target = _next_open_day()
        c2 = Client(name="Other2", status="active", org_id=1)
        db.add(c2); db.commit(); db.refresh(c2)
        p2 = Property(client_id=c2.id, name="P2", address="1 X St",
                      property_type="residential", active=True, org_id=1)
        db.add(p2); db.commit(); db.refresh(p2)
        blocker = Job(client_id=c2.id, property_id=p2.id, title="Blocker",
                      job_type="residential", scheduled_date=target,
                      start_time=time(9, 0), end_time=time(12, 0), status="scheduled",
                      cleaner_ids=["88"], org_id=1)
        db.add(blocker); db.commit()

        token = _token(j)
        _set_self_reschedule(True)
        client.post(f"/api/jobs/public/{token}/reschedule",
                    json={"date": target.isoformat(), "window": "morning"})

        app.dependency_overrides[get_current_user] = lambda: _Admin()
        app.dependency_overrides[current_org_id] = lambda: 1
        try:
            q = client.get("/api/jobs/reschedule-requests")
            assert q.status_code == 200, q.text
            ids = [r["job_id"] for r in q.json()["requests"]]
            assert j.id in ids
            row = next(r for r in q.json()["requests"] if r["job_id"] == j.id)
            assert row["needs_approval"] is True
            assert row["requested_date"] == target.isoformat()

            dec = client.post(f"/api/jobs/{j.id}/decline-reschedule")
            assert dec.status_code == 200, dec.text
        finally:
            app.dependency_overrides.pop(get_current_user, None)
            app.dependency_overrides.pop(current_org_id, None)
        db.refresh(j)
        assert str(j.scheduled_date) == "2026-09-01"  # unmoved
        assert j.reschedule_requested_at is None       # cleared

        db.query(Job).filter(Job.id == blocker.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == p2.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c2.id).delete(synchronize_session=False)
        db.commit()
    finally:
        _cleanup(db, c, p, j)


def test_self_reschedule_rejects_past_date():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        token = _token(j)
        _set_self_reschedule(True)
        yesterday = (business_today() - timedelta(days=1)).isoformat()
        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": yesterday, "window": "morning"})
        assert r.status_code == 400
    finally:
        _cleanup(db, c, p, j)


def test_self_reschedule_disabled_falls_back():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        token = _token(j)
        _set_self_reschedule(False)
        target = _next_open_day()
        avail = client.get(f"/api/jobs/public/{token}/availability")
        assert avail.json()["enabled"] is False
        assert avail.json()["dates"] == []
        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "morning"})
        assert r.status_code == 409
    finally:
        _set_self_reschedule(True)
        _cleanup(db, c, p, j)


def test_self_reschedule_rejects_cancelled_job():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        token = _token(j)
        db.query(Job).filter(Job.id == j.id).update({"status": "cancelled"})
        db.commit()
        _set_self_reschedule(True)
        target = _next_open_day()
        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "morning"})
        assert r.status_code == 409
    finally:
        _cleanup(db, c, p, j)
