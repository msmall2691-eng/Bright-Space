"""Instant claim (Turno-style), and the one case that still waits.

The owner decided in writing (Sept 2026) to run the bench as a real
marketplace: a cleared sub who claims a posted job at or below the posted price
gets it on the spot, first to claim wins. This replaced the earlier "the office
picks who gets it" queue. It stays legal because it is the sub ACCEPTING the
office's offer at the office's price — Rule 0 forbids the office assigning, not
the sub accepting (brightbase-marketplace).

Instant claiming was later switched OFF by default (Sept 2026, in writing): the
gate fails closed and turns on only when the office explicitly sets it to
"auto", because with no human approving each claim an out-of-date file on a
grandfathered sub would auto-award. The behaviour below is what happens WHEN it
is on (`_rule("auto")`), plus that off/unset/garbage all keep it off.

What is pinned here:

  * OFF by default and fail-closed — an unset or stray value leaves a claim
    waiting for the office; only "auto" turns it on;
  * turned on, a clean claim at the posted price is theirs on the spot;
  * the office can switch instant claiming OFF and go back to approving by hand;
  * a claim BELOW the posted price is instant too, at what they asked (a
    discount, not a negotiation);
  * a bid ABOVE the posted price is the one thing that still waits for a
    person — that is the office agreeing to pay more;
  * an incomplete file is refused at the point of SCHEDULING, not only at the
    point of asking — the one non-negotiable gate;
  * first come, first served: once one sub claims, the offer closes and the
    next claimant is turned away — no rival check picks a winner here;
  * a conflict leaves the request pending rather than half-approving anything.

And the refactor underneath: approval lives in services/claim_approval.py so
the auto-approver calls the SAME function the office endpoint does. The office
path's own tests are what prove that move was faithful; these prove the two
callers agree.
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


def _rule(mode="auto"):
    # "auto" = instant claiming on, "off" = every claim waits for the office.
    # Instant is the default now; tests still set it explicitly for clarity.
    db = SessionLocal()
    set_setting(db, "claim_auto_approve_mode", mode)
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
    # Leave instant claiming OFF after each test so a leftover default-on value
    # can't silently instant-approve a claim in an unrelated test that assumes
    # a request stays pending.
    set_setting(db, "claim_auto_approve_mode", "off")
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

def _rule_unset():
    from database.models import AppSetting
    db = SessionLocal()
    db.query(AppSetting).filter(
        AppSetting.key == "claim_auto_approve_mode").delete(synchronize_session=False)
    db.commit(); db.close()


def test_instant_claiming_is_off_by_default_and_fails_closed(world):
    """No setting touched at all — a clean claim at the posted price still
    WAITS for the office. Switched off in writing (Sept 2026): the gate fails
    closed, so an org that never chose instant claiming is never running it."""
    _rule_unset()
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)
    assert _claim(sub, jid)["auto_approved"] is False
    st = _state(jid)
    assert st["cleaners"] == [] and st["open"] is True
    assert st["requests"][sub.cleaner_id][0] == "pending"


def test_a_stray_or_corrupted_setting_reads_as_off(world):
    """The old default was `!= "off"`, so a legacy or corrupted value like
    "false" / "0" / "disabled" read as ON — a gate over money and who's in a
    customer's house that failed OPEN. Only the explicit "auto" turns it on now."""
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)
    for junk in ("false", "0", "disabled", "on", "yes", ""):
        _rule(junk)
        assert _claim(sub, jid)["auto_approved"] is False, junk
        assert _state(jid)["requests"][sub.cleaner_id][0] == "pending"
        # clear the request so the next junk value starts clean
        db = SessionLocal()
        db.query(JobClaimRequest).filter(JobClaimRequest.job_id == jid).delete(
            synchronize_session=False)
        db.commit(); db.close()


def test_the_office_can_switch_instant_claiming_off(world):
    """Turned off, a claim goes back to a request the office approves by hand."""
    _rule("off")
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)
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


def test_an_unpriced_job_is_never_an_instant_claim(world):
    """No posted price is no anchor for "at or below" — naming a number on an
    unpriced job is a negotiation the office prices, so it waits."""
    _rule("auto")
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=None)
    assert _claim(sub, jid, rate=120.0)["auto_approved"] is False
    assert _state(jid)["requests"][sub.cleaner_id][0] == "pending"


def test_first_to_claim_wins_fcfs(world):
    """The owner's marketplace: whoever claims a posted job first gets it, and
    the offer closes — the second claimant is turned away at the door. No rival
    check picks a winner; claiming IS the sub choosing."""
    _rule("auto")
    a, b = _mk_sub(world), _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)

    # A claims first — instant, theirs, offer closed.
    assert _claim(a, jid)["auto_approved"] is True
    st = _state(jid)
    assert st["cleaners"] == [a.cleaner_id] and st["open"] is False

    # B claims the same job — the offer is gone, so the endpoint refuses it
    # outright (409), rather than filing a request against a closed job.
    api = _api(b)
    try:
        r = api.post(f"/api/crew/jobs/{jid}/claim", json={})
        assert r.status_code == 409, r.text
    finally:
        _clear()
    assert _state(jid)["cleaners"] == [a.cleaner_id], "still A's — first wins"


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


def test_a_grandfathered_sub_with_a_gap_is_not_auto_awarded(world):
    """BB-CLAIM-01: instant claim uses the STRICT vetting answer, not the
    grandfathered one. A sub who predates crew_vetting_enforce_from passes the
    /ask gate (blocking_requirements is empty for them), but an incomplete file
    must NOT auto-award — it falls through to the office. This is what makes
    instant claim safe to turn on over a bench that still has grandfathered
    accounts."""
    from services.claim_autoapprove import why_not
    from services.sub_vetting import blocking_requirements
    from database.models import AppSetting, User

    _rule("auto")
    sub = _mk_sub(world, complete=False)          # a real gap in the file
    jid = _mk_job(world)

    db = SessionLocal()
    # Grandfather them in: enforce-from is AFTER their creation, so the /ask
    # gate would let them work.
    set_setting(db, "crew_vetting_enforce_from",
                (business_today() + timedelta(days=1)).isoformat())
    db.commit()
    try:
        user = db.query(User).filter(User.id == sub.id).first()
        # The leak this closes: the /ask gate sees nothing owing...
        assert blocking_requirements(db, user) == []
        # ...but the instant-award gate still refuses the incomplete file.
        job = db.query(Job).filter(Job.id == jid).first()
        req = JobClaimRequest(org_id=1, job_id=jid, cleaner_id=sub.cleaner_id,
                              user_id=sub.id, requested_rate=None, status="pending")
        db.add(req); db.commit(); db.refresh(req)
        assert why_not(db, job, req) == "not_vetted"
    finally:
        db.query(AppSetting).filter(AppSetting.key == "crew_vetting_enforce_from")\
            .delete(synchronize_session=False)
        db.commit(); db.close()


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


# ── The losers hear why ──────────────────────────────────────────────────────

def test_an_instant_claim_gives_the_people_it_passes_over_a_reason(world):
    """When a claim instant-approves, everyone still pending on that job is
    auto-declined — and each of them gets a reason to read, not a bare
    "someone else got it" (migration 111). The office typed nothing here, so
    the default phrase stands in; a reason the office DID type is never
    overwritten (that path is claim_approval's own tests)."""
    _rule("auto")
    a, b = _mk_sub(world), _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)

    # A opens a negotiation above the posted price — it waits, staying pending
    # and leaving the offer open.
    assert _claim(a, jid, rate=120.0)["auto_approved"] is False
    assert _state(jid)["open"] is True

    # B claims at the posted price — instant, and that approval turns A down.
    assert _claim(b, jid)["auto_approved"] is True

    db = SessionLocal()
    a_req = (db.query(JobClaimRequest)
             .filter(JobClaimRequest.job_id == jid,
                     JobClaimRequest.cleaner_id == a.cleaner_id).first())
    status, reason = a_req.status, a_req.reason
    db.close()
    assert status == "declined"
    assert reason and "picked" in reason.lower(), reason


# ── The row lock (the fix) ───────────────────────────────────────────────────

def test_consider_locks_both_the_job_and_the_request_for_update(world, monkeypatch):
    """The lock is the fix. approve()'s contract is that the caller holds the
    Job and the request FOR UPDATE; the office endpoint has since Phase 4, and
    this caller did not. Without it, two subs asking at once — or the office
    approving one while this approves the other — each pass why_not()'s rival
    check (neither yet seeing the other's request) and both reach approve(),
    putting two subs on a one-person job.

    Asserted at the QUERY level, not by observing a double-book: SQLite renders
    no FOR UPDATE and serializes writers, so a single-process test cannot stage
    the race. What is dialect-independent — and what fails on the unfixed
    consider() (zero locks) — is that consider ASKS the DB to lock both rows
    before it decides. On Postgres that ask is what serializes the two callers.
    """
    from sqlalchemy.orm import Query
    locked = []
    orig = Query.with_for_update

    def spy(self, *a, **k):
        try:
            locked.append(self.column_descriptions[0]["entity"].__name__)
        except Exception:
            locked.append("?")
        return orig(self, *a, **k)

    monkeypatch.setattr(Query, "with_for_update", spy)

    from services.claim_autoapprove import consider
    _rule("auto")
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)

    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    req = JobClaimRequest(org_id=1, job_id=jid, cleaner_id=sub.cleaner_id,
                          user_id=sub.id, requested_rate=None, status="pending",
                          created_at=business_today(), updated_at=business_today())
    db.add(req); db.commit(); db.refresh(req)
    locked.clear()  # ignore any locks taken during setup

    out = consider(db, job, req, org_id=1)
    db.close()

    # It still approves the clean request — the lock did not change the outcome.
    assert out["auto_approved"] is True, out
    # And it locked BOTH rows on the way there.
    assert "Job" in locked, "consider must lock the Job FOR UPDATE"
    assert "JobClaimRequest" in locked, "consider must lock the request FOR UPDATE"

    st = _state(jid)
    assert st["cleaners"] == [sub.cleaner_id]
    assert st["open"] is False


def test_consider_refuses_if_the_row_vanished_under_the_lock(world):
    """The re-read can come back empty — the request deleted, the job gone — in
    which case there is nothing to approve. It must refuse, not raise."""
    from services.claim_autoapprove import consider
    _rule("auto")
    sub = _mk_sub(world)
    jid = _mk_job(world, posted_rate=80.0)

    db = SessionLocal()
    job = db.query(Job).filter(Job.id == jid).first()
    req = JobClaimRequest(org_id=1, job_id=jid, cleaner_id=sub.cleaner_id,
                          user_id=sub.id, requested_rate=None, status="pending",
                          created_at=business_today(), updated_at=business_today())
    db.add(req); db.commit(); db.refresh(req)
    rid = req.id

    # It's gone by the time consider re-reads it.
    db.query(JobClaimRequest).filter(JobClaimRequest.id == rid).delete()
    db.commit()

    out = consider(db, job, req, org_id=1)
    db.close()
    assert out["auto_approved"] is False
    assert out["reason"] == "gone"
