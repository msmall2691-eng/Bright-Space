"""Recurring schedule "Ends" (Google-Calendar-style: Never / On date / After
N occurrences) — Tier 5-ish follow-up requested directly from production
feedback ("are there good recurring scheduling like Google calendar has").

series_end_date remains the single exclusive-boundary column
generate_dates() enforces; series_end_occurrences is purely for round-trip
display fidelity when ends_mode='after_count'. ends_mode/ends_on/
ends_after_count are request-only fields translated by _apply_ends_fields
(modules/recurring/router.py) — never real RecurringSchedule columns.
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, RecurringSchedule, Job, RecurrenceException, Activity

api = TestClient(app)


@pytest.fixture(autouse=True)
def _no_gcal_push():
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


@pytest.fixture
def seeded():
    db = SessionLocal()
    c = Client(name=f"EndsTest {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Ends Home", address="1 Ends Way",
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
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _make_schedule(db, client, prop, *, days_of_week=None, frequency="weekly", interval_weeks=1):
    today_dow = date.today().weekday()
    sched = RecurringSchedule(
        client_id=client.id, property_id=prop.id, job_type="residential",
        title="Ends Test Clean", address=prop.address,
        frequency=frequency, interval_weeks=interval_weeks,
        days_of_week=days_of_week or [today_dow], day_of_week=(days_of_week or [today_dow])[0],
        start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=["c1"],
        generate_weeks_ahead=8, active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    return sched


def _base_create_payload(client, prop, **overrides):
    payload = {
        "client_id": client.id, "job_type": "residential", "title": "New Recurring",
        "address": prop.address, "frequency": "weekly", "interval_weeks": 1,
        "days_of_week": [date.today().weekday()],
        "start_time": "09:00", "end_time": "11:00",
        "cleaner_ids": [], "property_id": prop.id, "generate_weeks_ahead": 8,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# create_schedule
# ---------------------------------------------------------------------------
def test_create_without_ends_defaults_to_never(seeded):
    db, c, p = seeded
    r = api.post("/api/recurring", json=_base_create_payload(c, p))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ends_mode"] == "never"
    assert body["series_end_date"] is None
    assert body["ends_on"] is None


def test_create_with_ends_on_date(seeded):
    db, c, p = seeded
    target = (date.today() + timedelta(days=60)).isoformat()
    r = api.post("/api/recurring", json=_base_create_payload(
        c, p, ends_mode="on_date", ends_on=target,
    ))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ends_mode"] == "on_date"
    assert body["ends_on"] == target
    # series_end_date is the exclusive boundary — one day after the
    # user-facing (inclusive) ends_on.
    assert body["series_end_date"] == (date.today() + timedelta(days=61)).isoformat()


def test_create_with_ends_after_count(seeded):
    db, c, p = seeded
    today_dow = date.today().weekday()
    r = api.post("/api/recurring", json=_base_create_payload(
        c, p, days_of_week=[today_dow], ends_mode="after_count", ends_after_count=3,
    ))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ends_mode"] == "after_count"
    assert body["series_end_occurrences"] == 3
    # 3rd weekly occurrence on today's weekday = today + 14 days.
    expected_3rd = date.today() + timedelta(days=14)
    assert body["ends_on"] == expected_3rd.isoformat()


def test_create_ends_on_date_requires_ends_on(seeded):
    db, c, p = seeded
    r = api.post("/api/recurring", json=_base_create_payload(c, p, ends_mode="on_date"))
    assert r.status_code == 400


def test_create_ends_after_count_rejects_zero(seeded):
    db, c, p = seeded
    r = api.post("/api/recurring", json=_base_create_payload(c, p, ends_mode="after_count", ends_after_count=0))
    assert r.status_code == 400


def test_create_invalid_ends_mode_rejected(seeded):
    db, c, p = seeded
    r = api.post("/api/recurring", json=_base_create_payload(c, p, ends_mode="whenever"))
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# update_schedule
# ---------------------------------------------------------------------------
def test_update_sets_ends_on_date(seeded):
    db, c, p = seeded
    sched = _make_schedule(db, c, p)
    target = (date.today() + timedelta(days=30)).isoformat()
    r = api.patch(f"/api/recurring/{sched.id}", json={"ends_mode": "on_date", "ends_on": target})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ends_mode"] == "on_date"
    assert body["ends_on"] == target


def test_update_omitting_ends_mode_leaves_existing_end_untouched(seeded):
    db, c, p = seeded
    sched = _make_schedule(db, c, p)
    target = (date.today() + timedelta(days=30)).isoformat()
    api.patch(f"/api/recurring/{sched.id}", json={"ends_mode": "on_date", "ends_on": target})

    r = api.patch(f"/api/recurring/{sched.id}", json={"notes": "unrelated edit"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ends_mode"] == "on_date"
    assert body["ends_on"] == target
    assert body["notes"] == "unrelated edit"


def test_update_clears_end_back_to_never(seeded):
    db, c, p = seeded
    sched = _make_schedule(db, c, p)
    target = (date.today() + timedelta(days=30)).isoformat()
    api.patch(f"/api/recurring/{sched.id}", json={"ends_mode": "on_date", "ends_on": target})

    r = api.patch(f"/api/recurring/{sched.id}", json={"ends_mode": "never"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ends_mode"] == "never"
    assert body["series_end_date"] is None
    assert body["series_end_occurrences"] is None


def test_update_after_count_reflects_new_interval_from_same_request(seeded):
    """Changing interval_weeks AND setting ends_after_count in the same PATCH
    must compute the count against the NEW interval, not the schedule's
    prior (pre-edit) one — _apply_ends_fields runs after the generic field
    loop, not before it."""
    db, c, p = seeded
    today_dow = date.today().weekday()
    sched = _make_schedule(db, c, p, frequency="weekly", interval_weeks=1, days_of_week=[today_dow])

    r = api.patch(f"/api/recurring/{sched.id}", json={
        "interval_weeks": 2,  # weekly -> biweekly, same request as the count
        "ends_mode": "after_count", "ends_after_count": 3,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["interval_weeks"] == 2
    assert body["series_end_occurrences"] == 3
    # Biweekly: 3rd occurrence = today + 2*2 weeks = today + 28 days (had this
    # used the stale weekly interval it would be today + 14 days instead).
    expected_3rd = date.today() + timedelta(days=28)
    assert body["ends_on"] == expected_3rd.isoformat()


def test_update_ends_after_count_rejects_negative(seeded):
    db, c, p = seeded
    sched = _make_schedule(db, c, p)
    r = api.patch(f"/api/recurring/{sched.id}", json={"ends_mode": "after_count", "ends_after_count": -1})
    assert r.status_code == 400


def test_update_ends_invalid_mode_rejected(seeded):
    db, c, p = seeded
    sched = _make_schedule(db, c, p)
    r = api.patch(f"/api/recurring/{sched.id}", json={"ends_mode": "sometimes"})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# split: confirm sched_to_dict's derived ends_mode/ends_on read a
# split-created series_end_date correctly (pure display derivation, not a
# code path _apply_ends_fields touches at all).
# ---------------------------------------------------------------------------
def test_split_result_reads_as_on_date_with_no_occurrence_count(seeded):
    db, c, p = seeded
    sched = _make_schedule(db, c, p)
    split_date = date.today() + timedelta(days=21)
    r = api.post(f"/api/recurring/{sched.id}/split", json={"split_date": split_date.isoformat()})
    assert r.status_code == 201, r.text

    db.expire_all()
    old = db.query(RecurringSchedule).filter(RecurringSchedule.id == sched.id).first()
    from modules.recurring.router import sched_to_dict
    old_dict = sched_to_dict(old)
    assert old_dict["ends_mode"] == "on_date"
    assert old_dict["series_end_occurrences"] is None
    # split_date itself is exclusive — the old series' last real occurrence
    # is the day before it.
    assert old_dict["ends_on"] == (split_date - timedelta(days=1)).isoformat()
