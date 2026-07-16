"""Coverage for customer self-reschedule (the upgrade to Tier 2's confirm
link): a customer following the reminder link can now pick a new open day +
arrival window and actually MOVE their own visit — not just queue a request.
Mirrors the quote self-schedule flow (tests/test_quote_self_schedule.py).
"""
import uuid
from datetime import date, time, timedelta
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Activity, Client, Job, Property
from utils.dates import business_today

client = TestClient(app)


def _seed(db, sched=date(2026, 9, 1)):
    c = Client(name=f"ReschedOwner {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="42 Reschedule Ave",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Reschedule Job",
            job_type="residential", scheduled_date=sched,
            start_time=time(14, 0), end_time=time(16, 0), status="scheduled")
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def _cleanup(db, c, p, j):
    db.query(Activity).filter(Activity.job_id == j.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _next_open_day(min_lead=2):
    """First non-Sunday date at least `min_lead` days out (roster is empty in
    tests, so every business day is available)."""
    d = business_today() + timedelta(days=min_lead)
    while d.weekday() == 6:  # Sunday closed
        d += timedelta(days=1)
    return d


def _set_self_reschedule(enabled: bool):
    from database.db import SessionLocal as _S
    from modules.settings.router import set_setting
    s = _S()
    set_setting(s, "customer_self_reschedule", "true" if enabled else "false")
    s.commit(); s.close()


def test_availability_lists_open_days_and_windows():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j); db.commit()
        _set_self_reschedule(True)

        r = client.get(f"/api/jobs/public/{token}/availability")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["enabled"] is True
        assert {w["key"] for w in body["windows"]} == {"morning", "afternoon"}
        target = _next_open_day()
        hit = next((d for d in body["dates"] if d["date"] == target.isoformat()), None)
        assert hit is not None, f"{target} missing from {[d['date'] for d in body['dates']]}"
        assert "morning" in hit["windows"]
    finally:
        _cleanup(db, c, p, j)


def test_self_reschedule_moves_the_job_and_confirms():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j); db.commit()
        _set_self_reschedule(True)
        target = _next_open_day()

        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "morning"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "rescheduled"
        assert body["date"] == target.isoformat()

        db.refresh(j)
        assert str(j.scheduled_date) == target.isoformat()
        assert str(j.start_time) == "09:00:00"
        assert str(j.end_time) == "12:00:00"
        # A self-move re-confirms and clears any pending request.
        assert j.customer_confirmed_at is not None
        assert j.reschedule_requested_at is None
        acts = db.query(Activity).filter(
            Activity.job_id == j.id,
            Activity.activity_type == "job_customer_rescheduled").all()
        assert len(acts) == 1
    finally:
        _cleanup(db, c, p, j)


def test_self_reschedule_clears_prior_request():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j)
        # Customer first sent a request, then decides to self-serve.
        j.reschedule_requested_at = business_today()  # any non-null
        j.reschedule_request_message = "call me"
        db.commit()
        _set_self_reschedule(True)
        target = _next_open_day()

        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "afternoon"})
        assert r.status_code == 200, r.text
        db.refresh(j)
        assert j.reschedule_requested_at is None
        assert j.reschedule_request_message is None
        assert str(j.start_time) == "13:00:00"
    finally:
        _cleanup(db, c, p, j)


def test_self_reschedule_rejects_past_date():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j); db.commit()
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
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j); db.commit()
        _set_self_reschedule(False)
        target = _next_open_day()

        avail = client.get(f"/api/jobs/public/{token}/availability")
        assert avail.status_code == 200
        assert avail.json()["enabled"] is False
        assert avail.json()["dates"] == []

        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "morning"})
        assert r.status_code == 409
        db.refresh(j)
        assert str(j.scheduled_date) == "2026-09-01"  # untouched
    finally:
        _set_self_reschedule(True)  # restore default for other tests
        _cleanup(db, c, p, j)


def test_self_reschedule_rejects_cancelled_job():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j)
        j.status = "cancelled"; db.commit()
        _set_self_reschedule(True)
        target = _next_open_day()

        r = client.post(f"/api/jobs/public/{token}/reschedule",
                        json={"date": target.isoformat(), "window": "morning"})
        assert r.status_code == 409
    finally:
        _cleanup(db, c, p, j)
