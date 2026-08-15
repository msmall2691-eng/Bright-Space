"""Similar-series pre-create guard (services/recurring_guards.py) + split
lineage — the low-risk guards from the data-model review.

- POST /api/recurring 409s with {detail: 'similar_series_exists', matches}
  when a LIVE series already exists for the same client + property +
  frequency + interval + day_of_month + start_time with an OVERLAPPING
  day-of-week set; resubmitting with allow_duplicate=true creates anyway
  (mirrors scheduling's allow_conflicts escape hatch).
- Ended series (series_end_date <= today — how split retires a predecessor)
  and paused series never trip the guard; a future end date still counts as
  live.
- POST /api/recurring/{id}/split's successor carries quote_id and
  opportunity_id from the predecessor (deal-board traceability was severed
  before — carry_over_fields omitted both).
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Activity, Client, Job, Opportunity, Property, Quote,
    RecurrenceException, RecurringSchedule,
)

api = TestClient(app)


@pytest.fixture(autouse=True)
def _no_gcal_push():
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


@pytest.fixture
def seeded():
    db = SessionLocal()
    c = Client(name=f"DupGuard {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Dup Home", address="1408 Elm St",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield db, c, p
    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id.in_(
            db.query(RecurringSchedule.id).filter(RecurringSchedule.client_id == c.id)
        )
    ).delete(synchronize_session=False)
    db.query(Activity).filter(
        Activity.job_id.in_(db.query(Job.id).filter(Job.client_id == c.id))
    ).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _payload(client, prop, **overrides):
    payload = {
        "client_id": client.id, "job_type": "residential", "title": "Dup Test",
        "address": prop.address, "frequency": "biweekly", "interval_weeks": 2,
        "days_of_week": [1],
        "start_time": "09:00", "end_time": "11:00",
        "cleaner_ids": [], "property_id": prop.id, "generate_weeks_ahead": 4,
    }
    payload.update(overrides)
    return payload


def _make_schedule(db, client, prop, **overrides):
    fields = dict(
        client_id=client.id, property_id=prop.id, job_type="residential",
        title="Existing Series", address=prop.address,
        frequency="biweekly", interval_weeks=2,
        days_of_week=[1], day_of_week=1,
        start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=[],
        generate_weeks_ahead=4, active=True,
    )
    fields.update(overrides)
    sched = RecurringSchedule(**fields)
    db.add(sched); db.commit(); db.refresh(sched)
    return sched


# ---------------------------------------------------------------------------
# 409 + override
# ---------------------------------------------------------------------------
def test_matching_create_409s_with_matches(seeded):
    db, c, p = seeded
    r1 = api.post("/api/recurring", json=_payload(c, p))
    assert r1.status_code == 201, r1.text
    first_id = r1.json()["id"]

    r2 = api.post("/api/recurring", json=_payload(c, p))
    assert r2.status_code == 409, r2.text
    detail = r2.json()["detail"]
    assert detail["detail"] == "similar_series_exists"
    match_ids = [m["id"] for m in detail["matches"]]
    assert first_id in match_ids
    # Compact match shape the confirm prompt renders.
    m = next(m for m in detail["matches"] if m["id"] == first_id)
    assert "cadence" in m and "upcoming_job_count" in m
    assert m["property_name"] == "Dup Home"

    # No second row was created.
    count = db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).count()
    assert count == 1


def test_allow_duplicate_overrides_the_guard(seeded):
    db, c, p = seeded
    assert api.post("/api/recurring", json=_payload(c, p)).status_code == 201
    r = api.post("/api/recurring", json=_payload(c, p, allow_duplicate=True))
    assert r.status_code == 201, r.text
    count = db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).count()
    assert count == 2


# ---------------------------------------------------------------------------
# What does / doesn't match
# ---------------------------------------------------------------------------
def test_no_match_passes(seeded):
    db, c, p = seeded
    assert api.post("/api/recurring", json=_payload(c, p)).status_code == 201
    # Different start time → not similar.
    assert api.post("/api/recurring",
                    json=_payload(c, p, start_time="14:00", end_time="16:00")
                    ).status_code == 201
    # Different (missing) property → not similar.
    assert api.post("/api/recurring",
                    json=_payload(c, p, property_id=None)).status_code == 201
    # Non-overlapping day set → not similar.
    assert api.post("/api/recurring",
                    json=_payload(c, p, days_of_week=[4], day_of_week=4)
                    ).status_code == 201
    # Different cadence → not similar.
    assert api.post("/api/recurring",
                    json=_payload(c, p, frequency="weekly", interval_weeks=1)
                    ).status_code == 201


def test_day_overlap_matches(seeded):
    """A new Wednesday series matches an existing Mon/Wed/Fri one — overlap,
    not exact-set equality."""
    db, c, p = seeded
    _make_schedule(db, c, p, days_of_week=[0, 2, 4], day_of_week=0)
    r = api.post("/api/recurring", json=_payload(c, p, days_of_week=[2], day_of_week=2))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["detail"] == "similar_series_exists"


def test_ended_series_does_not_match(seeded):
    """A split-retired predecessor (active=True, series_end_date in the past)
    must not block re-creating — that's exactly the row the review flagged as
    'looks alive'."""
    db, c, p = seeded
    _make_schedule(db, c, p, series_end_date=date.today() - timedelta(days=1))
    r = api.post("/api/recurring", json=_payload(c, p))
    assert r.status_code == 201, r.text


def test_future_end_date_still_matches(seeded):
    """series_end_date in the future = still generating = still a duplicate."""
    db, c, p = seeded
    _make_schedule(db, c, p, series_end_date=date.today() + timedelta(days=60))
    r = api.post("/api/recurring", json=_payload(c, p))
    assert r.status_code == 409, r.text


def test_paused_series_does_not_match(seeded):
    db, c, p = seeded
    _make_schedule(db, c, p, active=False)
    r = api.post("/api/recurring", json=_payload(c, p))
    assert r.status_code == 201, r.text


# ---------------------------------------------------------------------------
# Split lineage (guard 4)
# ---------------------------------------------------------------------------
def test_split_successor_carries_quote_and_opportunity(seeded):
    db, c, p = seeded
    opp = Opportunity(client_id=c.id, title="Recurring Deal", stage="won")
    db.add(opp); db.commit(); db.refresh(opp)
    q = Quote(client_id=c.id, opportunity_id=opp.id,
              quote_number=f"Q-{uuid.uuid4().hex[:8]}", status="accepted", items=[])
    db.add(q); db.commit(); db.refresh(q)
    sched = _make_schedule(db, c, p, quote_id=q.id, opportunity_id=opp.id)

    split_date = (date.today() + timedelta(days=14)).isoformat()
    r = api.post(f"/api/recurring/{sched.id}/split", json={"split_date": split_date})
    assert r.status_code == 201, r.text
    new_id = r.json()["id"]
    assert new_id != sched.id

    db.expire_all()
    successor = db.query(RecurringSchedule).filter_by(id=new_id).first()
    assert successor.quote_id == q.id, \
        "split must carry quote_id onto the successor (lineage was severed before)"
    assert successor.opportunity_id == opp.id, \
        "split must carry opportunity_id onto the successor"
    # The serializer exposes quote_id too, so the response reflects it.
    assert r.json()["quote_id"] == q.id
