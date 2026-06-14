"""Tests for the unified job timeline endpoint (Pillar 3 connective tissue).

GET /api/jobs/{id}/timeline merges three existing sources — Activity,
IntegrationEvent, and Message — into one newest-first feed. Covers:
- the three sources are merged and normalised to a common shape
- entries are ordered newest-first
- the `source` filter narrows to a single kind
- a missing job 404s
"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Property, Job, Activity, IntegrationEvent, Message
from utils.integration_log import log_integration_event
from modules.scheduling.router import get_job_timeline


@pytest.fixture
def job_with_history():
    """A job plus one of each timeline signal, with controlled timestamps."""
    db = SessionLocal()
    c = Client(name="Timeline Test", email="tl@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Test Property", address="1 Test St")
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Timeline Job", job_type="residential")
    db.add(j); db.commit(); db.refresh(j)

    base = datetime(2026, 6, 1, 9, 0, 0)
    # activity (oldest), integration (middle), message (newest)
    db.add(Activity(job_id=j.id, client_id=c.id, activity_type="job_created",
                    summary="Job created", actor="tester", created_at=base))
    db.add(Message(job_id=j.id, client_id=c.id, channel="sms", direction="outbound",
                   body="See you tomorrow!", status="sent", created_at=base + timedelta(hours=2)))
    db.commit()
    # integration event via the helper (its own created_at ~ now, so set explicitly after)
    log_integration_event(db, entity_type="job", entity_id=j.id, provider="gcal",
                          action="create", status="ok", external_id="evt_tl")
    ev = (db.query(IntegrationEvent)
          .filter(IntegrationEvent.entity_type == "job", IntegrationEvent.entity_id == j.id)
          .first())
    ev.created_at = base + timedelta(hours=1)
    db.commit()

    yield db, j
    # cleanup
    db.query(Activity).filter(Activity.job_id == j.id).delete(synchronize_session=False)
    db.query(Message).filter(Message.job_id == j.id).delete(synchronize_session=False)
    db.query(IntegrationEvent).filter(IntegrationEvent.entity_id == j.id).delete(synchronize_session=False)
    db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_timeline_merges_all_sources(job_with_history):
    db, j = job_with_history
    out = get_job_timeline(job_id=j.id, source=None, limit=150, offset=0, db=db, org_id=None)
    # All three signal kinds are merged into one feed (auto-logging may add extra
    # activity rows on job/message create, so assert presence, not an exact count).
    assert out["total"] >= 3
    kinds = {it["kind"] for it in out["items"]}
    assert kinds == {"activity", "integration", "message"}


def test_timeline_newest_first(job_with_history):
    db, j = job_with_history
    out = get_job_timeline(job_id=j.id, source=None, limit=150, offset=0, db=db, org_id=None)
    stamps = [it["created_at"] for it in out["items"]]
    # The feed's contract: strictly newest-first (non-increasing) by created_at.
    assert stamps == sorted(stamps, reverse=True)


def test_timeline_source_filter(job_with_history):
    db, j = job_with_history
    out = get_job_timeline(job_id=j.id, source="integration", limit=150, offset=0, db=db, org_id=None)
    assert out["total"] == 1
    item = out["items"][0]
    assert item["kind"] == "integration"
    assert item["icon_key"] == "gcal"
    assert "Google Calendar" in item["label"] and "succeeded" in item["label"]


def test_timeline_missing_job_404():
    db = SessionLocal()
    try:
        with pytest.raises(HTTPException) as ei:
            get_job_timeline(job_id=999777, source=None, limit=150, offset=0, db=db, org_id=None)
        assert ei.value.status_code == 404
    finally:
        db.close()
