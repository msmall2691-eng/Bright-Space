"""Recurrence scope fixes ("this visit only" / "this and all future" /
"all visits" — Jobber parity) plus the org_id IDOR sweep on
modules/recurring/router.py.

Mirrors test_recurrence_phase1.py's pattern: pure/light DB tests run on
SQLite; anything that calls generate_jobs() is gated on Postgres because of
the pre-existing ISO-string-into-Date column issue that file documents.

Covers:
- POST /{schedule_id}/split ends the old schedule at split_date
  (series_end_date) and creates a new schedule from that date with the
  edited rule; unset fields carry over from the old schedule.
- split removes/regenerates the old schedule's own future non-completed,
  non-exception Jobs on/after the split so only the new schedule produces
  there; completed jobs and jobs with an exception are left alone.
- PATCH .../{schedule_id} with resync=true re-syncs already-generated future
  Jobs to the edited rule instead of leaving them stale; resync=false (the
  default) preserves the old rule-only behavior.
- Every recurring endpoint 404s on a schedule that belongs to another org
  (cross-tenant IDOR the sweep found — recurring/router.py had zero org
  scoping at all).
"""
import os
import uuid
import pytest
from datetime import date, time, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
from main import app
from database.db import SessionLocal, engine
from database.models import (
    Base, Client, Property, RecurringSchedule, Job, RecurrenceException,
)
from modules.recurring.router import generate_jobs

api = TestClient(app)
OTHER_ORG = 99999


@pytest.fixture(scope="session", autouse=True)
def _bootstrap_test_schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture(autouse=True)
def _no_gcal_push():
    """generate_jobs() unconditionally tries to push new jobs to Google
    Calendar. The real create_event() already returns None gracefully when
    no credentials are configured (caught RuntimeError from _get_service()),
    but another test module in this same process may have replaced
    sys.modules["integrations.google_calendar"] with a bare MagicMock —
    whose call result is a truthy Mock, not None — which then blows up
    trying to persist a Mock into a String column. Patch explicitly so this
    file's behavior doesn't depend on what other test modules did first."""
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


_REQUIRES_POSTGRES = pytest.mark.skipif(
    "postgres" not in os.environ.get("DATABASE_URL", "").lower(),
    reason=(
        "generate_jobs() relies on Postgres date-string coercion that "
        "SQLite does not perform; run against a Postgres DATABASE_URL."
    ),
)


@pytest.fixture
def fresh_client_property():
    db = SessionLocal()
    c = Client(name=f"SeriesScope {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Series Home", address="3 Series Way",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    yield c, p
    from database.models import Activity
    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id.in_(
            db.query(RecurringSchedule.id).filter(RecurringSchedule.client_id == c.id)
        )
    ).delete(synchronize_session=False)
    # Postgres enforces the activities.job_id FK (no ON DELETE CASCADE);
    # generate_jobs() logs an Activity per created Job, so those must go
    # first or the bulk Job delete below violates the constraint.
    db.query(Activity).filter(
        Activity.job_id.in_(db.query(Job.id).filter(Job.client_id == c.id))
    ).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _make_schedule(db, client, prop, *, org_id=None, days_of_week=None, weeks_ahead=8):
    today_dow = date.today().weekday()
    sched = RecurringSchedule(
        client_id=client.id, property_id=prop.id, job_type="residential",
        title="Series Test Clean", address=prop.address,
        frequency="weekly", interval_weeks=1,
        days_of_week=days_of_week or [today_dow], day_of_week=today_dow,
        start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=["c1"],
        generate_weeks_ahead=weeks_ahead, active=True, org_id=org_id,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    return sched


# ---------------------------------------------------------------------------
# split: series_end_date boundary + new-schedule field carry-over (pure DB)
# ---------------------------------------------------------------------------
def test_split_sets_series_end_date_on_old_schedule(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        split_date = (date.today() + timedelta(days=14)).isoformat()

        r = api.post(f"/api/recurring/{sched.id}/split", json={
            "split_date": split_date, "start_time": "13:00", "end_time": "15:00",
        })
        assert r.status_code == 201, r.text
        db.expire_all()
        old = db.query(RecurringSchedule).filter_by(id=sched.id).first()
        assert old.series_end_date.isoformat() == split_date
    finally:
        db.close()


def test_split_new_schedule_carries_over_unset_fields(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        split_date = (date.today() + timedelta(days=14)).isoformat()

        r = api.post(f"/api/recurring/{sched.id}/split", json={
            "split_date": split_date, "start_time": "13:00", "end_time": "15:00",
        })
        assert r.status_code == 201, r.text
        body = r.json()
        # Overridden
        assert body["start_time"].startswith("13:00")
        assert body["end_time"].startswith("15:00")
        # Carried over unchanged from the old schedule
        assert body["title"] == "Series Test Clean"
        assert body["cleaner_ids"] == ["c1"]
        assert body["frequency"] == "weekly"
        assert body["previous_schedule_id"] == sched.id
    finally:
        db.close()


def test_split_generate_dates_excludes_split_boundary_and_beyond(fresh_client_property):
    from modules.recurring.router import generate_dates
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=8)
        split_date = date.today() + timedelta(days=14)

        api.post(f"/api/recurring/{sched.id}/split", json={"split_date": split_date.isoformat()})
        db.expire_all()
        old = db.query(RecurringSchedule).filter_by(id=sched.id).first()
        dates = generate_dates(old, old.generate_weeks_ahead)
        assert all(d < split_date for d in dates), \
            "old schedule must not generate on/after the split boundary"
    finally:
        db.close()


def test_split_new_schedule_with_changed_weekday_has_no_dates_before_split(fresh_client_property):
    """Regression: generate_dates() always expands from today forward with no
    floor. Splitting a Monday series into (say) a Friday series at a Monday
    two weeks out must NOT start producing Fridays this week — the new
    schedule's series_start_date clamps generation to on/after the split."""
    from modules.recurring.router import generate_dates
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        today_dow = date.today().weekday()
        sched = _make_schedule(db, client, prop, days_of_week=[today_dow], weeks_ahead=8)
        split_date = date.today() + timedelta(days=14)
        new_dow = (today_dow + 2) % 7  # deliberately a different, earlier-in-week day

        r = api.post(f"/api/recurring/{sched.id}/split", json={
            "split_date": split_date.isoformat(),
            "days_of_week": [new_dow], "day_of_week": new_dow,
        })
        assert r.status_code == 201, r.text
        new_id = r.json()["id"]

        db.expire_all()
        new_sched = db.query(RecurringSchedule).filter_by(id=new_id).first()
        assert new_sched.series_start_date == split_date
        dates = generate_dates(new_sched, new_sched.generate_weeks_ahead)
        assert all(d >= split_date for d in dates), \
            "new schedule with a changed weekday must not generate before the split date"
    finally:
        db.close()


# ---------------------------------------------------------------------------
# split: removes/regenerates future Jobs (needs generate_jobs → Postgres only)
# ---------------------------------------------------------------------------
@_REQUIRES_POSTGRES
def test_split_regenerates_future_jobs_under_new_schedule(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=8)
        generate_jobs(db, sched)
        split_date = date.today() + timedelta(days=3)

        r = api.post(f"/api/recurring/{sched.id}/split", json={
            "split_date": split_date.isoformat(), "start_time": "13:00", "end_time": "15:00",
        })
        assert r.status_code == 201, r.text
        new_id = r.json()["id"]

        db.expire_all()
        future_old_jobs = db.query(Job).filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date >= split_date,
        ).count()
        assert future_old_jobs == 0

        future_new_jobs = db.query(Job).filter(
            Job.recurring_schedule_id == new_id,
            Job.scheduled_date >= split_date,
        ).all()
        assert len(future_new_jobs) > 0
        assert all(str(j.start_time)[:5] == "13:00" for j in future_new_jobs)
    finally:
        db.close()


@_REQUIRES_POSTGRES
def test_split_leaves_completed_jobs_alone(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=8)
        generate_jobs(db, sched)
        split_date = date.today() + timedelta(days=3)

        completed = db.query(Job).filter(
            Job.recurring_schedule_id == sched.id,
            Job.scheduled_date >= split_date,
        ).order_by(Job.scheduled_date).first()
        completed_id = completed.id
        completed.status = "completed"
        db.commit()

        r = api.post(f"/api/recurring/{sched.id}/split", json={"split_date": split_date.isoformat()})
        assert r.status_code == 201, r.text

        db.expire_all()
        still_there = db.query(Job).filter_by(id=completed_id).first()
        assert still_there is not None
        assert still_there.recurring_schedule_id == sched.id
    finally:
        db.close()


# ---------------------------------------------------------------------------
# resync: PATCH .../{schedule_id} resync=true re-syncs future Jobs
# ---------------------------------------------------------------------------
@_REQUIRES_POSTGRES
def test_resync_updates_stale_future_jobs_to_new_rule(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=8)
        generate_jobs(db, sched)
        before = db.query(Job).filter(Job.recurring_schedule_id == sched.id).count()
        assert before > 0

        r = api.patch(f"/api/recurring/{sched.id}", json={
            "start_time": "14:30", "end_time": "16:30", "resync": True,
        })
        assert r.status_code == 200, r.text
        assert r.json()["resynced_jobs"] > 0

        db.expire_all()
        jobs = db.query(Job).filter(
            Job.recurring_schedule_id == sched.id,
            Job.status.notin_(("completed", "cancelled")),
        ).all()
        assert jobs
        assert all(str(j.start_time)[:5] == "14:30" for j in jobs)
    finally:
        db.close()


@_REQUIRES_POSTGRES
def test_resync_false_leaves_existing_jobs_stale(fresh_client_property):
    """Default (rule-only) PATCH behavior is unchanged — this is the exact
    Jobber-user surprise the doc calls out, preserved when the caller doesn't
    explicitly opt into resync."""
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=8)
        generate_jobs(db, sched)

        r = api.patch(f"/api/recurring/{sched.id}", json={"start_time": "14:30", "end_time": "16:30"})
        assert r.status_code == 200, r.text
        assert r.json()["resynced_jobs"] == 0

        db.expire_all()
        jobs = db.query(Job).filter(Job.recurring_schedule_id == sched.id).all()
        assert any(str(j.start_time)[:5] == "09:00" for j in jobs), \
            "existing occurrences must keep their old time when resync isn't requested"
    finally:
        db.close()


@_REQUIRES_POSTGRES
def test_resync_does_not_touch_jobs_with_an_exception(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, weeks_ahead=8)
        generate_jobs(db, sched)
        target_job = db.query(Job).filter(
            Job.recurring_schedule_id == sched.id
        ).order_by(Job.scheduled_date).first()
        target_date = target_job.scheduled_date

        db.add(RecurrenceException(
            recurring_schedule_id=sched.id, exception_date=target_date,
            exception_type="reschedule", rescheduled_date=target_date,
            rescheduled_start_time=time(11, 0), rescheduled_end_time=time(12, 0),
        ))
        target_job.start_time = time(11, 0)
        target_job.end_time = time(12, 0)
        db.commit()

        r = api.patch(f"/api/recurring/{sched.id}", json={
            "start_time": "14:30", "end_time": "16:30", "resync": True,
        })
        assert r.status_code == 200, r.text

        db.expire_all()
        preserved = db.query(Job).filter_by(id=target_job.id).first()
        assert preserved is not None
        assert str(preserved.start_time)[:5] == "11:00", \
            "a job with a deliberate per-occurrence exception must survive resync untouched"
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Same-date reschedule (time/crew-only change, no day move) must not cancel
# the occurrence it's retiming — see the header comment on the
# `if _as_date(body.rescheduled_date) != _as_date(body.exception_date)`
# guard in add_reschedule_exception for why this is autoflush-sensitive.
# ---------------------------------------------------------------------------
def test_same_date_reschedule_keeps_job_scheduled_not_cancelled(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)
        target = date.today() + timedelta(days=7)
        job = Job(
            client_id=client.id, property_id=prop.id, recurring_schedule_id=sched.id,
            title="Occurrence", job_type="residential", scheduled_date=target,
            start_time=time(9, 0), end_time=time(11, 0), status="scheduled", cleaner_ids=["101"],
        )
        db.add(job); db.commit(); db.refresh(job)
        job_id = job.id

        r = api.post(f"/api/recurring/{sched.id}/reschedule", json={
            "exception_date": target.isoformat(),
            "rescheduled_date": target.isoformat(),  # same day — time-only change
            "rescheduled_start_time": "13:00",
            "rescheduled_end_time": "15:00",
        })
        assert r.status_code == 201, r.text

        db.expire_all()
        updated = db.query(Job).filter_by(id=job_id).first()
        assert updated is not None
        assert updated.status == "scheduled", \
            "a time-only same-date reschedule must not leave the occurrence cancelled"
        assert str(updated.start_time)[:5] == "13:00"
        assert str(updated.end_time)[:5] == "15:00"
        # No duplicate row for the same schedule+date.
        count = db.query(Job).filter(
            Job.recurring_schedule_id == sched.id, Job.scheduled_date == target,
        ).count()
        assert count == 1
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Timing validation: changing only start (or only end) must not silently
# save an inverted window — the reschedule/split/update endpoints write
# start_time/end_time too but had no equivalent to _validate_job_timing.
# ---------------------------------------------------------------------------
def test_reschedule_rejects_start_after_leftover_series_end(fresh_client_property):
    """Regression: changing only rescheduled_start_time (leaving end unset)
    falls back to the series' own end_time — moving start past THAT must
    400, not silently save an inverted window."""
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)  # 09:00-11:00
        target = date.today() + timedelta(days=7)
        r = api.post(f"/api/recurring/{sched.id}/reschedule", json={
            "exception_date": target.isoformat(),
            "rescheduled_date": target.isoformat(),
            "rescheduled_start_time": "13:00",
        })
        assert r.status_code == 400
        assert "must be after" in r.json()["detail"]
    finally:
        db.close()


def test_split_rejects_inverted_window(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)  # 09:00-11:00
        split_date = date.today() + timedelta(days=14)
        r = api.post(f"/api/recurring/{sched.id}/split", json={
            "split_date": split_date.isoformat(), "start_time": "13:00",
        })
        assert r.status_code == 400
    finally:
        db.close()


def test_update_schedule_rejects_inverted_window(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop)  # 09:00-11:00
        r = api.patch(f"/api/recurring/{sched.id}", json={"start_time": "13:00"})
        assert r.status_code == 400
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Cross-org IDOR: recurring/router.py had zero org scoping before this sweep
# ---------------------------------------------------------------------------
def test_cross_org_get_schedule_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        assert api.get(f"/api/recurring/{sched.id}").status_code == 404
    finally:
        db.close()


def test_cross_org_update_schedule_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        r = api.patch(f"/api/recurring/{sched.id}", json={"notes": "hijacked"})
        assert r.status_code == 404
    finally:
        db.close()


def test_cross_org_delete_schedule_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        assert api.delete(f"/api/recurring/{sched.id}").status_code == 404
    finally:
        db.close()


def test_cross_org_skip_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        r = api.post(f"/api/recurring/{sched.id}/skip",
                     json={"exception_date": date.today().isoformat()})
        assert r.status_code == 404
    finally:
        db.close()


def test_cross_org_reschedule_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        r = api.post(f"/api/recurring/{sched.id}/reschedule", json={
            "exception_date": date.today().isoformat(),
            "rescheduled_date": (date.today() + timedelta(days=1)).isoformat(),
        })
        assert r.status_code == 404
    finally:
        db.close()


def test_cross_org_split_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        r = api.post(f"/api/recurring/{sched.id}/split",
                     json={"split_date": (date.today() + timedelta(days=7)).isoformat()})
        assert r.status_code == 404
    finally:
        db.close()


def test_cross_org_generate_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        assert api.post(f"/api/recurring/{sched.id}/generate").status_code == 404
    finally:
        db.close()


def test_cross_org_list_exceptions_returns_404(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        assert api.get(f"/api/recurring/{sched.id}/exceptions").status_code == 404
    finally:
        db.close()


def test_cross_org_schedule_invisible_in_list(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=OTHER_ORG)
        ids = {row["id"] for row in api.get("/api/recurring").json()}
        assert sched.id not in ids
    finally:
        db.close()


def test_legacy_null_org_schedule_stays_reachable(fresh_client_property):
    client, prop = fresh_client_property
    db = SessionLocal()
    try:
        sched = _make_schedule(db, client, prop, org_id=None)
        assert api.get(f"/api/recurring/{sched.id}").status_code == 200
    finally:
        db.close()
