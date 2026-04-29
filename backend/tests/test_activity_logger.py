"""Tests for the centralized activity logger.

Covers:
- log_activity skips orphaned writes (no anchor)
- log_job_created emits a JOB_CREATED row tied to client + job
- log_job_status_change is a no-op when status didn't actually change
- log_email maps direction → EMAIL_SENT / EMAIL_RECEIVED
- log_calendar_event tags extra_data with the gcal event id
"""
import pytest
from datetime import date, time
from database.models import Client, Job, Activity, Visit, ActivityType
from database.db import SessionLocal
from utils.activity_logger import (
    log_activity, log_job_created, log_job_status_change,
    log_email, log_calendar_event, log_visit_skipped,
)


@pytest.fixture
def client_and_job():
    db = SessionLocal()
    c = Client(name="Activity Test Client", phone="+12075550111", phone_tail="2075550111", status="active")
    db.add(c); db.commit(); db.refresh(c)
    j = Job(
        client_id=c.id, title="Test Job",
        scheduled_date=date.today(), start_time=time(9, 0), end_time=time(11, 0),
        status="scheduled", job_type="residential",
    )
    db.add(j); db.commit(); db.refresh(j)
    yield c, j
    db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
    db.query(Visit).filter(Visit.job_id == j.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_log_activity_skips_orphaned_write():
    """Without any anchor (client/opportunity/job) the row is dropped."""
    db = SessionLocal()
    try:
        result = log_activity(db, ActivityType.EMAIL_SENT.value, summary="orphan")
        assert result is None
        # And no row was inserted
        count = db.query(Activity).filter(Activity.summary == "orphan").count()
        assert count == 0
    finally:
        db.close()


def test_log_job_created_writes_row(client_and_job):
    c, j = client_and_job
    db = SessionLocal()
    try:
        log_job_created(db, j)
        db.commit()
        rows = db.query(Activity).filter(
            Activity.client_id == c.id,
            Activity.activity_type == ActivityType.JOB_CREATED.value,
        ).all()
        assert len(rows) == 1
        assert rows[0].job_id == j.id
        assert "Test Job" in rows[0].summary
    finally:
        db.close()


def test_log_job_status_change_no_op_on_same_status(client_and_job):
    c, j = client_and_job
    db = SessionLocal()
    try:
        # status is "scheduled" both before and after — should not log
        result = log_job_status_change(db, j, prev_status="scheduled")
        assert result is None
    finally:
        db.close()


def test_log_job_status_change_logs_completion(client_and_job):
    c, j = client_and_job
    db = SessionLocal()
    try:
        j.status = "completed"
        result = log_job_status_change(db, j, prev_status="scheduled")
        db.commit()
        assert result is not None
        assert result.activity_type == ActivityType.JOB_COMPLETED.value
        assert result.client_id == c.id
        assert result.job_id == j.id
    finally:
        db.close()


def test_log_email_received(client_and_job):
    c, _ = client_and_job
    db = SessionLocal()
    try:
        result = log_email(
            db, "received",
            client_id=c.id, subject="Move-out clean",
            from_email="alice@example.com",
        )
        db.commit()
        assert result is not None
        assert result.activity_type == ActivityType.EMAIL_RECEIVED.value
        assert "alice@example.com" in result.summary
    finally:
        db.close()


def test_log_email_sent(client_and_job):
    c, _ = client_and_job
    db = SessionLocal()
    try:
        result = log_email(
            db, "sent",
            client_id=c.id, subject="Reply: Move-out clean",
            from_email="ops@brightbase.test", to_email="alice@example.com",
        )
        db.commit()
        assert result is not None
        assert result.activity_type == ActivityType.EMAIL_SENT.value
        assert result.extra_data["to"] == "alice@example.com"
    finally:
        db.close()


def test_log_calendar_event_tags_gcal_id(client_and_job):
    c, j = client_and_job
    db = SessionLocal()
    try:
        result = log_calendar_event(
            db, "created",
            client_id=c.id, job_id=j.id,
            title="Test Job", gcal_event_id="abc123",
            scheduled_date=str(date.today()),
        )
        db.commit()
        assert result is not None
        assert result.extra_data["source"] == "gcal"
        assert result.extra_data["gcal_event_id"] == "abc123"
    finally:
        db.close()


def test_log_visit_skipped_carries_reason(client_and_job):
    c, j = client_and_job
    db = SessionLocal()
    try:
        v = Visit(
            job_id=j.id, scheduled_date=date.today(),
            start_time=time(9, 0), end_time=time(11, 0),
            status="cancelled",
        )
        db.add(v); db.commit(); db.refresh(v)
        # The helper expects v.job to be loadable
        v.job  # ensure relationship is hydrated for the helper

        result = log_visit_skipped(db, v, reason="client out of town")
        db.commit()
        assert result is not None
        assert result.activity_type == ActivityType.JOB_CANCELLED.value
        assert result.client_id == c.id
        assert result.extra_data["reason"] == "client out of town"
        assert result.extra_data["single_occurrence"] is True
    finally:
        db.close()
