"""Audit #3 Part C completion — calendar-update activity + Gmail connection health.

Part C was largely already built (Gmail→client linking via contact_emails, email
activities, calendar events in the profile timeline). These pin the two gaps that
were closed: an in-place job reschedule now writes an "updated" calendar Activity
(create/cancel were already logged), and a Gmail connection-health endpoint
mirrors gcal-status so an expired grant surfaces a reconnect signal.
"""
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Activity, ActivityType
from utils.activity_logger import log_calendar_event

client = TestClient(app)


def test_calendar_update_writes_timeline_activity():
    db = SessionLocal()
    c = Client(name="Cal Update", status="active")
    db.add(c); db.commit(); db.refresh(c)
    try:
        log_calendar_event(db, "updated", client_id=c.id, job_id=None,
                           title="Cleaning — 4 Red Barn", gcal_event_id="evt_123",
                           scheduled_date="2026-07-01")
        db.commit()
        act = (
            db.query(Activity)
            .filter(Activity.client_id == c.id,
                    Activity.activity_type == ActivityType.JOB_SCHEDULED.value)
            .order_by(Activity.id.desc())
            .first()
        )
        assert act is not None
        assert (act.extra_data or {}).get("action") == "updated"
        assert (act.extra_data or {}).get("source") == "gcal"
    finally:
        db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_gmail_status_endpoint_returns_shape():
    r = client.get("/api/settings/gmail-status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "connected" in body and isinstance(body["accounts"], list)
