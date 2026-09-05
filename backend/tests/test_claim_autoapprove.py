"""Auto-approving a claim, and — mostly — refusing to (Phase 6).

Routes took the recurring work off the approval queue. What's left is one-off
jobs, and most of those are the same answer every time: a vetted sub asks for a
posted job at the posted price, has no clash, the office clicks approve. Making
a person click that is the bottleneck in its smallest form.

But it is also the last human check before somebody is scheduled and money is
committed, so nearly every test here is about a refusal:

  * off by default — the rule never turns itself up;
  * an incomplete file is refused at the point of SCHEDULING, not only at the
    point of asking;
  * a counter-offer above the posted price is a negotiation, and a negotiation
    gets a person;
  * a ceiling the office sets is obeyed;
  * two people wanting the same job is a judgement about who — auto-approving
    on arrival time would quietly restore first-come-first-served, which the
    marketplace replaced on purpose;
  * a conflict leaves the request pending rather than half-approving anything.

And the refactor underneath: approval moved into services/claim_approval.py so
the auto-approver calls the SAME function the office endpoint does. The office
path's own tests (test_marketplace_claim_requests.py) are what prove that move
was faithful; these prove the two callers agree.
"""
import uuid
from datetime import time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Job, JobClaimRequest, JobResponse, Property, SubAgreement,
    SubDocument, User,
)
from modules.auth.router import get_current_user, current_org_id
from modules.settings.router import set_setting
from utils.dates import business_today


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role = uid, 1, "cleaner"
        self.status, self.active = "active", True
        self.email = f"auto-crew-{uid}@example.com"
        self.full_name = f"Sub {uid}"
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9601, 1, "admin", "active", True
    email = "auto-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


def _api(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _rule(mode="auto", ceiling=None):
    db = SessionLocal()
    set_setting(db, "claim_auto_approve_mode", mode)
    set_setting(db, "claim_auto_approve_max_rate", str(ceiling if ceiling else 0))
    db.commit(); db.close()


def _vet(uid, org_id=1, complete=True):
    db = SessionLocal()
    db.query(SubDocument).filter(SubDocument.user_id == uid).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id == uid).delete(synchronize_session=False)
    if complete:
        from services.sub_vetting import CURRENT_AGREEMENT_VERSION
        db.add(SubAgreement(org_id=org_id, user_id=uid, version=CURRENT_AGREEMENT_VERSION,
                            accepted_at=business_today()))
        db.add(SubDocument(org_id=org_id, user_id=uid, kind="w9", status="accepted", data=b"x"))
        db.add(SubDocument(org_id=org_id, user_id=uid, kind="coi", status="accepted",
                           data=b"x", expires_at=business_today() + timedelta(days=365)))
    db.commit(); db.close()


@pytest.fixture
def world():
    made = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield made
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(JobResponse).filter(JobResponse.job_id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    set_setting(db, "claim_auto_approve_mode", "off")
    set_setting(db, "claim_auto_approve_max_rate", "0")
    db.commit(); db.close()


def _mk_sub(made, complete=True):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    u = User(email=f"sub-{tag}@example.com", role="cleaner", full_name=f"Sub {tag}",
             org_id=1, active=True, status="active", cleaner_id=f"CT-{tag[:5]}")
    db.add(u); db.commit(); db.refresh(u)
    made["users"].append(u.id); uid, cid = u.id, u.cleaner_id
    db.close()
    _vet(uid, complete=complete)
    return _Cleaner(uid, cid)


def _mk_job(made, posted_rate=80.0, start=time(9, 0), end=time(11, 0), when=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Auto {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); made["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"3 Auto Rd {tag}", address=f"3 Auto Rd {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p); made["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=f"Clean {tag}",
            scheduled_date=when or business_today(), start_time=start, end_time=end,
            cleaner_ids=[], status="scheduled", org_id=1,
            open_for_claims=True, posted_rate=posted_rate)
    db.add(j); db.commit(); db.refresh(j); made["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _state(jid):
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    reqs = db.query(JobClaimRequest).filter(JobClaimRequest.job_id == jid).all()
    out = {"cleaners": list(j.cleaner_ids or []), "agreed": j.agreed_rate,
           "open": bool(j.open_for_claims),
           "requests": {r.cleaner_id: (r.status, r.decided_by) for r in reqs}}
    db.close()
    return out


def _claim(sub, jid, rate=None):
    api = _api(sub)
    try:
        body = {} if rate is None else {"requested_rate": rate}
        r = api.post(f"/api/crew/jobs/{jid}/claim", json=body)
        assert r.status_code == 200, r.text
        return r.json()
    finally:
        _clear()


# ── It acts ─────────────────────────────────────────────────────────────────

def test_a_clean_request_at_the_posted_price_is_approved_on_the_spot(world):
    _rule("auto")
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)
    body = _claim(sub, jid)
    assert body["auto_approved"] is True

    st = _state(jid)
    assert st["cleaners"] == [sub.cleaner_id]
    assert st["agreed"] == 80.0
    assert st["open"] is False
    status, decided_by = st["requests"][sub.cleaner_id]
    assert status == "approved"
    # No human decided this, so decided_by stays NULL rather than naming
    # whoever happened to be logged in.
    assert decided_by is None


def test_auto_approval_seeds_the_accepted_response_like_the_office_path_does(world):
    """Both callers run the same function, so the sub can't look like they've
    gone quiet on work they went and asked for."""
    _rule("auto")
    sub = _mk_sub(world)
    jid = _mk_job(world)
    _claim(sub, jid)

    db = SessionLocal()
    resp = (db.query(JobResponse)
            .filter(JobResponse.job_id == jid,
                    JobResponse.cleaner_id == sub.cleaner_id).first())
    out = (resp.response, resp.reason) if resp else None
    db.close()
    assert out == ("accepted", None)


def test_asking_below_the_posted_price_is_still_approved_at_what_they_asked(world):
    """A sub underbidding is not a negotiation — it's a discount, and the
    agreed rate is what they said."""
    _rule("auto")
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)
    assert _claim(sub, jid, rate=70.0)["auto_approved"] is True
    assert _state(jid)["agreed"] == 70.0


# ── It refuses ──────────────────────────────────────────────────────────────

def test_off_by_default_nothing_turns_itself_up(world):
    sub = _mk_sub(world)
    jid = _mk_job(world)
    assert _claim(sub, jid)["auto_approved"] is False
    st = _state(jid)
    assert st["cleaners"] == [] and st["open"] is True
    assert st["requests"][sub.cleaner_id][0] == "pending"


def test_a_counter_offer_above_the_posted_price_waits_for_a_person(world):
    """Asking for more than the job was posted at is opening a negotiation."""
    _rule("auto")
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)
    assert _claim(sub, jid, rate=120.0)["auto_approved"] is False
    assert _state(jid)["requests"][sub.cleaner_id][0] == "pending"


def test_the_ceiling_is_obeyed(world):
    _rule("auto", ceiling=100.0)
    sub = _mk_sub(world)
    cheap = _mk_job(world, posted_rate=90.0)
    dear = _mk_job(world, posted_rate=150.0, start=time(13, 0), end=time(15, 0))
    assert _claim(sub, cheap)["auto_approved"] is True
    assert _claim(sub, dear)["auto_approved"] is False


def test_two_people_wanting_the_same_job_is_the_offices_call(world):
    """Choosing on arrival time would quietly restore first-come-first-served,
    which the marketplace pivot replaced on purpose."""
    _rule("off")                       # first request lands with the rule off
    a, b = _mk_sub(world), _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)
    _claim(a, jid)
    _rule("auto")                      # rule on — but there's now a rival

    assert _claim(b, jid)["auto_approved"] is False
    st = _state(jid)
    assert st["cleaners"] == []
    assert {v[0] for v in st["requests"].values()} == {"pending"}


def test_an_unvetted_sub_is_refused_at_the_point_of_scheduling_too(world):
    """The crew endpoint already refuses an incomplete file. This is the gate
    that must not be reachable around, so it's checked here as well."""
    from services.claim_autoapprove import why_not

    _rule("auto")
    sub = _mk_sub(world, complete=False)
    jid = _mk_job(world)

    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    req = JobClaimRequest(org_id=1, job_id=jid, cleaner_id=sub.cleaner_id,
                          user_id=sub.id, requested_rate=None, status="pending")
    db.add(req); db.commit(); db.refresh(req)
    reason = why_not(db, job, req)
    db.close()
    assert reason == "not_vetted"


def test_a_double_booking_leaves_the_request_pending_and_the_job_untouched(world):
    _rule("auto")
    sub = _mk_sub(world)
    when = business_today()
    busy = _mk_job(world, posted_rate=50.0, when=when)
    # Put them on an overlapping job already.
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == busy).first()
    j.cleaner_ids, j.open_for_claims = [sub.cleaner_id], False
    db.commit(); db.close()

    clash = _mk_job(world, posted_rate=80.0, when=when)   # same 9-11 window
    api = _api(sub)
    try:
        # The crew endpoint's own conflict check fires first and refuses the
        # request outright — the sub is told, rather than filing something the
        # office would have to decline.
        r = api.post(f"/api/crew/jobs/{clash}/claim", json={})
        assert r.status_code == 409
    finally:
        _clear()
    st = _state(clash)
    assert st["cleaners"] == [] and st["open"] is True


# ── The extraction ──────────────────────────────────────────────────────────

def test_the_office_endpoint_and_the_auto_approver_reach_the_same_state(world):
    """One implementation of "approve a claim", proven by comparing outcomes.

    Two identical jobs; one approved by the office, one auto-approved. Every
    field that matters must match.
    """
    sub = _mk_sub(world)
    when = business_today()
    manual = _mk_job(world, posted_rate=80.0, when=when, start=time(9, 0), end=time(11, 0))
    auto = _mk_job(world, posted_rate=80.0, when=when, start=time(13, 0), end=time(15, 0))

    _rule("off")
    _claim(sub, manual)
    admin = _api(_Admin())
    try:
        rid = admin.get(f"/api/jobs/{manual}/claim-requests").json()["requests"][0]["id"]
        r = admin.post(f"/api/jobs/{manual}/claim-requests/{rid}/approve")
        assert r.status_code == 200, r.text
        # The wire shape is unchanged by the move into a service.
        assert set(r.json()) == {"status", "job_id", "cleaner_id", "agreed_rate"}
    finally:
        _clear()

    _rule("auto")
    _claim(sub, auto)

    a, b = _state(manual), _state(auto)
    assert a["cleaners"] == b["cleaners"] == [sub.cleaner_id]
    assert a["agreed"] == b["agreed"] == 80.0
    assert a["open"] == b["open"] is False
    assert a["requests"][sub.cleaner_id][0] == b["requests"][sub.cleaner_id][0] == "approved"
    # The one deliberate difference: a human's id on the manual one, NULL on
    # the automatic one.
    assert a["requests"][sub.cleaner_id][1] == _Admin.id
    assert b["requests"][sub.cleaner_id][1] is None
