"""An offer outlives the job it was for, and nobody tells the people waiting.

Review findings 4 and 5, which are one bug seen from two ends:

  * Nothing writes `open_for_claims = False` when a job stops being live work.
    Cancel a posted job and it stays posted. `approve()` checks the flag and
    never checks `job.status`, so the office can approve a request on a
    CANCELLED job — the sub gets "You got the job!" for work that no longer
    exists, and is scheduled onto it.
  * Pending requests are never answered. The crew board only lists jobs that
    are `open_for_claims` AND `scheduled`, so the moment a job leaves that
    state the request vanishes from the sub's app while staying `pending` in
    the database — forever. It keeps counting against them on the bench
    roster ("holding 3") and nobody ever hears back about work they asked for.

The rule these tests pin: THE OFFER AND ITS PENDING REQUESTS LIVE AND DIE
TOGETHER. When a job stops being an open, scheduled offer — cancelled,
skipped, completed, un-posted, deleted — everyone still waiting is answered
and told, in the same breath.

`withdrawn` rather than `declined`, deliberately: the sub was not turned down,
the work was taken off the table. Declining somebody for a job that was
cancelled tells them they lost a competition that never happened. It is also
the first code to write that status, which the frontend has rendered since the
marketplace pivot (JobClaimRequests.jsx) and nothing ever produced.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, JobClaimRequest, Property, User
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today


class _Office:
    id, org_id, role, status, active = 9801, 1, "admin", "active", True
    email, full_name, cleaner_id = "offer-close@example.com", "The Office", None


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Office()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield m
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _posted_job(m, *, status="scheduled", open_for_claims=True, askers=("CT-DAN",)):
    """A posted job with a pending request from each of `askers`."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Offer {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Offer Ln", city="Rockport", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Turnover",
            scheduled_date=business_today() + timedelta(days=3),
            start_time=dtime(10, 0), end_time=dtime(13, 0), status=status,
            cleaner_ids=[], open_for_claims=open_for_claims, posted_rate=90.0)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    req_ids = []
    for cid in askers:
        r = JobClaimRequest(org_id=1, job_id=j.id, cleaner_id=cid, user_id=None,
                            requested_rate=None, status="pending")
        db.add(r); db.commit(); db.refresh(r)
        req_ids.append(r.id)
    jid = j.id; db.close()
    return jid, req_ids


def _state(job_id, req_ids):
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == job_id).first()
    open_flag = bool(j.open_for_claims) if j else None
    reqs = [db.query(JobClaimRequest).filter(JobClaimRequest.id == rid).first() for rid in req_ids]
    statuses = [(r.status if r else None) for r in reqs]
    db.close()
    return open_flag, statuses


# ── the offer comes off the board with the job ─────────────────────────────

def test_cancelling_a_posted_job_takes_it_off_the_board(made):
    job, reqs = _posted_job(made)
    r = _api().patch(f"/api/jobs/{job}", json={"status": "cancelled"})
    assert r.status_code == 200, r.text
    open_flag, statuses = _state(job, reqs)
    assert open_flag is False, "a cancelled job is still advertised as open work"
    assert statuses == ["withdrawn"], statuses


def test_everyone_waiting_is_answered_not_just_the_first(made):
    job, reqs = _posted_job(made, askers=("CT-DAN", "CT-MARIA", "CT-JO"))
    assert _api().patch(f"/api/jobs/{job}", json={"status": "cancelled"}).status_code == 200
    _, statuses = _state(job, reqs)
    assert statuses == ["withdrawn"] * 3, statuses


def test_unposting_a_job_answers_the_people_who_asked(made):
    """The office taking a job off the board is an answer, and has to reach
    the people waiting. Without this their request is invisible in their app
    and pending in the database at the same time."""
    job, reqs = _posted_job(made)
    assert _api().patch(f"/api/jobs/{job}", json={"open_for_claims": False}).status_code == 200
    open_flag, statuses = _state(job, reqs)
    assert open_flag is False
    assert statuses == ["withdrawn"], statuses


def test_skipping_an_occurrence_takes_it_off_the_board(made):
    """`/skip` cancels one visit of a recurring series. It is a cancel, and
    the offer has to go with it — the endpoint sets status directly rather
    than going through update_job, so it needs its own call."""
    job, reqs = _posted_job(made)
    r = _api().post(f"/api/jobs/{job}/skip", params={"reason": "customer away"})
    assert r.status_code == 200, r.text
    open_flag, statuses = _state(job, reqs)
    assert open_flag is False
    assert statuses == ["withdrawn"], statuses


def test_deleting_a_posted_job_tells_the_people_waiting(made, monkeypatch):
    """A hard delete cascades the request rows away on Postgres, so the row
    state cannot be asserted — the notification is the whole deliverable. A
    sub whose request evaporates with no word is the failure."""
    job, _reqs = _posted_job(made)
    db = SessionLocal()
    u = User(id=9802, org_id=1, email=f"dan-{uuid.uuid4().hex[:6]}@example.com",
             full_name="Dan", role="cleaner", cleaner_id="CT-DAN",
             password_hash="x", active=True, status="active")
    db.add(u); db.commit(); db.close(); made["users"].append(9802)
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id == job).update({"user_id": 9802})
    db.commit(); db.close()

    sent = []
    import services.push_service as ps
    monkeypatch.setattr(ps, "notify_user", lambda uid, title, body, **kw: sent.append((uid, title)))

    assert _api().delete(f"/api/jobs/{job}").status_code == 204
    assert [uid for uid, _ in sent] == [9802], sent


# ── approval refuses work that no longer exists ────────────────────────────

def test_approving_on_a_cancelled_job_is_refused(made):
    """The guard above closes the offer at every cancel path we own. This is
    the one that has to hold when a path we DON'T own leaves a cancelled job
    flagged open — a row written by an older release, a bulk update, a future
    endpoint. Approving here schedules somebody onto cancelled work and pushes
    them "You got the job!"."""
    job, reqs = _posted_job(made, status="cancelled", open_for_claims=True)
    r = _api().post(f"/api/jobs/{job}/claim-requests/{reqs[0]}/approve")
    assert r.status_code == 409, r.text
    assert "cancel" in r.json()["detail"].lower(), r.json()
    _, statuses = _state(job, reqs)
    assert statuses == ["pending"], "a refused approval must not decide the request"


# ── controls: the ordinary paths are untouched ─────────────────────────────

def test_an_unrelated_edit_leaves_the_offer_alone(made):
    job, reqs = _posted_job(made)
    assert _api().patch(f"/api/jobs/{job}", json={"title": "Turnover (deep)"}).status_code == 200
    open_flag, statuses = _state(job, reqs)
    assert open_flag is True, "an ordinary edit pulled the job off the board"
    assert statuses == ["pending"], statuses


def test_approving_on_a_live_job_still_works(made):
    job, reqs = _posted_job(made)
    r = _api().post(f"/api/jobs/{job}/claim-requests/{reqs[0]}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["agreed_rate"] == 90.0
    _, statuses = _state(job, reqs)
    assert statuses == ["approved"], statuses


def test_a_job_that_was_never_posted_is_unaffected_by_cancelling(made):
    """No offer, no requests, nothing to answer — and no extra work done."""
    job, _ = _posted_job(made, open_for_claims=False, askers=())
    assert _api().patch(f"/api/jobs/{job}", json={"status": "cancelled"}).status_code == 200
    open_flag, _ = _state(job, [])
    assert open_flag is False


# ── the recurring cancellation paths ───────────────────────────────────────

def test_cancelling_a_series_takes_its_posted_visits_off_the_board(made):
    """Five paths in modules/recurring/router.py cancel a visit, and every one
    of them had the same hole. They now share `_cancel_side_effects`; this
    walks the one an owner actually clicks — "cancel the rest of this series"
    — and so pins the shared hook rather than any single path."""
    from database.models import RecurringSchedule
    job, reqs = _posted_job(made)
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == job).first()
    sched = RecurringSchedule(
        client_id=j.client_id, property_id=j.property_id, org_id=1,
        title="Offer series", job_type="residential", frequency="weekly",
        days_of_week=[j.scheduled_date.weekday()], day_of_week=j.scheduled_date.weekday(),
        start_time=dtime(10, 0), end_time=dtime(13, 0), active=True,
        generate_weeks_ahead=4, address="1 Offer Ln")
    db.add(sched); db.commit(); db.refresh(sched)
    j.recurring_schedule_id = sched.id
    db.commit(); sched_id = sched.id; db.close()
    try:
        r = _api().post(f"/api/recurring/{sched_id}/cancel-upcoming")
        assert r.status_code == 200, r.text
        assert r.json()["cancelled_count"] >= 1
        open_flag, statuses = _state(job, reqs)
        assert open_flag is False, "a cancelled series left its visit on the board"
        assert statuses == ["withdrawn"], statuses
    finally:
        db = SessionLocal()
        db.query(Job).filter(Job.recurring_schedule_id == sched_id).update(
            {"recurring_schedule_id": None}, synchronize_session=False)
        db.query(RecurringSchedule).filter(RecurringSchedule.id == sched_id).delete()
        db.commit(); db.close()


# ── the offers nothing ever edits again ────────────────────────────────────

def test_the_sweep_closes_an_offer_whose_day_has_gone(made):
    """The other half of finding 5. A job posted for Saturday and never
    approved is still flagged open on Sunday with its requests still pending
    — and NOTHING edits that row, so no amount of guarding the write paths
    reaches it. This is the pass that does, on the existing schedule-audit
    tick."""
    from services.claim_approval import sweep_dead_offers
    job, reqs = _posted_job(made)
    db = SessionLocal()
    db.query(Job).filter(Job.id == job).update(
        {"scheduled_date": business_today() - timedelta(days=2)})
    db.commit(); db.close()

    db = SessionLocal()
    assert sweep_dead_offers(db) >= 1
    db.close()
    open_flag, statuses = _state(job, reqs)
    assert open_flag is False
    assert statuses == ["withdrawn"], statuses


def test_the_sweep_heals_a_job_an_older_release_left_flagged_open(made):
    """Rows written by the bug are in production now. A code fix that only
    guards future writes leaves them there forever, still approvable."""
    from services.claim_approval import sweep_dead_offers
    job, reqs = _posted_job(made, status="cancelled", open_for_claims=True)
    db = SessionLocal()
    assert sweep_dead_offers(db) >= 1
    db.close()
    open_flag, statuses = _state(job, reqs)
    assert open_flag is False
    assert statuses == ["withdrawn"], statuses


def test_the_sweep_leaves_a_live_offer_alone(made):
    """The control that matters most: this runs unattended every six hours
    over every job in the database. Closing a live offer would silently empty
    the board."""
    from services.claim_approval import sweep_dead_offers
    job, reqs = _posted_job(made)
    db = SessionLocal()
    sweep_dead_offers(db)
    db.close()
    open_flag, statuses = _state(job, reqs)
    assert open_flag is True, "the sweep took a live, future-dated offer off the board"
    assert statuses == ["pending"], statuses


def test_the_sweep_says_nothing_to_anybody(made, monkeypatch):
    """Silent by design. The first pass over the backlog would otherwise fire
    a push per stale request — about jobs from weeks ago, with nothing the
    person can do about any of them."""
    from services.claim_approval import sweep_dead_offers
    job, _ = _posted_job(made, status="cancelled")
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id == job).update({"user_id": 9803})
    db.commit(); db.close()
    sent = []
    import services.push_service as ps
    monkeypatch.setattr(ps, "notify_user", lambda *a, **k: sent.append(a))
    db = SessionLocal(); sweep_dead_offers(db); db.close()
    assert sent == []
