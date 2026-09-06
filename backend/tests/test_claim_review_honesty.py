"""What the office is told before they hand a job to somebody — findings 7+8.

Two things that are wrong at the same screen.

FINDING 7. `approve_claim_request`'s docstring says it "runs the same
conflict/availability checks the office's normal assign flow uses (one
implementation, no drift)". It runs one of the three. `_find_cleaner_conflicts`
yes; `_find_unavailable_cleaners` and `_find_over_capacity` no. So a sub with
APPROVED TIME OFF over the job's date can be approved onto it, and the office
finds out on the day.

The fix is NOT to refuse. `brightbase-marketplace` Rule 0: availability is a
signal, not a schedule — "it never blocks, and it never obliges". A sub who
asks for a job on a day they'd booked off has overridden their own signal by
asking, and the app telling them they may not work a day they volunteered for
is the office controlling a subcontractor's hours. What was actually missing is
that nobody was TOLD. So the request carries the fact, the office decides, and
the docstring stops claiming a check it does not run.

FINDING 8. `posted_rate` can never be cleared. `update_job` does
`model_dump(exclude_none=True)`, so `{"posted_rate": null}` — exactly what
JobDetail's asking-rate field sends when you empty the box — is dropped on the
floor. The field snaps back to the old number on reload, and the state the
JobUpdate model documents as valid in its own comment ("NULL is fine — the
crew app just won't show a number until one's set") is unreachable through the
API.
"""
import uuid
from datetime import time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (CleanerTimeOff, Client, Job, JobClaimRequest,
                             Property, User)
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today


class _Office:
    id, org_id, role, status, active = 9901, 1, "admin", "active", True
    email, full_name, cleaner_id = "claim-review@example.com", "The Office", None


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Office()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": [], "users": [], "cids": []}
    yield m
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(CleanerTimeOff).filter(CleanerTimeOff.cleaner_id.in_(m["cids"] or ["-"])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _posted_job(m, *, cid="CT-ANNIE", time_off=False, posted_rate=90.0):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Review {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Review Way", city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    day = business_today() + timedelta(days=4)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Clean",
            scheduled_date=day, start_time=dtime(9, 0), end_time=dtime(12, 0),
            status="scheduled", cleaner_ids=[], open_for_claims=True,
            posted_rate=posted_rate)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    r = JobClaimRequest(org_id=1, job_id=j.id, cleaner_id=cid, user_id=None,
                        requested_rate=None, status="pending")
    db.add(r); db.commit(); db.refresh(r)
    if time_off:
        m["cids"].append(cid)
        db.add(CleanerTimeOff(org_id=1, cleaner_id=cid, cleaner_name="Away Annie",
                              start_date=day - timedelta(days=1),
                              end_date=day + timedelta(days=1),
                              status="approved", reason="vacation"))
        db.commit()
    jid, rid = j.id, r.id
    db.close()
    return jid, rid


def _rate(job_id):
    db = SessionLocal()
    v = db.query(Job).filter(Job.id == job_id).first().posted_rate
    db.close()
    return v


# ── finding 7: say it, don't refuse it ─────────────────────────────────────

def test_the_office_is_told_the_requester_booked_that_day_off(made):
    job, _ = _posted_job(made, time_off=True)
    row = _api().get(f"/api/jobs/{job}/claim-requests").json()["requests"][0]
    assert row.get("heads_up"), "the request said nothing about the time off"
    assert any("off" in h.lower() for h in row["heads_up"]), row["heads_up"]


def test_it_is_a_heads_up_and_not_a_refusal(made):
    """The marketplace's Rule 0 in test form. A sub who asks for a job on a day
    they'd booked off has said they'll work it; refusing would be the office
    overriding a subcontractor's own decision about their own time."""
    job, req = _posted_job(made, time_off=True)
    r = _api().post(f"/api/jobs/{job}/claim-requests/{req}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["agreed_rate"] == 90.0


def test_the_office_is_told_the_requester_is_already_booked_that_hour(made):
    """The second fact worth knowing, and the one that DOES get refused at the
    click — approval already 409s on a double-booking. Saying so on the row
    saves the office picking somebody it was never going to let them pick."""
    job, _ = _posted_job(made)
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == job).first()
    clash = Job(client_id=j.client_id, property_id=j.property_id, org_id=1,
                title="Harbour St turnover", scheduled_date=j.scheduled_date,
                start_time=dtime(10, 0), end_time=dtime(13, 0),
                status="scheduled", cleaner_ids=["CT-ANNIE"])
    db.add(clash); db.commit(); db.refresh(clash)
    made["jobs"].append(clash.id)
    db.close()
    row = _api().get(f"/api/jobs/{job}/claim-requests").json()["requests"][0]
    assert row.get("heads_up"), "nothing said they were already booked"
    said = " ".join(row["heads_up"])
    assert "Harbour St turnover" in said and "double-book" in said, said


def test_a_clear_diary_carries_no_heads_up(made):
    """The control. A warning that appears on every row is furniture, and the
    office stops reading it."""
    job, _ = _posted_job(made, time_off=False)
    row = _api().get(f"/api/jobs/{job}/claim-requests").json()["requests"][0]
    assert not row.get("heads_up"), row.get("heads_up")


def test_a_decided_request_carries_no_heads_up(made):
    """Only what is still to be decided. A warning on a row from last month is
    noise about a decision nobody can take back."""
    job, req = _posted_job(made, time_off=True)
    api = _api()
    assert api.post(f"/api/jobs/{job}/claim-requests/{req}/approve").status_code == 200
    row = api.get(f"/api/jobs/{job}/claim-requests").json()["requests"][0]
    assert row["status"] == "approved"
    assert not row.get("heads_up"), row.get("heads_up")


# ── finding 8: clearing the asking price ───────────────────────────────────

def test_the_asking_rate_can_be_cleared(made):
    job, _ = _posted_job(made)
    r = _api().patch(f"/api/jobs/{job}", json={"posted_rate": None})
    assert r.status_code == 200, r.text
    assert _rate(job) is None, "emptying the asking-rate box did nothing"


def test_an_edit_that_does_not_mention_the_rate_leaves_it_alone(made):
    """The control that makes the mechanism safe: absent is not null. Every
    other field keeps `exclude_none` semantics, so a caller that omits
    posted_rate — which is every caller but the asking-rate box — cannot wipe
    what the office asked for."""
    job, _ = _posted_job(made)
    assert _api().patch(f"/api/jobs/{job}", json={"title": "Clean (deep)"}).status_code == 200
    assert _rate(job) == 90.0


def test_setting_a_rate_still_works(made):
    job, _ = _posted_job(made, posted_rate=None)
    assert _api().patch(f"/api/jobs/{job}", json={"posted_rate": 120}).status_code == 200
    assert _rate(job) == 120.0


def test_a_cleared_rate_leaves_the_job_posted(made):
    """Clearing the price is not un-posting. The crew app shows the job with no
    number and asks the sub to name one — the state the JobUpdate model's own
    comment calls valid."""
    job, _ = _posted_job(made)
    _api().patch(f"/api/jobs/{job}", json={"posted_rate": None})
    db = SessionLocal()
    still_open = db.query(Job).filter(Job.id == job).first().open_for_claims
    db.close()
    assert still_open is True
