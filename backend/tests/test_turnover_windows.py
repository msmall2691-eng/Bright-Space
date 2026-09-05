"""The Saturday window: posting a day as a batch, and the price ladder
(marketplace pivot Phase 5, migration 101).

STR turnovers can't be routes — the volume swings week to week — so they stay
posted jobs. A window opens the whole service day at once and then does the
part a person otherwise does badly at 9pm on Friday: it raises the price on
whatever nobody has taken.

The tests that matter here are the ones about NOT touching work somebody has
already agreed to:

  * opening skips a taken job, and re-opening is safe (the tick calls it daily);
  * a step reprices only the unclaimed ones — repricing a job a person has
    already accepted is the version of this bug that costs money and trust;
  * the ladder adds a percentage of the BASE, so five 10% steps are +50% and
    not +61%;
  * it refuses at the ceiling and refuses twice in a day, so a redeploy can't
    climb it in an afternoon;
  * closing leaves every job exactly as it is (R7).

Plus the interaction this phase would otherwise have created: the STR
auto-assign tick must not assign a job that's on the open board, or the window
would post Saturday to the bench on Wednesday and the tick would hand it out
on Thursday with nobody having agreed to anything.
"""
import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, TurnoverWindow, User
from modules.auth.router import get_current_user, current_org_id
from services import turnover_windows as svc
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 9501, 1, "admin", "active", True
    email = "window-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


class _Manager:
    id, org_id, role, status, active = 9502, 1, "manager", "active", True
    email = "window-manager@example.com"
    full_name = "A Manager"
    cleaner_id = None


def _api(user=None):
    app.dependency_overrides[get_current_user] = lambda: (user or _Admin())
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def world():
    made = {"clients": [], "properties": [], "jobs": [], "windows": []}
    yield made
    db = SessionLocal()
    db.query(Job).filter(Job.id.in_(made["jobs"] or [0])).delete(synchronize_session=False)
    db.query(TurnoverWindow).filter(TurnoverWindow.id.in_(made["windows"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_turnovers(made, when, n=3, org_id=1, job_type="str_turnover"):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"STR {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); made["clients"].append(c.id)
    ids = []
    for i in range(n):
        p = Property(client_id=c.id, name=f"Cabin {i} {tag}", address=f"{i} Lake Rd {tag}",
                     property_type="str", active=True, org_id=org_id)
        db.add(p); db.commit(); db.refresh(p); made["properties"].append(p.id)
        from datetime import time as _t
        j = Job(client_id=c.id, property_id=p.id, job_type=job_type,
                title=f"Turnover {i} {tag}", scheduled_date=when,
                start_time=_t(11, 0), end_time=_t(14, 0), status="scheduled",
                cleaner_ids=[], org_id=org_id)
        db.add(j); db.commit(); db.refresh(j)
        made["jobs"].append(j.id); ids.append(j.id)
    db.close()
    return ids


def _mk_window(made, api, when, **kw):
    body = {"service_date": when.isoformat(), "base_rate": 100.0,
            "step_pct": 10.0, "max_steps": 3, **kw}
    r = api.post("/api/turnover-windows", json=body)
    assert r.status_code == 200, r.text
    made["windows"].append(r.json()["id"])
    return r.json()


def _job(jid):
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    out = {"open": bool(j.open_for_claims), "posted": j.posted_rate,
           "agreed": j.agreed_rate, "cleaners": list(j.cleaner_ids or [])}
    db.close()
    return out


def _take(jid, cleaner_id="CT-TOOK", agreed=95.0):
    """Somebody claimed this one and the office approved it."""
    db = SessionLocal()
    j = db.query(Job).filter(Job.id == jid).first()
    j.cleaner_ids = [cleaner_id]
    j.agreed_rate = agreed
    j.open_for_claims = False
    db.commit(); db.close()


def _window_row(wid):
    db = SessionLocal()
    w = db.query(TurnoverWindow).filter(TurnoverWindow.id == wid).first()
    db.expunge(w); db.close()
    return w


# ── The ladder, on its own ──────────────────────────────────────────────────

def test_steps_add_a_percentage_of_the_base_never_of_the_current_price():
    """Compounding a 10% ladder five times is +61%, which is not what anybody
    typed into the box."""
    w = TurnoverWindow(service_date=date(2026, 7, 4), base_rate=100.0,
                       step_pct=10.0, max_steps=5, steps_taken=0)
    assert svc.current_rate(w) == 100.0
    for step, expected in ((1, 110.0), (2, 120.0), (3, 130.0), (5, 150.0)):
        w.steps_taken = step
        assert svc.current_rate(w) == expected


def test_a_window_with_no_base_rate_has_no_rate_to_report():
    w = TurnoverWindow(service_date=date(2026, 7, 4), base_rate=None,
                       step_pct=10.0, max_steps=3, steps_taken=2)
    assert svc.current_rate(w) is None


# ── Opening ─────────────────────────────────────────────────────────────────

def test_opening_posts_the_days_turnovers_at_the_base_rate(world):
    when = business_today() + timedelta(days=9)
    jids = _mk_turnovers(world, when, n=3)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        assert w["status"] == "pending"
        assert all(_job(j)["open"] is False for j in jids)

        r = api.post(f"/api/turnover-windows/{w['id']}/open")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "open"
        assert r.json()["just_opened"] == 3
        for j in jids:
            assert _job(j) == {"open": True, "posted": 100.0, "agreed": None, "cleaners": []}
    finally:
        _clear()


def test_opening_never_touches_a_job_somebody_already_took(world):
    """The daily tick calls open every day a window is open, so this runs
    constantly — and it must never reopen or reprice taken work."""
    when = business_today() + timedelta(days=9)
    jids = _mk_turnovers(world, when, n=3)
    _take(jids[0], agreed=95.0)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        r = api.post(f"/api/turnover-windows/{w['id']}/open").json()
        assert (r["just_opened"], r["already_taken"]) == (2, 1)
        assert _job(jids[0]) == {"open": False, "posted": None,
                                 "agreed": 95.0, "cleaners": ["CT-TOOK"]}

        # And again, as the tick would.
        again = api.post(f"/api/turnover-windows/{w['id']}/open").json()
        assert again["already_taken"] == 1
        assert _job(jids[0])["cleaners"] == ["CT-TOOK"]
    finally:
        _clear()


def test_only_str_turnovers_are_posted_by_a_window(world):
    """A residential clean that happens to fall on a Saturday is not a guest
    changeover, and quietly putting it on the bench would be a surprise."""
    when = business_today() + timedelta(days=9)
    turnovers = _mk_turnovers(world, when, n=1)
    others = _mk_turnovers(world, when, n=1, job_type="residential")
    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        assert _job(turnovers[0])["open"] is True
        assert _job(others[0])["open"] is False
    finally:
        _clear()


# ── The step-up ─────────────────────────────────────────────────────────────

def test_a_step_reprices_only_what_nobody_has_taken(world):
    """Repricing a job somebody already accepted is the version of this bug
    that costs money and trust."""
    when = business_today() + timedelta(days=3)
    jids = _mk_turnovers(world, when, n=3)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        _take(jids[0], agreed=100.0)

        r = api.post(f"/api/turnover-windows/{w['id']}/step")
        assert r.status_code == 200, r.text
        body = r.json()
        assert (body["steps_taken"], body["current_rate"]) == (1, 110.0)
        assert _job(jids[0])["agreed"] == 100.0, "a taken job keeps its agreed price"
        # Its posted_rate is the number it was taken at and stays there. The
        # bug this guards is it climbing to 110 alongside the unclaimed ones.
        assert _job(jids[0])["posted"] == 100.0
        assert _job(jids[1])["posted"] == 110.0
        assert _job(jids[2])["posted"] == 110.0
    finally:
        _clear()


def test_the_ladder_refuses_a_second_step_the_same_day(world):
    """A redeploy, or somebody pressing it twice, must not climb the ladder in
    an afternoon."""
    when = business_today() + timedelta(days=3)
    _mk_turnovers(world, when, n=2)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        assert api.post(f"/api/turnover-windows/{w['id']}/step").status_code == 200
        again = api.post(f"/api/turnover-windows/{w['id']}/step")
        assert again.status_code == 409
        assert "already stepped today" in again.json()["detail"]
    finally:
        _clear()


def test_the_ladder_stops_at_the_ceiling(world):
    """max_steps is the office's stated view of what a Saturday is worth.
    Nothing may exceed it."""
    when = business_today() + timedelta(days=3)
    jids = _mk_turnovers(world, when, n=1)
    api = _api()
    try:
        w = _mk_window(world, api, when, max_steps=2)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        db = SessionLocal()
        for expected in (110.0, 120.0):
            row = db.query(TurnoverWindow).filter(TurnoverWindow.id == w["id"]).first()
            row.last_stepped_at = None        # pretend a day passed
            db.commit()
            assert svc.step_window(db, row)["posted_rate"] == expected
        row = db.query(TurnoverWindow).filter(TurnoverWindow.id == w["id"]).first()
        row.last_stepped_at = None
        db.commit()
        refused = svc.step_window(db, row)
        db.close()
        assert refused == {"stepped": False, "reason": "at the ceiling"}
        assert _job(jids[0])["posted"] == 120.0
    finally:
        _clear()


def test_a_window_with_nothing_left_open_does_not_step(world):
    when = business_today() + timedelta(days=3)
    jids = _mk_turnovers(world, when, n=2)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        for j in jids:
            _take(j)
        r = api.post(f"/api/turnover-windows/{w['id']}/step")
        assert r.status_code == 409
        assert "everything is taken" in r.json()["detail"]
    finally:
        _clear()


# ── The daily pass ──────────────────────────────────────────────────────────

def test_the_tick_opens_a_window_whose_day_has_arrived_and_not_one_that_hasnt(world):
    soon = business_today() + timedelta(days=3)     # inside open_days_before=10
    far = business_today() + timedelta(days=40)     # not yet
    soon_jobs = _mk_turnovers(world, soon, n=1)
    far_jobs = _mk_turnovers(world, far, n=1)
    api = _api()
    try:
        _mk_window(world, api, soon)
        _mk_window(world, api, far)
    finally:
        _clear()

    db = SessionLocal()
    svc.run_due(db)
    db.close()
    assert _job(soon_jobs[0])["open"] is True
    assert _job(far_jobs[0])["open"] is False


def test_a_missed_opening_day_is_still_opened_later_not_skipped_forever(world):
    """Same failure the recurring-generation starvation fix addressed: a deploy
    on the opening day must not lose the window."""
    when = business_today() + timedelta(days=2)     # opening day was 8 days ago
    jids = _mk_turnovers(world, when, n=1)
    api = _api()
    try:
        _mk_window(world, api, when, open_days_before=10)
    finally:
        _clear()
    db = SessionLocal()
    assert len(svc.due_to_open(db)) == 1
    svc.run_due(db)
    db.close()
    assert _job(jids[0])["open"] is True


def test_a_window_for_a_past_day_is_not_opened(world):
    when = business_today() - timedelta(days=2)
    jids = _mk_turnovers(world, when, n=1)
    api = _api()
    try:
        _mk_window(world, api, when)
    finally:
        _clear()
    db = SessionLocal()
    assert svc.due_to_open(db) == []
    db.close()
    assert _job(jids[0])["open"] is False


def test_the_ladder_only_starts_inside_first_step_days_before(world):
    early = business_today() + timedelta(days=8)    # open, but not yet stepping
    jids = _mk_turnovers(world, early, n=1)
    api = _api()
    try:
        w = _mk_window(world, api, early, first_step_days_before=4)
        api.post(f"/api/turnover-windows/{w['id']}/open")
    finally:
        _clear()
    db = SessionLocal()
    assert svc.due_to_step(db) == []
    svc.run_due(db)
    db.close()
    assert _job(jids[0])["posted"] == 100.0, "still at the base price"


# ── Closing ─────────────────────────────────────────────────────────────────

def test_closing_stops_the_ladder_and_changes_no_job(world):
    """R7: closing is the office saying it has stopped bidding, not a cleanup.
    An unclaimed turnover stays on the board — somebody taking it late still
    beats nobody taking it."""
    when = business_today() + timedelta(days=3)
    jids = _mk_turnovers(world, when, n=2)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        before = [_job(j) for j in jids]

        r = api.post(f"/api/turnover-windows/{w['id']}/close")
        assert r.status_code == 200
        assert r.json()["status"] == "closed"
        assert [_job(j) for j in jids] == before

        assert api.post(f"/api/turnover-windows/{w['id']}/step").status_code == 409
    finally:
        _clear()


def test_an_opened_window_cannot_be_deleted(world):
    when = business_today() + timedelta(days=3)
    _mk_turnovers(world, when, n=1)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        assert api.delete(f"/api/turnover-windows/{w['id']}").status_code == 200

        w2 = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w2['id']}/open")
        r = api.delete(f"/api/turnover-windows/{w2['id']}")
        assert r.status_code == 409
        assert "Close it instead" in r.json()["detail"]
    finally:
        _clear()


def test_two_windows_for_one_day_are_refused(world):
    """Two ladders on one Saturday would step the same jobs twice."""
    when = business_today() + timedelta(days=9)
    api = _api()
    try:
        _mk_window(world, api, when)
        r = api.post("/api/turnover-windows",
                     json={"service_date": when.isoformat(), "base_rate": 50.0})
        assert r.status_code == 409
    finally:
        _clear()


# ── The state an owner reads ────────────────────────────────────────────────

def test_the_window_states_coverage_plainly_rather_than_making_you_work_it_out(world):
    when = business_today() + timedelta(days=3)
    jids = _mk_turnovers(world, when, n=4)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        _take(jids[0], agreed=100.0)
        _take(jids[1], agreed=105.0)

        state = api.get(f"/api/turnover-windows/{w['id']}").json()
        assert (state["total"], state["covered"], state["uncovered"]) == (4, 2, 2)
        assert state["committed"] == 205.0        # what's agreed
        assert state["exposure"] == 200.0         # what the rest costs at today's price
        assert state["days_out"] == 3
        assert state["at_ceiling"] is False
    finally:
        _clear()


# ── The interaction this phase would otherwise have created ─────────────────

def test_auto_assign_will_not_take_a_job_off_the_open_board(world):
    """Without this, the window posts Saturday to the bench on Wednesday and
    the 5am auto-assign tick hands it out on Thursday — with nobody having
    agreed to anything, which is exactly what a subcontractor arrangement
    cannot do.

    Both directions are asserted. An identical turnover on the same day that is
    NOT on the board still gets picked, so the test proves the filter and not
    merely that auto-assign found nothing to do — which is what an empty
    roster would have proved.
    """
    from modules.scheduling.router import auto_assign_unassigned_turnovers

    when = business_today() + timedelta(days=3)
    posted = _mk_turnovers(world, when, n=2)
    control = _mk_turnovers(world, when, n=1)[0]

    # The roster is derived from cleaner_ids that appear on real jobs, so
    # without an assigned job somewhere there is no candidate and this test
    # would pass for the wrong reason.
    roster_job = _mk_turnovers(world, business_today() + timedelta(days=1), n=1)[0]
    _take(roster_job, cleaner_id="CT-ROSTER", agreed=80.0)

    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        # Take the control back off the board — same day, same shape, not posted.
        db = SessionLocal()
        j = db.query(Job).filter(Job.id == control).first()
        j.open_for_claims, j.posted_rate = False, None
        db.commit(); db.close()
    finally:
        _clear()

    db = SessionLocal()
    preview = auto_assign_unassigned_turnovers(db, dry_run=True, org_id=1)
    db.close()
    picked = {a.get("job_id") for a in (preview.get("assigned") or [])}
    assert control in picked, "auto-assign should still place ordinary turnovers"
    assert not (picked & set(posted)), "a job on the open board belongs to whoever asks for it"


# ── Access and tenancy ──────────────────────────────────────────────────────

def test_a_manager_can_open_and_close_but_only_an_admin_steps_the_price(world):
    when = business_today() + timedelta(days=3)
    _mk_turnovers(world, when, n=1)
    api = _api(_Manager())
    try:
        w = _mk_window(world, api, when)
        assert api.post(f"/api/turnover-windows/{w['id']}/open").status_code == 200
        assert api.post(f"/api/turnover-windows/{w['id']}/step").status_code == 403
        assert api.post(f"/api/turnover-windows/{w['id']}/close").status_code == 200
    finally:
        _clear()


def test_turnover_windows_is_rls_protected():
    from database.rls import TENANT_TABLES
    assert "turnover_windows" in TENANT_TABLES


def test_another_orgs_window_is_invisible_and_unreachable(world):
    when = business_today() + timedelta(days=9)
    db = SessionLocal()
    other = TurnoverWindow(org_id=2, service_date=when, status="pending", base_rate=999.0)
    db.add(other); db.commit(); db.refresh(other)
    other_id = other.id
    db.close()
    api = _api()
    try:
        assert other_id not in [x["id"] for x in api.get("/api/turnover-windows").json()["windows"]]
        assert api.get(f"/api/turnover-windows/{other_id}").status_code == 404
        assert api.post(f"/api/turnover-windows/{other_id}/step").status_code == 404
    finally:
        _clear()
        db = SessionLocal()
        db.query(TurnoverWindow).filter(TurnoverWindow.id == other_id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_a_windows_jobs_do_not_reach_across_orgs(world):
    """The other org's turnover on the same Saturday is not this window's work."""
    when = business_today() + timedelta(days=9)
    mine = _mk_turnovers(world, when, n=1)
    theirs = _mk_turnovers(world, when, n=1, org_id=2)
    api = _api()
    try:
        w = _mk_window(world, api, when)
        api.post(f"/api/turnover-windows/{w['id']}/open")
        assert _job(mine[0])["open"] is True
        assert _job(theirs[0])["open"] is False
    finally:
        _clear()
