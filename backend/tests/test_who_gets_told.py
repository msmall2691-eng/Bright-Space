"""Who finds out, and what they're told — review findings 11, 13, 14, 15, 16.

Five separate notes, one subject: the marketplace changed how work is offered
and nobody updated what the app SAYS about it, or checked that the saying
arrives.

11. A sub files a request and the only thing that happens is a web push to the
    office. No push subscription, push turned off, VAPID unset in the
    environment — and the request sits unseen until somebody happens to open
    that job. Nothing on any screen carries the count.

13. `claim_approval.notify()` pushes to SUBS with `category="crew"`. "crew" is
    an OFFICE category (push_service.OFFICE_NOTIFICATION_CATEGORIES). A
    subcontractor's notification settings offer job_assignments, open_jobs,
    office_messages, time_off and digest — none of which govern the two
    messages that matter most to them. Their toggles are decorative.

14. The winner and the losers are notified inside ONE try/except that ends in
    a bare `pass`. If the winner's push raises — a dead endpoint, a bad
    subscription row — the loop that tells everyone else never runs, and the
    failure is swallowed without a log. Silence, with no trace of why.

15. The "nobody is on this job" rule opens work to the bench with NO asking
    price, and the proposal the office approves doesn't mention it. A job
    posted at no price can only be worked at a price the sub names — that is a
    negotiation, and the office should know it is opening one.

16. Three places still describe the pre-marketplace world: a Claim button that
    is now an Ask, and "the first claim closes the offer" when what closes it
    is the office approving somebody.
"""
import re
import uuid
from datetime import time as dtime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, JobClaimRequest, Property, User
from modules.auth.router import current_org_id, get_current_user
from utils.dates import business_today

REPO = Path(__file__).resolve().parents[2]


class _Office:
    id, org_id, role, status, active = 9951, 1, "admin", "active", True
    email, full_name, cleaner_id = "told@example.com", "The Office", None


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


def _posted_job(m, *, askers=("CT-DAN",), open_for_claims=True):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Told {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, org_id=1, name=f"{tag} House",
                 address=f"{tag} Told Rd", city="Camden", state="ME")
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, org_id=1, title="Turnover",
            scheduled_date=business_today() + timedelta(days=3),
            start_time=dtime(10, 0), end_time=dtime(13, 0), status="scheduled",
            cleaner_ids=[], open_for_claims=open_for_claims, posted_rate=90.0)
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    ids = []
    for cid in askers:
        r = JobClaimRequest(org_id=1, job_id=j.id, cleaner_id=cid, user_id=None,
                            requested_rate=None, status="pending")
        db.add(r); db.commit(); db.refresh(r); ids.append(r.id)
    jid = j.id; db.close()
    return jid, ids


# ── 11: the office can see it without a push ───────────────────────────────

def test_a_job_carries_how_many_people_have_asked_for_it(made):
    """The office's own screens have to be able to say it. A count that only
    exists inside a web push is a count that doesn't exist on the morning the
    push didn't arrive."""
    job, _ = _posted_job(made, askers=("CT-DAN", "CT-MARIA"))
    rows = _api().get("/api/jobs", params={"limit": 500}).json()
    row = next(r for r in (rows if isinstance(rows, list) else rows["items"]) if r["id"] == job)
    assert row.get("pending_claim_requests") == 2, row.get("pending_claim_requests")


def test_only_the_people_still_waiting_are_counted(made):
    """Declining one of two leaves the job POSTED, so it is still counted —
    which is what makes this test able to fail. (Approving instead closes the
    offer, and a closed job is skipped entirely, so a count that wrongly
    included decided rows would still read zero and prove nothing.)"""
    job, reqs = _posted_job(made, askers=("CT-DAN", "CT-MARIA"))
    api = _api()
    assert api.post(f"/api/jobs/{job}/claim-requests/{reqs[0]}/decline").status_code == 200
    rows = api.get("/api/jobs", params={"limit": 500}).json()
    row = next(r for r in (rows if isinstance(rows, list) else rows["items"]) if r["id"] == job)
    assert row.get("pending_claim_requests") == 1, row.get("pending_claim_requests")


def test_approving_leaves_nobody_waiting(made):
    job, reqs = _posted_job(made, askers=("CT-DAN", "CT-MARIA"))
    api = _api()
    assert api.post(f"/api/jobs/{job}/claim-requests/{reqs[0]}/approve").status_code == 200
    rows = api.get("/api/jobs", params={"limit": 500}).json()
    row = next(r for r in (rows if isinstance(rows, list) else rows["items"]) if r["id"] == job)
    # One approved, one auto-declined, and the offer is closed.
    assert row.get("pending_claim_requests") == 0, row.get("pending_claim_requests")


def test_an_ordinary_job_says_zero_and_costs_nothing(made):
    """The control that keeps this off the hot path: a shop with nothing
    posted must not pay a query per job list."""
    job, _ = _posted_job(made, askers=(), open_for_claims=False)
    rows = _api().get("/api/jobs", params={"limit": 500}).json()
    row = next(r for r in (rows if isinstance(rows, list) else rows["items"]) if r["id"] == job)
    assert row.get("pending_claim_requests") == 0


# ── 13 + 14: the two pushes an approval sends ──────────────────────────────

def test_the_subs_own_settings_govern_what_reaches_them(made, monkeypatch):
    """`category="crew"` is an OFFICE category. Pushing to a sub under it means
    their preferences screen — which never offers "crew" — cannot turn these
    off or on. Winning work is `job_assignments`; losing an offer is
    `open_jobs`, the distinction the categories exist to keep."""
    from services import claim_approval
    sent = []
    monkeypatch.setattr("services.push_service.notify_user",
                        lambda uid, title, body, **kw: sent.append((uid, title, kw.get("category"))))

    class _Job:
        id, title, client_id, agreed_rate = 1, "Turnover", None, 90.0
        scheduled_date = business_today()

    class _Req:
        user_id, cleaner_id = 501, "CT-DAN"

    class _Loser:
        user_id, cleaner_id = 502, "CT-MARIA"

    claim_approval.notify(_Job(), _Req(), [_Loser()])
    by_uid = {uid: cat for uid, _t, cat in sent}
    assert by_uid == {501: "job_assignments", 502: "open_jobs"}, sent


def test_one_dead_phone_does_not_silence_everybody_else(made, monkeypatch, caplog):
    """Finding 14. Winner and losers shared one try/except ending in `pass`, so
    a push that raised for the winner meant nobody else heard anything — and
    nothing was logged to say so."""
    from services import claim_approval
    reached = []

    def _flaky(uid, title, body, **kw):
        if uid == 501:
            raise RuntimeError("dead subscription")
        reached.append(uid)

    monkeypatch.setattr("services.push_service.notify_user", _flaky)

    class _Job:
        id, title, client_id, agreed_rate = 1, "Turnover", None, 90.0
        scheduled_date = business_today()

    class _Req:
        user_id, cleaner_id = 501, "CT-DAN"

    class _L1:
        user_id, cleaner_id = 502, "CT-MARIA"

    class _L2:
        user_id, cleaner_id = 503, "CT-JO"

    claim_approval.notify(_Job(), _Req(), [_L1(), _L2()])
    assert reached == [502, 503], reached


def test_notifying_never_raises_into_the_approval(made, monkeypatch):
    """The control. The assignment is committed by the time this runs; a push
    outage must never look like the job didn't happen."""
    from services import claim_approval
    monkeypatch.setattr("services.push_service.notify_user",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("everything is down")))

    class _Job:
        id, title, client_id, agreed_rate = 1, "Turnover", None, 90.0
        scheduled_date = business_today()

    class _Req:
        user_id, cleaner_id = 501, "CT-DAN"

    claim_approval.notify(_Job(), _Req(), [])  # must not raise


# ── 15: opening work at no price is opening a negotiation ──────────────────

def test_the_office_is_told_when_a_job_goes_up_with_no_asking_price(made):
    from services.crew_escalation import _proposal_detail
    db = SessionLocal()
    try:
        class _NoRate:
            title, posted_rate, scheduled_date = "Deep clean", None, business_today()

        class _Priced:
            title, posted_rate, scheduled_date = "Deep clean", 120.0, business_today()

        assert "price" in _proposal_detail(_NoRate(), "Friday").lower()
        assert "120" in _proposal_detail(_Priced(), "Friday")
    finally:
        db.close()


# ── 16: three places still describing a Claim button ───────────────────────

def test_nothing_still_tells_anyone_the_first_claim_closes_the_offer():
    """A request is not a claim, and it is the office APPROVING somebody that
    closes an offer — not the first person to tap. These three files were
    written before migration 097 and never revisited; one of them is a tooltip
    an operator reads."""
    stale = re.compile(
        r"(first claim|claim button|cleaner can claim|cleaners claim|claim these jobs"
        r"|claim it from their phone|claim path is what closes)", re.I)
    offenders = []
    for rel in ("frontend/src/pages/Schedule.jsx",
                "frontend/src/components/schedule/OpsAlerts.jsx",
                "backend/services/proposals.py",
                "backend/services/crew_escalation.py"):
        text = (REPO / rel).read_text()
        for n, line in enumerate(text.splitlines(), 1):
            if stale.search(line):
                offenders.append(f"{rel}:{n}: {line.strip()}")
    assert not offenders, "still describing the pre-marketplace flow:\n" + "\n".join(offenders)
