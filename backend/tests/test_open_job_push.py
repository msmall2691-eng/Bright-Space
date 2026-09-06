"""Posting a job used to announce itself to nobody.

The bench found out by opening the app. On a Friday afternoon that means the
Saturday work sits on the board all evening while every phone that could take
it stays quiet.

What's pinned:

  * posting pushes, at the write, on the false → true edge only — a later edit
    that re-sends open_for_claims=True must not re-announce the same job;
  * only to people whose FILE clears them to claim it. A push to somebody the
    claim endpoint would 403 is a notification with no possible outcome, and it
    shows a stranger what work exists;
  * the payload carries town, day and rate and NOTHING that identifies the
    house. The open board already strips the customer's name, the property
    name and the address — "whose house it is stops being the bidder's
    business until they have actually won the job" — and a lock screen is a
    wider audience than that listing, not a narrower one;
  * a changeover day is ONE push, not one per house, and the daily tick that
    re-runs open_window() does not re-send it every morning. Twelve
    notifications for one Saturday is how a person turns notifications off,
    and then they are off for the assignment that matters too;
  * push is best-effort: a failure never rolls back the schedule write.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Job, Property, SubAgreement, SubDocument, User,
)
from modules.auth.router import current_org_id, get_current_user
from services.sub_vetting import CURRENT_AGREEMENT_VERSION
from utils.dates import business_today


class _Office:
    id, org_id, role, status, active = 9801, 1, "admin", "active", True
    email, full_name, cleaner_id = "post-office@example.com", "The Office", None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def ids():
    made = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield made
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def pushes(monkeypatch):
    """Capture at the push_service seam — crew_notify imports both names inside
    the function, so patching the module attributes intercepts the real path."""
    from services import push_service
    sent = []

    def fake(user_id, title, body, *, url="/", tag=None, category=None):
        sent.append({"user_id": user_id, "title": title, "body": body,
                     "url": url, "tag": tag, "category": category})
        return 1

    monkeypatch.setattr(push_service, "push_enabled", lambda: True)
    monkeypatch.setattr(push_service, "notify_user", fake)
    return sent


def _mk_sub(ids, *, cleared=True, name="Bench Sub"):
    """A cleaner with (or without) a complete file."""
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    u = User(email=f"sub-{tag}@example.com", role="cleaner", org_id=1,
             full_name=f"{name} {tag}", status="active", active=True,
             cleaner_id=f"CT-{tag[:5]}")
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id)
    uid, crew = u.id, u.cleaner_id
    if cleared:
        db.add(SubAgreement(user_id=uid, version=CURRENT_AGREEMENT_VERSION, org_id=1))
        for kind in ("w9", "coi"):
            db.add(SubDocument(user_id=uid, org_id=1, kind=kind, status="accepted",
                               data=b"x", filename=f"{kind}.pdf",
                               expires_at=business_today() + timedelta(days=200)))
        db.commit()
    db.close()
    return uid, crew


def _mk_job(ids, *, city="Rockport", state="ME", posted_rate=None,
            client_name="Priscilla Vandersnoot", cleaner_ids=None, day=None,
            job_type=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=client_name, status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name="Seagull Cottage",
                 address=f"{tag} Harbour Lane", city=city, state=state)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Turnover",
            scheduled_date=day or (business_today() + timedelta(days=3)),
            start_time=dtime(9, 0), status="scheduled",
            cleaner_ids=cleaner_ids or [], posted_rate=posted_rate,
            **({"job_type": job_type} if job_type else {}))
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _post(job_id, value=True):
    return _as(_Office()).patch(f"/api/jobs/{job_id}",
                                json={"open_for_claims": value})


# ── it happens at all ──────────────────────────────────────────────────────

def test_posting_a_job_reaches_the_bench(ids, pushes):
    uid, _ = _mk_sub(ids)
    job = _mk_job(ids, posted_rate=180)
    assert _post(job).status_code == 200

    mine = [p for p in pushes if p["user_id"] == uid]
    assert len(mine) == 1, pushes
    assert mine[0]["title"] == "New job on the board"
    assert mine[0]["url"] == "/my-day"
    # Categorised so it can be turned off on its own — being OFFERED work and
    # being GIVEN work are different events here in a way that is legal rather
    # than cosmetic.
    assert mine[0]["category"] == "open_jobs"


def test_the_offer_is_its_own_preference_not_folded_into_assignments():
    from services.push_service import CREW_NOTIFICATION_CATEGORIES, categories_for_role
    assert "open_jobs" in CREW_NOTIFICATION_CATEGORIES
    assert "open_jobs" in categories_for_role("cleaner")
    assert "open_jobs" not in categories_for_role("admin")


# ── who hears about it ─────────────────────────────────────────────────────

def test_a_sub_whose_file_is_incomplete_is_not_told_what_work_exists(ids, pushes):
    """Approving an application mints a login, not clearance.

    The claim endpoint would refuse them, so a push here could only produce a
    403 — after showing them the job."""
    cleared, _ = _mk_sub(ids, cleared=True)
    stranger, _ = _mk_sub(ids, cleared=False, name="Signed Up Yesterday")
    _post(_mk_job(ids, posted_rate=150))

    told = {p["user_id"] for p in pushes}
    assert cleared in told
    assert stranger not in told


def test_somebody_already_on_the_job_is_not_offered_it(ids, pushes):
    """Defensive, and no longer reachable through the API.

    Posting an already-assigned job is refused now (review finding 6), so this
    state can only arrive from a row that predates that guard. The filter stays
    because the row can still exist — but the fixture has to build it directly
    rather than through PATCH, which would now correctly 409.
    """
    from services.crew_notify import notify_jobs_posted

    uid, crew = _mk_sub(ids)
    other, _ = _mk_sub(ids, name="Someone Else")
    job = _mk_job(ids, cleaner_ids=[crew], posted_rate=150)

    db = SessionLocal()
    row = db.get(Job, job)
    row.open_for_claims = True
    db.commit()
    notify_jobs_posted(db, [row], org_id=1)
    db.close()

    told = {p["user_id"] for p in pushes}
    assert uid not in told, "offered a job they are already on"
    assert other in told


# ── what the payload may say ───────────────────────────────────────────────

def test_an_offer_never_names_the_house_or_the_customer(ids, pushes):
    """The board strips client name, property name and address. A lock screen
    is a wider audience than that listing, not a narrower one."""
    _mk_sub(ids)
    _post(_mk_job(ids, posted_rate=180, client_name="Priscilla Vandersnoot"))

    body = " ".join(p["body"] for p in pushes)
    assert "Priscilla" not in body
    assert "Vandersnoot" not in body
    assert "Seagull" not in body          # the property's name
    assert "Harbour" not in body          # the street
    # What it MAY say: the town, the day and the money.
    # Space-joined, matching the board listing's `area` exactly — the push and
    # the row it points at should read the same.
    assert "Rockport ME" in body
    assert "$180" in body


# ── the edge, not the state ────────────────────────────────────────────────

def test_a_job_already_on_the_board_is_not_re_announced(ids, pushes):
    _mk_sub(ids)
    job = _mk_job(ids, posted_rate=180)
    _post(job)
    first = len(pushes)
    assert first == 1

    _post(job)                              # same value again
    _as(_Office()).patch(f"/api/jobs/{job.__int__()}", json={"title": "Turnover (edited)"})
    assert len(pushes) == first, "re-sending open_for_claims re-announced the job"


def test_taking_a_job_off_the_board_says_nothing(ids, pushes):
    _mk_sub(ids)
    job = _mk_job(ids, posted_rate=180)
    _post(job)
    before = len(pushes)
    assert _post(job, value=False).status_code == 200
    assert len(pushes) == before


# ── a changeover day is one push ───────────────────────────────────────────

def test_a_whole_service_day_is_one_notification_not_twelve(ids, pushes):
    from database.models import TurnoverWindow
    from services.turnover_windows import WINDOW_JOB_TYPE, open_window

    uid, _ = _mk_sub(ids)
    # Far out and randomised: turnover_windows has UNIQUE(org_id, service_date),
    # so a fixed date collides with whatever another test left behind.
    day = business_today() + timedelta(days=200 + (uid % 90))
    for town in ("Rockport", "Camden", "Rockland"):
        _mk_job(ids, city=town, posted_rate=200, day=day,
                job_type=WINDOW_JOB_TYPE)

    db = SessionLocal()
    db.query(TurnoverWindow).filter(TurnoverWindow.service_date == day).delete()
    db.commit()
    w = TurnoverWindow(org_id=1, service_date=day, base_rate=200,
                       open_days_before=7, status="draft")
    db.add(w); db.commit(); db.refresh(w)
    wid = w.id
    result = open_window(db, w)
    db.close()

    assert result["opened"] == 3
    mine = [p for p in pushes if p["user_id"] == uid]
    assert len(mine) == 1, f"one push per house: {mine}"
    assert mine[0]["title"] == "3 jobs on the board"
    assert "Rockport" in mine[0]["body"] and "Camden" in mine[0]["body"]

    # The daily tick re-runs this. It must not re-send every morning.
    db = SessionLocal()
    open_window(db, db.get(TurnoverWindow, wid))
    db.query(TurnoverWindow).filter(TurnoverWindow.id == wid).delete()
    db.commit(); db.close()
    assert len([p for p in pushes if p["user_id"] == uid]) == 1, \
        "the idempotent re-run re-notified the bench"


# ── push must never break the schedule ─────────────────────────────────────

def test_a_broken_push_still_posts_the_job(ids, monkeypatch):
    from services import push_service
    _mk_sub(ids)
    job = _mk_job(ids, posted_rate=180)
    monkeypatch.setattr(push_service, "push_enabled", lambda: True)
    monkeypatch.setattr(push_service, "notify_user",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no network")))

    assert _post(job).status_code == 200
    db = SessionLocal()
    assert db.get(Job, job).open_for_claims is True
    db.close()
