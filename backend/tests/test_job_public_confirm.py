"""Coverage for the Job public confirm-link feature (Part 2 Tier 2): a
customer following the reminder SMS link can view their visit, confirm it,
or flag a reschedule request that lands in the staff queue (does not
auto-move the job) — mirrors the Quote public_token pattern.
"""
import uuid
from datetime import date, time
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Activity, Client, Job, Property

client = TestClient(app)


def _seed(db):
    c = Client(name=f"ConfirmOwner {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="42 Confirm Ave",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Confirm Job",
            job_type="residential", scheduled_date=date(2026, 9, 1),
            start_time=time(9, 0), end_time=time(11, 0), status="scheduled")
    db.add(j); db.commit(); db.refresh(j)
    return c, p, j


def _cleanup(db, c, p, j):
    db.query(Activity).filter(Activity.job_id == j.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_public_view_generates_token_lazily_via_reminder_and_serves_job():
    """The token doesn't exist until something needs it (here: simulating the
    reminder path) — /public/{token} must serve the job once one exists."""
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from services.reminder_service import _job_confirm_url
        url = _job_confirm_url(j)
        db.commit()
        assert j.public_token and j.public_token in url

        r = client.get(f"/api/jobs/public/{j.public_token}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["title"] == "Confirm Job"
        assert body["scheduled_date"] == "2026-09-01"
        assert body["address"] == "42 Confirm Ave"
        assert body["customer_confirmed_at"] is None
        assert body["is_cancelled"] is False
    finally:
        _cleanup(db, c, p, j)


def test_public_view_unknown_token_404s():
    r = client.get("/api/jobs/public/does-not-exist")
    assert r.status_code == 404


def test_public_confirm_sets_confirmed_at_and_logs_activity():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j)
        db.commit()

        r = client.post(f"/api/jobs/public/{token}/confirm")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "confirmed"

        db.refresh(j)
        assert j.customer_confirmed_at is not None
        activities = db.query(Activity).filter(
            Activity.job_id == j.id, Activity.activity_type == "job_customer_confirmed"
        ).all()
        assert len(activities) == 1
    finally:
        _cleanup(db, c, p, j)


def test_public_confirm_is_idempotent():
    """A second confirm click (double-tap) must not double-log or move the
    timestamp — same idempotency guarantee as the quote accept endpoint."""
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j)
        db.commit()

        r1 = client.post(f"/api/jobs/public/{token}/confirm")
        db.refresh(j)
        first_ts = j.customer_confirmed_at
        r2 = client.post(f"/api/jobs/public/{token}/confirm")
        db.refresh(j)

        assert r1.status_code == 200 and r2.status_code == 200
        assert j.customer_confirmed_at == first_ts
        activities = db.query(Activity).filter(
            Activity.job_id == j.id, Activity.activity_type == "job_customer_confirmed"
        ).all()
        assert len(activities) == 1
    finally:
        _cleanup(db, c, p, j)


def test_public_confirm_rejects_cancelled_job():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j)
        j.status = "cancelled"
        db.commit()

        r = client.post(f"/api/jobs/public/{token}/confirm")
        assert r.status_code == 409
    finally:
        _cleanup(db, c, p, j)


def test_public_request_reschedule_does_not_move_the_job():
    """A reschedule request must queue for staff, not auto-change the date —
    the roadmap doc's explicit 'requests land in your queue' requirement."""
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j)
        db.commit()

        r = client.post(
            f"/api/jobs/public/{token}/request-reschedule",
            json={"message": "Can we move to next Tuesday?"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "received"

        db.refresh(j)
        assert j.reschedule_requested_at is not None
        assert j.reschedule_request_message == "Can we move to next Tuesday?"
        # The job itself is untouched.
        assert str(j.scheduled_date) == "2026-09-01"
        assert j.status == "scheduled"

        activities = db.query(Activity).filter(
            Activity.job_id == j.id, Activity.activity_type == "job_reschedule_requested"
        ).all()
        assert len(activities) == 1
        assert "next Tuesday" in activities[0].summary
    finally:
        _cleanup(db, c, p, j)


def test_public_request_reschedule_without_message_still_records():
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from modules.scheduling.router import _ensure_job_public_token
        token = _ensure_job_public_token(j)
        db.commit()

        r = client.post(f"/api/jobs/public/{token}/request-reschedule", json={})
        assert r.status_code == 200, r.text
        db.refresh(j)
        assert j.reschedule_requested_at is not None
        assert j.reschedule_request_message is None
    finally:
        _cleanup(db, c, p, j)


def test_reminder_body_includes_confirm_link_and_generates_token_once():
    """build_reminder_body must append a working confirm link, and reuse the
    same token on a second call rather than minting a new one each time."""
    db = SessionLocal()
    c, p, j = _seed(db)
    try:
        from services.reminder_service import build_reminder_body
        body1 = build_reminder_body(j, c)
        token1 = j.public_token
        db.commit()
        assert token1 and token1 in body1
        assert "Confirm or request a change" in body1

        body2 = build_reminder_body(j, c)
        assert j.public_token == token1
        assert token1 in body2
    finally:
        _cleanup(db, c, p, j)
