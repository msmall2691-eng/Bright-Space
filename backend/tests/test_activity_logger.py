"""Tests for the centralized activity logger.

Covers:
- log_activity skips orphaned writes (no anchor)
- log_job_created emits a JOB_CREATED row tied to client + job
- log_job_status_change is a no-op when status didn't actually change
- log_email maps direction → EMAIL_SENT / EMAIL_RECEIVED
- log_calendar_event tags extra_data with the gcal event id
- BB-MT-01: Activity.org_id is stamped, either passed explicitly by a caller
  that already has the anchor object, or resolved from the anchor id as a
  fallback — this row used to be left NULL everywhere (audit finding).
"""
import pytest
from datetime import date, time
from database.models import Client, Job, Activity, ActivityType, Property
from database.db import SessionLocal
from utils.activity_logger import (
    log_activity, log_job_created, log_job_status_change,
    log_email, log_calendar_event, log_visit_skipped,
)


@pytest.fixture
def client_and_job():
    db = SessionLocal()
    c = Client(name="Activity Test Client", phone="+12075550111", phone_tail="2075550111",
              status="active", org_id=13)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="123 Test St",
                 property_type="residential", active=True, org_id=13)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(
        client_id=c.id, property_id=p.id, title="Test Job",
        scheduled_date=date.today(), start_time=time(9, 0), end_time=time(11, 0),
        status="scheduled", job_type="residential", org_id=13,
    )
    db.add(j); db.commit(); db.refresh(j)
    yield c, j
    db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    # Property was never cleaned up here before — deleting the Client without
    # it first violated properties_client_id_fkey on Postgres (SQLite doesn't
    # enforce the FK), aborting this whole teardown transaction and leaving
    # every row from the test uncleaned for whatever ran next.
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
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
        # Re-fetch the job into this session; mutating the fixture-session's
        # instance here would dirty that session and StaleData its teardown.
        j = db.query(Job).filter(Job.id == j.id).first()
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
    """log_visit_skipped now takes a Job directly (post-Visit unification)."""
    c, j = client_and_job
    db = SessionLocal()
    try:
        result = log_visit_skipped(db, j, reason="client out of town")
        db.commit()
        assert result is not None
        assert result.activity_type == ActivityType.JOB_CANCELLED.value
        assert result.client_id == c.id
        assert result.extra_data["reason"] == "client out of town"
        assert result.extra_data["single_occurrence"] is True
    finally:
        db.close()


def test_log_job_created_stamps_org_id(client_and_job):
    """BB-MT-01: org_id was never stamped on Activity rows — every write
    left it NULL and surfaced on every workspace's timeline via the
    NULL-tolerant _org() filter. log_job_created passes job.org_id explicitly."""
    c, j = client_and_job
    db = SessionLocal()
    try:
        result = log_job_created(db, j)
        db.commit()
        assert result.org_id == 13
    finally:
        db.close()


def test_log_activity_resolves_org_id_from_client_id_when_not_passed():
    """BB-MT-01 fallback: a caller with no anchor object in hand (only a bare
    client_id, like log_email/log_calendar_event) still gets a stamped row —
    log_activity resolves org_id from the client instead of leaving it NULL."""
    db = SessionLocal()
    c = Client(name="Fallback Org Client", phone="+12075550199",
              phone_tail="2075550199", status="active", org_id=42)
    db.add(c); db.commit(); db.refresh(c)
    try:
        result = log_activity(db, "email_received", client_id=c.id, summary="hi")
        db.commit()
        assert result.org_id == 42
    finally:
        db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_log_activity_explicit_org_id_skips_resolution():
    """An explicit org_id (the common case — callers that already hold the
    anchor object pass it) is used as-is, even for a client in a different org
    than the one passed — proves no silent fallback overrides it."""
    db = SessionLocal()
    c = Client(name="Explicit Org Client", phone="+12075550188",
              phone_tail="2075550188", status="active", org_id=5)
    db.add(c); db.commit(); db.refresh(c)
    try:
        result = log_activity(db, "email_received", client_id=c.id, summary="hi",
                              org_id=99)
        db.commit()
        assert result.org_id == 99
    finally:
        db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit()
        db.close()
