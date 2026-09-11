"""POST /api/jobs/bulk-reschedule — the "weather day" / sick-day move
(Tier 4 roadmap): select a set of jobs, shift them all by N days in one
action instead of dragging each one individually.

Recurring occurrences must go through the same reschedule-exception path
as a single "this visit only" edit (_reschedule_occurrence, factored out of
modules/recurring/router.py's add_reschedule_exception) rather than a bare
scheduled_date PATCH — otherwise the next generate_jobs tick would
regenerate the original date alongside the shifted one.
"""
import uuid
from datetime import date, time, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Property, Job, RecurringSchedule, RecurrenceException, Activity,
)

api = TestClient(app)
OTHER_ORG = 99999


@pytest.fixture(autouse=True)
def _no_gcal_push():
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


@pytest.fixture
def seeded():
    db = SessionLocal()
    c = Client(name=f"BulkReschedule {uuid.uuid4().hex[:6]}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="Bulk Home", address="1 Bulk Way",
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


def _make_job(db, c, p, sched_date, status="scheduled", recurring_schedule_id=None,
              cleaner_ids=None):
    j = Job(client_id=c.id, property_id=p.id, title="Bulk Job", job_type="residential",
            scheduled_date=sched_date, start_time=time(9, 0), end_time=time(11, 0),
            status=status, recurring_schedule_id=recurring_schedule_id,
            cleaner_ids=cleaner_ids or [])
    db.add(j); db.commit(); db.refresh(j)
    return j


def test_shift_non_recurring_jobs_forward(seeded):
    db, c, p = seeded
    j1 = _make_job(db, c, p, date(2026, 8, 1))
    j2 = _make_job(db, c, p, date(2026, 8, 1))

    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j1.id, j2.id], "shift_days": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["shifted"] == 2
    assert set(body["shifted_ids"]) == {j1.id, j2.id}
    assert body["skipped"] == []

    db.refresh(j1); db.refresh(j2)
    assert j1.scheduled_date == date(2026, 8, 3)
    assert j2.scheduled_date == date(2026, 8, 3)


def test_shift_backward(seeded):
    db, c, p = seeded
    j = _make_job(db, c, p, date(2026, 8, 10))
    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": -3})
    assert r.status_code == 200, r.text
    db.refresh(j)
    assert j.scheduled_date == date(2026, 8, 7)


def test_shift_skips_cancelled_and_completed(seeded):
    db, c, p = seeded
    cancelled = _make_job(db, c, p, date(2026, 8, 1), status="cancelled")
    completed = _make_job(db, c, p, date(2026, 8, 1), status="completed")
    scheduled = _make_job(db, c, p, date(2026, 8, 1))

    r = api.post("/api/jobs/bulk-reschedule",
                 json={"job_ids": [cancelled.id, completed.id, scheduled.id], "shift_days": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["shifted"] == 1
    assert body["shifted_ids"] == [scheduled.id]
    skipped_ids = {s["job_id"] for s in body["skipped"]}
    assert skipped_ids == {cancelled.id, completed.id}

    db.refresh(cancelled); db.refresh(completed)
    assert cancelled.scheduled_date == date(2026, 8, 1)
    assert completed.scheduled_date == date(2026, 8, 1)


def test_shift_recurring_occurrence_writes_exception_not_bare_patch(seeded):
    """A recurring job's date move must go through the exception path — a
    bare scheduled_date PATCH would let the next generate_jobs tick
    regenerate the original date, duplicating the occurrence."""
    db, c, p = seeded
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, job_type="residential", title="Weekly clean",
        address=p.address, frequency="weekly", day_of_week=5, days_of_week=[5],
        start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=[], active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    occurrence_date = date(2026, 8, 1)  # a Saturday
    j = _make_job(db, c, p, occurrence_date, recurring_schedule_id=sched.id)

    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["shifted"] == 1
    assert body["skipped"] == []

    # An exception now exists recording the move.
    ex = db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id == sched.id,
        RecurrenceException.exception_date == occurrence_date,
    ).first()
    assert ex is not None
    assert ex.exception_type == "reschedule"
    assert ex.rescheduled_date == date(2026, 8, 2)

    # The original job is cancelled (not left dangling on the old date), and
    # a new job exists on the shifted date.
    db.refresh(j)
    assert j.status == "cancelled"
    new_job = db.query(Job).filter(
        Job.recurring_schedule_id == sched.id,
        Job.scheduled_date == date(2026, 8, 2),
        Job.status != "cancelled",
    ).first()
    assert new_job is not None
    assert new_job.start_time == time(9, 0)


# ── crew notice on a bulk move (audit #4) ────────────────────────────────────

def test_bulk_move_sends_one_crew_rollup_and_suppresses_per_job(seeded):
    # A weather-day move of a cleaner's whole day must be ONE "your jobs moved"
    # rollup, not one text per job (brightbase-economy). The one-off branch runs
    # through update_job, whose per-job notice the bulk path suppresses.
    db, c, p = seeded
    j1 = _make_job(db, c, p, date(2026, 8, 1), cleaner_ids=["c1"])
    j2 = _make_job(db, c, p, date(2026, 8, 1), cleaner_ids=["c1"])
    # Read the ids inside the call — the endpoint's session closes after the
    # response, leaving the passed Job objects detached.
    seen = {}

    def _capture(db_, jobs_, org=None):
        seen["ids"] = {j.id for j in jobs_}
        return 0
    with patch("services.crew_notify.notify_job_rescheduled") as per_job, \
         patch("services.crew_notify.notify_jobs_rescheduled_bulk",
               side_effect=_capture) as rollup:
        r = api.post("/api/jobs/bulk-reschedule",
                     json={"job_ids": [j1.id, j2.id], "shift_days": 2})
    assert r.status_code == 200, r.text
    per_job.assert_not_called()                 # no per-job "a job of yours moved"
    assert rollup.call_count == 1               # exactly one rollup for the batch
    assert seen["ids"] == {j1.id, j2.id}


def test_bulk_move_of_recurring_occurrence_notifies_the_crew(seeded):
    # The recurring branch (_reschedule_occurrence) never told the assigned crew
    # anything — audit #4. Funnelling its moved Job into the rollup closes that.
    db, c, p = seeded
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, job_type="residential", title="Weekly clean",
        address=p.address, frequency="weekly", day_of_week=5, days_of_week=[5],
        start_time=time(9, 0), end_time=time(11, 0), cleaner_ids=["c1"], active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    j = _make_job(db, c, p, date(2026, 8, 1), recurring_schedule_id=sched.id,
                  cleaner_ids=["c1"])
    seen = {}

    def _capture(db_, jobs_, org=None):
        seen["n"] = len(jobs_)
        if jobs_:
            seen["cleaners"] = list(jobs_[0].cleaner_ids or [])
            seen["date"] = jobs_[0].scheduled_date
        return 0
    with patch("services.crew_notify.notify_jobs_rescheduled_bulk",
               side_effect=_capture) as rollup:
        r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": 1})
    assert r.status_code == 200, r.text
    assert rollup.call_count == 1
    assert seen["n"] == 1
    assert seen["cleaners"] == ["c1"]
    assert seen["date"] == date(2026, 8, 2)   # the moved occurrence


def test_rollup_helper_sends_one_message_per_cleaner(seeded):
    # The helper groups a cleaner's several moved jobs into a single message.
    from database.models import User
    from services import crew_notify
    db, c, p = seeded
    u = User(email=f"c-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             cleaner_id=f"cl{uuid.uuid4().hex[:5]}", org_id=None)
    db.add(u); db.commit(); db.refresh(u)
    try:
        j1 = _make_job(db, c, p, date(2026, 8, 3), cleaner_ids=[u.cleaner_id])
        j2 = _make_job(db, c, p, date(2026, 8, 4), cleaner_ids=[u.cleaner_id])
        with patch.object(crew_notify, "notify_user_or_sms", return_value=1) as m:
            crew_notify.notify_jobs_rescheduled_bulk(db, [j1, j2], None)
        assert m.call_count == 1                     # one message, not two
        args, kwargs = m.call_args
        assert args[0] == u.id
        assert "2 of your jobs moved" in args[1]
        assert kwargs["category"] == "job_assignments"
        assert kwargs["url"] == "/my-day"
    finally:
        db.query(User).filter(User.id == u.id).delete(synchronize_session=False)
        db.commit()


def test_rollup_helper_is_a_noop_when_no_one_is_assigned(seeded):
    from services import crew_notify
    db, c, p = seeded
    j = _make_job(db, c, p, date(2026, 8, 3), cleaner_ids=[])
    with patch.object(crew_notify, "notify_user_or_sms", return_value=1) as m:
        n = crew_notify.notify_jobs_rescheduled_bulk(db, [j], None)
    assert n == 0
    m.assert_not_called()


def test_an_absurd_shift_is_rejected_before_it_can_overflow(seeded):
    # Bounded at ±10 years: an unbounded shift overflows date + timedelta (an
    # OverflowError, not an HTTPException, which would abort the loop) — reject
    # it at the edge with a 422 (Codex on #878).
    db, c, p = seeded
    j = _make_job(db, c, p, date(2026, 8, 1))
    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": 4000})
    assert r.status_code == 422, r.text


def test_an_unexpected_error_on_one_item_does_not_abort_the_batch(seeded):
    # A non-HTTPException on a later item must not 500 the whole move and strand
    # earlier, already-committed moves with their crew notice suppressed. The
    # bad item is skipped; the good one stays moved and reaches the rollup.
    from modules.scheduling import router as sched_router
    db, c, p = seeded
    j1 = _make_job(db, c, p, date(2026, 8, 1), cleaner_ids=["c1"])
    j2 = _make_job(db, c, p, date(2026, 8, 1), cleaner_ids=["c1"])
    real_update = sched_router.update_job

    def _fake(job_id, data, **kw):
        if job_id == j2.id:
            raise ValueError("boom")            # an unexpected, non-HTTP error
        return real_update(job_id, data, **kw)

    seen = {}

    def _capture(db_, jobs_, org=None):
        seen["ids"] = {j.id for j in jobs_}
        return 0
    with patch("modules.scheduling.router.update_job", side_effect=_fake), \
         patch("services.crew_notify.notify_jobs_rescheduled_bulk", side_effect=_capture):
        r = api.post("/api/jobs/bulk-reschedule",
                     json={"job_ids": [j1.id, j2.id], "shift_days": 2})
    assert r.status_code == 200, r.text          # NOT a 500
    body = r.json()
    assert body["shifted_ids"] == [j1.id]
    assert any(s["job_id"] == j2.id for s in body["skipped"])
    assert seen.get("ids") == {j1.id}            # rollup fired for what moved
    db.refresh(j1)
    assert j1.scheduled_date == date(2026, 8, 3)  # and it really moved + committed


def test_shift_zero_days_rejected(seeded):
    db, c, p = seeded
    j = _make_job(db, c, p, date(2026, 8, 1))
    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [j.id], "shift_days": 0})
    assert r.status_code == 400


def test_shift_empty_job_ids_rejected():
    r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [], "shift_days": 1})
    assert r.status_code == 400


def test_shift_cross_org_job_is_not_found(seeded):
    db, c, p = seeded
    other_client = Client(name="Other Org Client", status="active", org_id=OTHER_ORG)
    db.add(other_client); db.commit(); db.refresh(other_client)
    other_prop = Property(client_id=other_client.id, name="Other Prop", address="9 Other Way",
                          property_type="residential", active=True, org_id=OTHER_ORG)
    db.add(other_prop); db.commit(); db.refresh(other_prop)
    other_job = Job(client_id=other_client.id, property_id=other_prop.id, title="Other Org Job",
                    job_type="residential", scheduled_date=date(2026, 8, 1),
                    start_time=time(9, 0), end_time=time(11, 0), status="scheduled",
                    org_id=OTHER_ORG)
    db.add(other_job); db.commit(); db.refresh(other_job)
    try:
        r = api.post("/api/jobs/bulk-reschedule", json={"job_ids": [other_job.id], "shift_days": 1})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["shifted"] == 0
        assert body["skipped"][0]["job_id"] == other_job.id
        assert body["skipped"][0]["reason"] == "not found"
        db.refresh(other_job)
        assert other_job.scheduled_date == date(2026, 8, 1)
    finally:
        db.query(Job).filter(Job.id == other_job.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == other_prop.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == other_client.id).delete(synchronize_session=False)
        db.commit()
