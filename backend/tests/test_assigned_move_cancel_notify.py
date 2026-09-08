"""BB-CREW-03: the assigned sub is told when their job moves or is called off.

A reschedule or a cancel changed the job under whoever was on it and told them
nothing — they found out by opening the app, or by driving to a house that was
called off. These wire an event-driven, push+SMS notice at the office write
sites (update_job reschedule/cancel; skip_job) to the CLEANER(S) ON the job.

Two guarantees the tests pin:
  * a MOVE reaches only cleaners already on the job (a newly-added cleaner got
    "New job for you" instead — telling them the same job "moved" is noise);
  * a CANCEL reaches whoever is on it, and is distinct from close_offer, which
    answers people still holding a PENDING request.
An unrelated edit (notes only) notifies nobody.
"""
import uuid
from datetime import date, time
from unittest.mock import patch, MagicMock

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Job, User, Activity
from services import crew_notify
from modules.scheduling.router import update_job, skip_job, JobUpdate


@pytest.fixture
def ctx():
    db = SessionLocal()
    made = {"clients": [], "users": []}

    def cleaner(phone="207-555-0100"):
        cid = f"crew-{uuid.uuid4().hex[:6]}"
        u = User(email=f"{cid}@example.com", role="cleaner", cleaner_id=cid,
                 org_id=1, phone=phone)
        db.add(u); db.commit(); db.refresh(u)
        made["users"].append(u.id)
        return u

    def job(cleaner_ids, *, status="scheduled"):
        c = Client(name=f"C{uuid.uuid4().hex[:5]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        made["clients"].append(c.id)
        p = Property(client_id=c.id, name="P", address="1 Move St",
                     property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        j = Job(client_id=c.id, property_id=p.id, title="Visit", job_type="residential",
                scheduled_date=date(2026, 9, 1), start_time=time(10, 0), end_time=time(12, 0),
                status=status, cleaner_ids=[str(x) for x in cleaner_ids], org_id=1)
        db.add(j); db.commit(); db.refresh(j)
        return j

    yield db, cleaner, job

    db.rollback()
    cids = made["clients"] or [0]
    jids = [r[0] for r in db.query(Job.id).filter(Job.client_id.in_(cids)).all()]
    if jids:
        db.query(Activity).filter(Activity.job_id.in_(jids)).delete(synchronize_session=False)
    db.query(Job).filter(Job.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(cids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture(autouse=True)
def _no_gcal():
    # Keep the office write paths from reaching for Google Calendar.
    with patch("integrations.google_calendar.is_configured", return_value=False):
        yield


# ── the helper: resolve assigned cleaner_ids → their login, push+SMS ──────────

def test_helper_reaches_the_assigned_login(ctx):
    db, cleaner, job = ctx
    u = cleaner()
    j = job([u.cleaner_id])
    with patch.object(crew_notify, "notify_user_or_sms", return_value=1) as m:
        crew_notify.notify_job_cancelled(db, j, j.cleaner_ids)
    assert m.call_count == 1
    args, kwargs = m.call_args
    assert args[0] == u.id
    assert args[1] == "A job of yours was cancelled"
    assert kwargs["category"] == "job_assignments"
    assert kwargs["url"] == "/my-day"


def test_helper_is_a_noop_with_no_assignees(ctx):
    db, cleaner, job = ctx
    j = job([])
    with patch.object(crew_notify, "notify_user_or_sms", return_value=1) as m:
        n = crew_notify.notify_job_rescheduled(db, j, j.cleaner_ids)
    assert n == 0
    assert m.call_count == 0


# ── update_job: reschedule ───────────────────────────────────────────────────

def test_move_tells_the_assigned_sub(ctx):
    db, cleaner, job = ctx
    u = cleaner()
    j = job([u.cleaner_id])
    with patch.object(crew_notify, "notify_job_rescheduled") as moved, \
         patch.object(crew_notify, "notify_job_cancelled") as cancelled:
        update_job(j.id, JobUpdate(scheduled_date="2026-09-08", allow_conflicts=True),
                   db=db, org_id=1)
    assert moved.call_count == 1
    assert moved.call_args.args[2] == [u.cleaner_id]     # continuing cleaner
    assert cancelled.call_count == 0


def test_a_newly_added_cleaner_is_not_told_the_job_moved(ctx):
    db, cleaner, job = ctx
    on_it = cleaner()
    added = cleaner()
    j = job([on_it.cleaner_id])
    with patch.object(crew_notify, "notify_job_rescheduled") as moved, \
         patch.object(crew_notify, "notify_job_assigned") as assigned:
        update_job(j.id,
                   JobUpdate(scheduled_date="2026-09-08",
                             cleaner_ids=[on_it.cleaner_id, added.cleaner_id],
                             allow_conflicts=True),
                   db=db, org_id=1)
    # The continuing cleaner hears "moved"; the new one hears "new job", not both.
    assert moved.call_args.args[2] == [on_it.cleaner_id]
    assert assigned.call_count == 1
    assert assigned.call_args.args[2] == [added.cleaner_id]


def test_an_unrelated_edit_notifies_nobody(ctx):
    db, cleaner, job = ctx
    u = cleaner()
    j = job([u.cleaner_id])
    with patch.object(crew_notify, "notify_job_rescheduled") as moved, \
         patch.object(crew_notify, "notify_job_cancelled") as cancelled:
        update_job(j.id, JobUpdate(notes="left a note", allow_conflicts=True),
                   db=db, org_id=1)
    assert moved.call_count == 0
    assert cancelled.call_count == 0


# ── update_job: cancel, and skip_job ─────────────────────────────────────────

def test_cancel_tells_the_assigned_sub(ctx):
    db, cleaner, job = ctx
    u = cleaner()
    j = job([u.cleaner_id])
    with patch.object(crew_notify, "notify_job_cancelled") as cancelled, \
         patch.object(crew_notify, "notify_job_rescheduled") as moved:
        update_job(j.id, JobUpdate(status="cancelled", allow_conflicts=True),
                   db=db, org_id=1)
    assert cancelled.call_count == 1
    assert cancelled.call_args.args[2] == [u.cleaner_id]
    assert moved.call_count == 0                          # a cancel is not a move


def test_skip_tells_the_assigned_sub(ctx):
    db, cleaner, job = ctx
    u = cleaner()
    j = job([u.cleaner_id])
    with patch.object(crew_notify, "notify_job_cancelled") as cancelled:
        skip_job(j.id, reason="customer away", db=db, org_id=1)
    assert cancelled.call_count == 1
    assert cancelled.call_args.args[2] == [u.cleaner_id]
