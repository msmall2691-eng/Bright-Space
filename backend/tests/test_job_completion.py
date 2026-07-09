"""PR-A of the Job/Visit unification: the new endpoints on /api/jobs.

Covers:
- POST /api/jobs/{id}/complete sets status + all completion fields; idempotent;
  404 on unknown; and — critically — completing a job stamps status='completed'
  on the Job row itself (the audit gap the old Visit-only path left open).
- POST /api/jobs/{id}/skip cancels the job and records a RecurrenceException
  when the job is on a recurring schedule; is idempotent.
- GET /api/jobs/{id}/crew-suggestions returns top cleaners by property frequency.
- POST /api/jobs/{id}/auto-assign applies the top suggestion.

See docs/job-visit-unification.md.
"""
from datetime import date, datetime, time, timedelta, timezone

import pytest

from database.db import SessionLocal
from database.models import (
    Client, Property, Job, RecurringSchedule, RecurrenceException, Invoice,
)
from modules.scheduling.router import (
    complete_job, skip_job, get_job_crew_suggestions, auto_assign_job_crew,
    update_job, JobCompleteRequest, JobUpdate,
)
from fastapi import HTTPException


@pytest.fixture
def ctx():
    db = SessionLocal()
    c = Client(name="PR-A Test", email="pra@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="PR-A House", address="1 PR-A Rd",
                 property_type="residential", active=True)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Turnover",
            job_type="residential",
            scheduled_date=date.today(),
            start_time=time(10, 0), end_time=time(13, 0),
            status="scheduled", cleaner_ids=[])
    db.add(j); db.commit(); db.refresh(j)
    yield db, c, p, j
    db.rollback()
    db.query(Invoice).filter(Invoice.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurrenceException).filter(
        RecurrenceException.recurring_schedule_id.isnot(None)
    ).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(
        RecurringSchedule.client_id == c.id
    ).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_complete_sets_status_and_all_fields(ctx):
    db, _c, _p, j = ctx
    out = complete_job(j.id, JobCompleteRequest(
        completed_by=42,
        completed_at=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
        checklist_results={"kitchen": "done", "bath": "done"},
        photos=[{"url": "s3://x/1.jpg", "label": "before"}],
        notes="Client on-site at exit.",
    ), db=db)
    assert out["status"] == "completed"
    assert out["completed_by"] == 42
    assert out["completed_at"].startswith("2026-06-01")
    assert out["checklist_results"] == {"kitchen": "done", "bath": "done"}
    assert out["photos"] == [{"url": "s3://x/1.jpg", "label": "before"}]

    db.refresh(j)
    # The bug the unification exists to fix: Job.status now moves with completion.
    assert j.status == "completed"
    assert j.completed_at is not None
    assert j.completed_by == 42
    assert j.notes == "Client on-site at exit."


def test_complete_is_idempotent(ctx):
    db, _c, _p, j = ctx
    complete_job(j.id, JobCompleteRequest(completed_by=1), db=db)
    complete_job(j.id, JobCompleteRequest(completed_by=2), db=db)
    db.refresh(j)
    assert j.status == "completed"
    assert j.completed_by == 2  # last write wins


def test_complete_unknown_returns_404(ctx):
    db, *_ = ctx
    with pytest.raises(HTTPException) as exc:
        complete_job(99_999_999, JobCompleteRequest(), db=db)
    assert exc.value.status_code == 404


def test_complete_defaults_completed_at_when_omitted(ctx):
    db, _c, _p, j = ctx
    out = complete_job(j.id, JobCompleteRequest(), db=db)
    assert out["completed_at"] is not None


def test_complete_job_auto_creates_draft_invoice(ctx):
    """The field-completion endpoint (CompleteVisitModal's actual UI path)
    used to be the one "mark complete" route that never auto-invoiced —
    only the office-side PATCH status path did. Both must now behave the
    same way: completing a job auto-creates a draft Invoice."""
    db, c, _p, j = ctx
    assert db.query(Invoice).filter(Invoice.job_id == j.id).count() == 0
    out = complete_job(j.id, JobCompleteRequest(), db=db)
    assert out["has_invoice"] is True
    inv = db.query(Invoice).filter(Invoice.job_id == j.id).first()
    assert inv is not None
    assert inv.client_id == c.id
    assert inv.status == "draft"
    assert inv.items and inv.items[0]["name"] == j.title


def test_complete_job_auto_invoice_is_idempotent(ctx):
    db, _c, _p, j = ctx
    complete_job(j.id, JobCompleteRequest(), db=db)
    complete_job(j.id, JobCompleteRequest(), db=db)  # re-complete (idempotent status)
    count = db.query(Invoice).filter(Invoice.job_id == j.id).count()
    assert count == 1


def test_update_job_patch_completion_reports_has_invoice(ctx):
    """The PATCH path's own response now also carries has_invoice so the
    frontend (JobDetail.jsx's "Ready to bill?" banner) can tell an invoice
    was already auto-created by this same request, instead of checking
    stale pre-request state that could never see it."""
    db, _c, _p, j = ctx
    out = update_job(j.id, JobUpdate(status="completed"), db=db)
    assert out["has_invoice"] is True
    assert db.query(Invoice).filter(Invoice.job_id == j.id).count() == 1


def test_skip_cancels_job(ctx):
    db, _c, _p, j = ctx
    out = skip_job(j.id, reason="client rescheduled", db=db)
    assert out["status"] == "cancelled"
    db.refresh(j)
    assert j.status == "cancelled"
    assert "client rescheduled" in (j.notes or "")


def test_skip_records_recurrence_exception_when_on_schedule(ctx):
    db, c, p, _j = ctx
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, title="Weekly",
        job_type="residential", address="1 PR-A Rd",
        frequency="weekly", day_of_week=0,
        start_time=time(10, 0), end_time=time(13, 0),
        active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    rj = Job(client_id=c.id, property_id=p.id, title="Occurrence",
             job_type="residential",
             scheduled_date=date.today(),
             start_time=time(10, 0), end_time=time(13, 0),
             status="scheduled", recurring_schedule_id=sched.id,
             cleaner_ids=[])
    db.add(rj); db.commit(); db.refresh(rj)

    skip_job(rj.id, reason="crew off", db=db)

    exc = (
        db.query(RecurrenceException)
        .filter(
            RecurrenceException.recurring_schedule_id == sched.id,
            RecurrenceException.exception_date == rj.scheduled_date,
        )
        .first()
    )
    assert exc is not None
    assert exc.exception_type == "skip"


def test_skip_is_idempotent(ctx):
    db, c, p, _j = ctx
    sched = RecurringSchedule(
        client_id=c.id, property_id=p.id, title="Weekly",
        job_type="residential", address="1 PR-A Rd",
        frequency="weekly", day_of_week=0,
        start_time=time(10, 0), end_time=time(13, 0),
        active=True,
    )
    db.add(sched); db.commit(); db.refresh(sched)
    rj = Job(client_id=c.id, property_id=p.id, title="Occurrence",
             job_type="residential",
             scheduled_date=date.today(),
             start_time=time(10, 0), end_time=time(13, 0),
             status="scheduled", recurring_schedule_id=sched.id,
             cleaner_ids=[])
    db.add(rj); db.commit(); db.refresh(rj)

    skip_job(rj.id, db=db)
    skip_job(rj.id, db=db)  # second call should not create a second exception

    count = (
        db.query(RecurrenceException)
        .filter(RecurrenceException.recurring_schedule_id == sched.id,
                RecurrenceException.exception_date == rj.scheduled_date)
        .count()
    )
    assert count == 1


def test_crew_suggestions_ranks_by_frequency(ctx):
    db, c, p, j = ctx
    # Seed historical jobs with cleaner assignments at the same property.
    for cleaner_ids in ([1], [1, 2], [1, 2], [3]):
        db.add(Job(client_id=c.id, property_id=p.id, title="Prior",
                   job_type="residential",
                   scheduled_date=date.today(),
                   start_time=time(9, 0), end_time=time(12, 0),
                   status="scheduled", cleaner_ids=cleaner_ids))
    db.commit()

    out = get_job_crew_suggestions(j.id, db=db)
    ranks = [(s["cleaner_id"], s["frequency"]) for s in out["suggestions"]]
    # cleaner 1 appears in 3 prior jobs, 2 in 2, 3 in 1.
    assert ranks[0][0] == 1 and ranks[0][1] >= 3
    assert {r[0] for r in ranks} >= {1, 2, 3}


def test_crew_suggestions_prefers_recent_over_ancient(ctx):
    """Audit regression: prior code did `.limit(20)` with no ORDER BY, so a
    property with >20 historical jobs could surface a stale cleaner from
    years ago instead of the recurring one from last month. Now recency
    wins ties by scheduled_date DESC.
    """
    db, c, p, j = ctx
    ancient = date.today() - timedelta(days=1000)
    recent = date.today() - timedelta(days=5)
    # 25 ancient jobs with cleaner 99, then 3 recent jobs with cleaner 7.
    # With the pre-fix "arbitrary 20" limit, cleaner 99 would dominate.
    for _ in range(25):
        db.add(Job(client_id=c.id, property_id=p.id, title="Ancient",
                   job_type="residential", scheduled_date=ancient,
                   start_time=time(9, 0), end_time=time(12, 0),
                   status="scheduled", cleaner_ids=[99]))
    for _ in range(3):
        db.add(Job(client_id=c.id, property_id=p.id, title="Recent",
                   job_type="residential", scheduled_date=recent,
                   start_time=time(9, 0), end_time=time(12, 0),
                   status="scheduled", cleaner_ids=[7]))
    db.commit()

    out = get_job_crew_suggestions(j.id, db=db)
    cleaner_ids = [s["cleaner_id"] for s in out["suggestions"]]
    # Cleaner 7 (recent) must be surfaced; 99 (ancient overflow) can be
    # trimmed off entirely thanks to the recency ORDER BY + LIMIT 20.
    assert 7 in cleaner_ids


def test_auto_assign_applies_top_suggestion(ctx):
    db, c, p, j = ctx
    for cleaner_ids in ([7], [7, 9], [7]):
        db.add(Job(client_id=c.id, property_id=p.id, title="Prior",
                   job_type="residential",
                   scheduled_date=date.today(),
                   start_time=time(9, 0), end_time=time(12, 0),
                   status="scheduled", cleaner_ids=cleaner_ids))
    db.commit()

    out = auto_assign_job_crew(j.id, db=db)
    assert out["status"] == "assigned"
    assert out["assigned_cleaner_id"] == 7
    db.refresh(j)
    assert j.cleaner_ids == [7]


def test_auto_assign_no_history_returns_no_history(ctx):
    db, _c, _p, j = ctx
    # No other jobs at this property carry cleaner_ids; the fixture's j has [].
    out = auto_assign_job_crew(j.id, db=db)
    assert out["status"] == "no_history"
