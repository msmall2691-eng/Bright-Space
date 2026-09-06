"""The bench screen — and the two things it refuses to count.

The subcontractor surface shipped across eight phases and ended up in three
unrelated places: applications in Settings > Users, document review nested in a
disclosure on a staff row, the weekly digest on the Ops Board. Nothing answered
"who have I got, and can they work". GET /api/crew/bench does.

Most of what is pinned here is the refusal, because it is what a later change
would quietly undo:

  * **no decline count anywhere in the payload.** The signed agreement,
    section 2: "You can decline anything, for any reason or none... Declining
    does not count against you." A decline-rate column would be the app
    contradicting the contract on the screen where the office decides who to
    approve.
  * **no punctuality from clock punches.** Control of the means and progress
    of the work is Part 1 #1 of the Maine standard and one of the two criteria
    this arrangement satisfies by design. Timing a contractor's arrival is
    supervision of hours.

Plus the boundary that has now shipped wrong eight times: completed_at is UTC,
scheduled_date is Maine-local, and "finished on the day it was booked" compares
the two.
"""
import uuid
from datetime import datetime, time, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Job, JobResponse, Property, SubAgreement, SubDocument, SubPayout, User,
)
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today, business_tz


class _Admin:
    id, org_id, role, status, active = 9601, 1, "admin", "active", True
    email, full_name, cleaner_id = "bench-admin@example.com", "The Office", None


class _Cleaner:
    id, org_id, role, status, active = 9602, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "bench-crew@example.com", "A Cleaner", "CT-BENCH"


def _api(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"users": [], "clients": [], "properties": [], "jobs": []}
    yield m
    db = SessionLocal()
    db.query(SubPayout).filter(SubPayout.user_id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(JobResponse).filter(JobResponse.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_crew(m, name="Bench Person", org_id=1):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    u = User(email=f"bench-{tag}@example.com", role="cleaner", org_id=org_id,
             full_name=f"{name} {tag}", active=True, status="active",
             cleaner_id=f"CT-{tag[:5]}",
             created_at=datetime.utcnow() - timedelta(days=200))
    db.add(u); db.commit(); db.refresh(u)
    m["users"].append(u.id)
    out = (u.id, u.cleaner_id, u.full_name)
    db.close()
    return out


def _mk_job(m, crew_id, *, scheduled, status="scheduled", completed_at=None, org_id=1,
            assigned=True):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Bench {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"{tag} Bench Rd", address=f"{tag} Bench Rd",
                 org_id=org_id)
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=org_id, title="Clean",
            scheduled_date=scheduled, start_time=time(10, 0), status=status,
            cleaner_ids=[crew_id] if assigned else [], completed_at=completed_at)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    out = j.id
    db.close()
    return out


def _me(payload, user_id):
    return next(p for p in payload["people"] if p["user_id"] == user_id)


# ── who may open it ─────────────────────────────────────────────────────────

def test_the_bench_is_office_only(made):
    assert _api(_Cleaner()).get("/api/crew/bench").status_code == 403


def test_the_office_gets_the_roster_and_the_file_status_together(made):
    uid, crew, name = _mk_crew(made)
    r = _api(_Admin()).get("/api/crew/bench")
    assert r.status_code == 200
    me = _me(r.json(), uid)
    # The file half comes from roster() rather than a second implementation,
    # so the two screens cannot disagree about who is cleared.
    assert me["name"] == name
    assert me["missing"], "a brand-new person owes documents"
    assert me["can_work"] is False
    assert "work" in me and "paid_ytd" in me


# ── the refusals, which are the point ───────────────────────────────────────

def test_declines_are_not_counted_anywhere_in_the_payload(made):
    """Section 2 of the agreement they signed says declining is free."""
    uid, crew, _ = _mk_crew(made)
    # Four jobs they were offered and turned down. They are not ON any of them
    # — that is what declining means — so nothing else in the payload should
    # be four either, and a stray 4 is the decline count leaking in as a number.
    db = SessionLocal()
    for _ in range(4):
        job = _mk_job(made, crew, scheduled=business_today() + timedelta(days=2),
                      assigned=False)
        db.add(JobResponse(job_id=job, cleaner_id=crew, user_id=uid,
                           response="declined", org_id=1))
    db.commit(); db.close()

    body = _api(_Admin()).get("/api/crew/bench").json()
    me = _me(body, uid)

    blob = repr(body).lower()
    assert "declin" not in blob, "a decline reached the office screen"
    assert 4 not in me["work"].values(), "the decline count leaked in as a number"
    assert me["work"]["upcoming"] == 0, "declining does not put them on the job"


def test_no_punctuality_signal_is_derived_from_the_time_clock(made):
    """Timing a contractor's arrival is supervision of hours (Part 1 #1)."""
    uid, crew, _ = _mk_crew(made)
    me = _me(_api(_Admin()).get("/api/crew/bench").json(), uid)
    for banned in ("on_time", "late", "punctual", "minutes_late", "clock"):
        assert banned not in me["work"], banned
    # What IS there is outcome-shaped: did the work get finished, and by when.
    assert set(me["work"]) == {
        "completed", "on_day", "upcoming", "last_worked",
        "pending_requests", "history_days"}


# ── the boundary that has shipped wrong eight times ─────────────────────────

def test_an_evening_completion_is_not_counted_as_finished_late(made):
    """completed_at is UTC; scheduled_date is Maine-local.

    A job booked today and finished at 8pm in Maine is stored as TOMORROW in
    UTC. Compared raw, every evening job reads as finished a day late — and
    every cleaner reads as unreliable for working past dinner.
    """
    uid, crew, _ = _mk_crew(made)
    day = business_today() - timedelta(days=3)
    # 8pm Maine on the scheduled day, stored as the naive UTC instant.
    evening = (datetime.combine(day, time(20, 0))
               .replace(tzinfo=business_tz())
               .astimezone(timezone.utc).replace(tzinfo=None))
    assert evening.date() > day, "fixture must straddle midnight UTC to mean anything"
    _mk_job(made, crew, scheduled=day, status="completed", completed_at=evening)

    me = _me(_api(_Admin()).get("/api/crew/bench").json(), uid)
    assert me["work"]["completed"] == 1
    assert me["work"]["on_day"] == 1, "an 8pm finish read as a day late"
    assert me["work"]["last_worked"] == day.isoformat()


def test_work_actually_finished_late_is_reported_as_such(made):
    """The control: without it the test above passes on a function that calls
    everything on time."""
    uid, crew, _ = _mk_crew(made)
    day = business_today() - timedelta(days=5)
    late = datetime.combine(day + timedelta(days=2), time(15, 0))
    _mk_job(made, crew, scheduled=day, status="completed", completed_at=late)

    me = _me(_api(_Admin()).get("/api/crew/bench").json(), uid)
    assert me["work"]["completed"] == 1
    assert me["work"]["on_day"] == 0


def test_upcoming_work_is_counted_but_not_as_completed(made):
    uid, crew, _ = _mk_crew(made)
    _mk_job(made, crew, scheduled=business_today() + timedelta(days=3))
    _mk_job(made, crew, scheduled=business_today() + timedelta(days=4),
            status="cancelled")
    me = _me(_api(_Admin()).get("/api/crew/bench").json(), uid)
    assert me["work"]["upcoming"] == 1, "a cancelled job is not upcoming work"
    assert me["work"]["completed"] == 0


# ── the 1099 you will owe them ──────────────────────────────────────────────

def test_the_1099_threshold_is_flagged_in_september_not_january(made):
    uid, crew, _ = _mk_crew(made)
    db = SessionLocal()
    db.add(SubPayout(user_id=uid, cleaner_id=crew, amount=450.0, status="due", org_id=1))
    db.commit(); db.close()
    me = _me(_api(_Admin()).get("/api/crew/bench").json(), uid)
    assert me["paid_ytd"] == 450.0
    assert me["form_1099_due"] is False

    db = SessionLocal()
    db.add(SubPayout(user_id=uid, cleaner_id=crew, amount=200.0, status="paid", org_id=1))
    db.commit(); db.close()
    me = _me(_api(_Admin()).get("/api/crew/bench").json(), uid)
    assert me["paid_ytd"] == 650.0
    assert me["form_1099_due"] is True


def test_a_voided_payout_was_never_money(made):
    uid, crew, _ = _mk_crew(made)
    db = SessionLocal()
    db.add(SubPayout(user_id=uid, cleaner_id=crew, amount=900.0, status="void", org_id=1))
    db.commit(); db.close()
    me = _me(_api(_Admin()).get("/api/crew/bench").json(), uid)
    assert me["paid_ytd"] == 0.0
    assert me["form_1099_due"] is False


# ── tenancy ─────────────────────────────────────────────────────────────────

def test_another_orgs_bench_is_invisible(made):
    mine, _, _ = _mk_crew(made, org_id=1)
    theirs, _, _ = _mk_crew(made, name="Other Org", org_id=2)
    ids = [p["user_id"] for p in _api(_Admin()).get("/api/crew/bench").json()["people"]]
    assert mine in ids
    assert theirs not in ids
