"""Routes: offered, never assigned (marketplace pivot Phase 4, migration 100).

The rate split is covered in test_routes_rate_split.py. This is the other half
— who can put a route in somebody's hands, and under what conditions. Every
test here defends one of the three constraints the pivot turns on:

  * A sub REQUESTS OR ACCEPTS; the office never assigns. There is no path that
    makes a route active without the sub's own accept, and the tests look for
    its absence, not just its presence.
  * A sub must be CLEARED TO WORK before taking standing work — checked when
    the office offers AND again when the sub accepts, because a certificate of
    insurance can lapse in between and that gap is the whole reason expiry is
    read from the date rather than the stored status.
  * The route has to be payable before anyone agrees to it: a rate, houses,
    and a time window on each house to split the rate against.

Plus the ordinary hygiene: org scoping, role gates, one winner under a
concurrent accept, and an ended route staying for history rather than being
erased.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Job, Property, RecurringSchedule, Route, RouteMember,
    SubAgreement, SubDocument, User,
)
from modules.auth.router import get_current_user, current_org_id
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 9401, 1, "admin", "active", True
    email = "routes-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


class _Manager:
    id, org_id, role, status, active = 9402, 1, "manager", "active", True
    email = "routes-manager@example.com"
    full_name = "A Manager"
    cleaner_id = None


class _Cleaner:
    def __init__(self, uid, cleaner_id):
        self.id, self.org_id, self.role = uid, 1, "cleaner"
        self.status, self.active = "active", True
        self.email = f"routes-crew-{uid}@example.com"
        self.full_name = f"Sub {uid}"
        self.cleaner_id = cleaner_id


def _api(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _vet(uid, org_id=1, coi_expires_in_days=365):
    """Give a sub a complete, current file (Phase 2, migration 098)."""
    db = SessionLocal()
    db.query(SubDocument).filter(SubDocument.user_id == uid).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id == uid).delete(synchronize_session=False)
    from services.sub_vetting import CURRENT_AGREEMENT_VERSION
    db.add(SubAgreement(org_id=org_id, user_id=uid, version=CURRENT_AGREEMENT_VERSION,
                        accepted_at=business_today()))
    db.add(SubDocument(org_id=org_id, user_id=uid, kind="w9", status="accepted", data=b"x"))
    db.add(SubDocument(org_id=org_id, user_id=uid, kind="coi", status="accepted", data=b"x",
                       expires_at=business_today() + timedelta(days=coi_expires_in_days)))
    db.commit(); db.close()


@pytest.fixture
def world():
    """Two timed houses, an unvetted sub, and a vetted one."""
    tag = uuid.uuid4().hex[:6]
    made = {"clients": [], "properties": [], "scheds": [], "routes": [],
            "users": [], "jobs": []}
    db = SessionLocal()
    c = Client(name=f"Route co {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); made["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"2 Route Rd {tag}", address=f"2 Route Rd {tag}",
                 property_type="residential", active=True, org_id=1)
    db.add(p); db.commit(); db.refresh(p); made["properties"].append(p.id)
    for i, (st, en) in enumerate([(time(9, 0), time(10, 30)), (time(11, 0), time(14, 0))]):
        s = RecurringSchedule(client_id=c.id, property_id=p.id, title=f"House {i} {tag}",
                              job_type="residential", frequency="weekly",
                              days_of_week=[1], day_of_week=1, start_time=st, end_time=en,
                              active=True, generate_weeks_ahead=4,
                              address=f"2 Route Rd {tag}", org_id=1, cleaner_ids=[])
        db.add(s); db.commit(); db.refresh(s); made["scheds"].append(s.id)

    users = {}
    for key, name in (("vetted", "Cleared Sub"), ("unvetted", "New Sub")):
        u = User(email=f"{key}-{tag}@example.com", role="cleaner", full_name=name,
                 org_id=1, active=True, status="active", cleaner_id=f"CT-{key[:3]}{tag[:3]}")
        db.add(u); db.commit(); db.refresh(u)
        users[key] = (u.id, u.cleaner_id); made["users"].append(u.id)
    db.close()
    _vet(users["vetted"][0])

    yield {"schedule_ids": made["scheds"], "users": users, "made": made}

    db = SessionLocal()
    db.query(Job).filter(Job.recurring_schedule_id.in_(made["scheds"] or [0])).delete(synchronize_session=False)
    db.query(RouteMember).filter(RouteMember.recurring_schedule_id.in_(made["scheds"] or [0])).delete(synchronize_session=False)
    db.query(Route).filter(Route.id.in_(made["routes"] or [0])).delete(synchronize_session=False)
    db.query(RecurringSchedule).filter(RecurringSchedule.id.in_(made["scheds"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(made["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_route(world, api, *, rate=400.0, with_houses=True):
    body = {"name": f"Tuesday {uuid.uuid4().hex[:4]}", "day_of_week": 1, "rate": rate}
    if with_houses:
        body["schedule_ids"] = world["schedule_ids"]
    r = api.post("/api/routes", json=body)
    assert r.status_code == 200, r.text
    world["made"]["routes"].append(r.json()["id"])
    return r.json()


def _status(route_id):
    db = SessionLocal()
    row = db.query(Route).filter(Route.id == route_id).first()
    out = (row.status, row.owner_cleaner_id, row.accepted_at)
    db.close()
    return out


# ── Building one ────────────────────────────────────────────────────────────

def test_a_new_route_is_a_draft_and_prices_its_houses_by_duration(world):
    api = _api(_Admin())
    try:
        route = _mk_route(world, api)
        assert route["status"] == "draft"
        assert route["member_count"] == 2
        # 90 and 180 minutes out of 270, from $400 — visible per house, so a
        # route is never priced as one number somebody has to trust.
        assert [m["share"] for m in route["members"]] == [133.33, 266.67]
        assert round(sum(m["share"] for m in route["members"]), 2) == 400.0
        assert route["blocker"] is None
    finally:
        _clear()


def test_a_house_cannot_belong_to_two_routes(world):
    """Two people paid for one house is the expensive version of this bug."""
    api = _api(_Admin())
    try:
        _mk_route(world, api)
        r = api.post("/api/routes", json={"name": "Second", "day_of_week": 1,
                                          "rate": 100.0,
                                          "schedule_ids": world["schedule_ids"][:1]})
        assert r.status_code == 409
        assert "two routes" in r.json()["detail"] or "already on" in r.json()["detail"]
    finally:
        _clear()


def test_a_route_with_no_rate_or_no_houses_says_why_it_cannot_be_offered(world):
    api = _api(_Admin())
    try:
        empty = _mk_route(world, api, with_houses=False)
        assert "no houses" in empty["blocker"]
        r = api.post(f"/api/routes/{empty['id']}/offer",
                     json={"cleaner_id": world["users"]["vetted"][1]})
        assert r.status_code == 409

        unpriced = _mk_route(world, api, rate=0.0)
        assert "no rate" in unpriced["blocker"]
    finally:
        _clear()


# ── Offering, and the vetting gate ──────────────────────────────────────────

def test_an_unvetted_sub_cannot_be_offered_a_route(world):
    """Standing work is the last place to discover somebody is uninsured."""
    api = _api(_Admin())
    try:
        route = _mk_route(world, api)
        r = api.post(f"/api/routes/{route['id']}/offer",
                     json={"cleaner_id": world["users"]["unvetted"][1]})
        assert r.status_code == 403
        detail = r.json()["detail"]
        assert any("insurance" in m.lower() for m in detail["missing"]), detail
        assert _status(route["id"])[0] == "draft", "a refused offer changes nothing"
    finally:
        _clear()


def test_offering_names_an_intended_owner_but_does_not_assign_the_route(world):
    """The control point. `offered` is not `active`, and only the sub can
    close that gap."""
    api = _api(_Admin())
    try:
        route = _mk_route(world, api)
        cid = world["users"]["vetted"][1]
        r = api.post(f"/api/routes/{route['id']}/offer", json={"cleaner_id": cid})
        assert r.status_code == 200, r.text
        status, owner, accepted_at = _status(route["id"])
        assert status == "offered"
        assert owner == cid
        assert accepted_at is None, "nobody has agreed to anything yet"

        # And there is no office path to `active`: PATCH can't set a status,
        # and the only other office verbs are offer, end and delete.
        after = api.patch(f"/api/routes/{route['id']}",
                          json={"name": "Renamed", "rate": 450.0}).json()
        assert after["status"] == "offered"
    finally:
        _clear()


def test_offer_check_shows_the_problems_before_the_offer_is_sent(world):
    api = _api(_Admin())
    try:
        route = _mk_route(world, api)
        uid, cid = world["users"]["unvetted"]
        r = api.get(f"/api/routes/{route['id']}/offer-check?cleaner_id={cid}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["known"] is True
        assert body["missing"], "an unvetted sub's file problems are the point"
        assert body["blocker"] is None
        assert body["conflicts"] == []
    finally:
        _clear()


# ── Accepting ───────────────────────────────────────────────────────────────

def _offered_route(world, cid=None):
    admin = _api(_Admin())
    route = _mk_route(world, admin)
    cid = cid or world["users"]["vetted"][1]
    assert admin.post(f"/api/routes/{route['id']}/offer",
                      json={"cleaner_id": cid}).status_code == 200
    _clear()
    return route


def test_the_sub_accepting_is_what_makes_a_route_active(world):
    world_route = _offered_route(world)
    uid, cid = world["users"]["vetted"]
    api = _api(_Cleaner(uid, cid))
    try:
        mine = api.get("/api/crew/my-routes").json()
        assert [r["id"] for r in mine["offered"]] == [world_route["id"]]
        assert mine["active"] == []
        # The houses ride the offer: agreeing to a block you can't see isn't
        # agreeing to it.
        assert len(mine["offered"][0]["members"]) == 2

        r = api.post(f"/api/crew/routes/{world_route['id']}/accept")
        assert r.status_code == 200, r.text
        status, owner, accepted_at = _status(world_route["id"])
        assert (status, owner) == ("active", cid)
        assert accepted_at is not None
    finally:
        _clear()


def test_accepting_twice_is_refused(world):
    """Two taps on a slow phone are one accept."""
    world_route = _offered_route(world)
    uid, cid = world["users"]["vetted"]
    api = _api(_Cleaner(uid, cid))
    try:
        assert api.post(f"/api/crew/routes/{world_route['id']}/accept").status_code == 200
        again = api.post(f"/api/crew/routes/{world_route['id']}/accept")
        assert again.status_code == 409
        assert "already got" in again.json()["detail"]
    finally:
        _clear()


def test_a_lapsed_file_between_offer_and_accept_stops_the_accept(world):
    """The re-check, and the reason it reads the expiry date.

    The office offered while the certificate was good. It lapses before the
    sub taps accept. Nobody touches a document row on the day it expires, so a
    stored `status` would still say accepted — `is_expired` reads `expires_at`
    instead, and this is the case that matters.
    """
    world_route = _offered_route(world)
    uid, cid = world["users"]["vetted"]

    db = SessionLocal()
    coi = (db.query(SubDocument)
           .filter(SubDocument.user_id == uid, SubDocument.kind == "coi").first())
    coi.expires_at = business_today() - timedelta(days=1)
    assert coi.status == "accepted", "the stored status is deliberately left alone"
    db.commit(); db.close()

    api = _api(_Cleaner(uid, cid))
    try:
        r = api.post(f"/api/crew/routes/{world_route['id']}/accept")
        assert r.status_code == 403, r.text
        assert any("expired" in m.lower() for m in r.json()["detail"]["missing"])
        assert _status(world_route["id"])[0] == "offered"
    finally:
        _clear()


def test_a_route_offered_to_someone_else_is_invisible_and_unacceptable(world):
    world_route = _offered_route(world)
    other_uid, other_cid = world["users"]["unvetted"]
    api = _api(_Cleaner(other_uid, other_cid))
    try:
        assert api.get("/api/crew/my-routes").json() == {"offered": [], "active": []}
        r = api.post(f"/api/crew/routes/{world_route['id']}/accept")
        # Same answer as "doesn't exist" — whose route this is isn't
        # information for somebody it wasn't offered to.
        assert r.status_code == 404
    finally:
        _clear()


def test_declining_hands_the_route_back_as_an_unowned_draft(world):
    """Back to draft, not to a terminal-sounding status: the office's next move
    is to offer it to somebody else."""
    world_route = _offered_route(world)
    uid, cid = world["users"]["vetted"]
    api = _api(_Cleaner(uid, cid))
    try:
        r = api.post(f"/api/crew/routes/{world_route['id']}/decline")
        assert r.status_code == 200, r.text
        status, owner, _ = _status(world_route["id"])
        assert (status, owner) == ("draft", None)
        assert api.get("/api/crew/my-routes").json()["offered"] == []
    finally:
        _clear()


def test_an_accepted_route_cannot_be_declined_away_quietly(world):
    world_route = _offered_route(world)
    uid, cid = world["users"]["vetted"]
    api = _api(_Cleaner(uid, cid))
    try:
        api.post(f"/api/crew/routes/{world_route['id']}/accept")
        r = api.post(f"/api/crew/routes/{world_route['id']}/decline")
        assert r.status_code == 409
        assert _status(world_route["id"])[0] == "active"
    finally:
        _clear()


# ── Ending ──────────────────────────────────────────────────────────────────

def test_ending_a_route_keeps_it_and_leaves_generated_work_priced(world):
    """R7: no automated path deletes or reprices a Job. Ending a route is a
    statement about the future."""
    world_route = _offered_route(world)
    uid, cid = world["users"]["vetted"]
    crew = _api(_Cleaner(uid, cid))
    crew.post(f"/api/crew/routes/{world_route['id']}/accept")
    _clear()

    from modules.recurring.router import generate_jobs
    db = SessionLocal()
    for sid in world["schedule_ids"]:
        generate_jobs(db, db.query(RecurringSchedule).filter(RecurringSchedule.id == sid).first())
    before = {(j.id, j.agreed_rate, tuple(j.cleaner_ids or []))
              for j in db.query(Job).filter(
                  Job.recurring_schedule_id.in_(world["schedule_ids"])).all()}
    db.close()
    assert before, "the accepted route should have generated priced visits"

    api = _api(_Admin())
    try:
        r = api.post(f"/api/routes/{world_route['id']}/end", json={})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "ended"

        db = SessionLocal()
        after = {(j.id, j.agreed_rate, tuple(j.cleaner_ids or []))
                 for j in db.query(Job).filter(
                     Job.recurring_schedule_id.in_(world["schedule_ids"])).all()}
        db.close()
        assert after == before, "already-generated work keeps its owner and its price"

        # And the route is still there to explain those jobs.
        assert api.get(f"/api/routes/{world_route['id']}").status_code == 200
    finally:
        _clear()


def test_only_a_draft_can_be_deleted(world):
    world_route = _offered_route(world)
    api = _api(_Admin())
    try:
        r = api.delete(f"/api/routes/{world_route['id']}")
        assert r.status_code == 409
        assert "End the route instead" in r.json()["detail"]

        draft = _mk_route(world, api, with_houses=False)
        assert api.delete(f"/api/routes/{draft['id']}").status_code == 200
    finally:
        _clear()


# ── Access ──────────────────────────────────────────────────────────────────

def test_a_cleaner_cannot_reach_the_office_route_endpoints(world):
    uid, cid = world["users"]["vetted"]
    api = _api(_Cleaner(uid, cid))
    try:
        assert api.get("/api/routes").status_code == 403
        assert api.post("/api/routes", json={"name": "Mine", "day_of_week": 1}).status_code == 403
    finally:
        _clear()


def test_a_manager_can_build_and_offer_but_only_an_admin_can_delete(world):
    api = _api(_Manager())
    try:
        route = _mk_route(world, api)
        assert api.post(f"/api/routes/{route['id']}/offer",
                        json={"cleaner_id": world["users"]["vetted"][1]}).status_code == 200
    finally:
        _clear()
    draft_api = _api(_Admin())
    try:
        draft = _mk_route(world, draft_api, with_houses=False)
    finally:
        _clear()
    mgr = _api(_Manager())
    try:
        assert mgr.delete(f"/api/routes/{draft['id']}").status_code == 403
    finally:
        _clear()


# ── Tenancy (MT-3) ──────────────────────────────────────────────────────────

def test_routes_tables_are_rls_protected():
    from database.rls import TENANT_TABLES
    assert "routes" in TENANT_TABLES and "route_members" in TENANT_TABLES


def test_another_orgs_route_is_not_visible_or_reachable(world):
    db = SessionLocal()
    other = Route(name="Their Tuesday", day_of_week=1, rate=500.0, status="draft", org_id=2)
    db.add(other); db.commit(); db.refresh(other)
    other_id = other.id
    db.close()
    api = _api(_Admin())      # org 1
    try:
        assert other_id not in [r["id"] for r in api.get("/api/routes").json()["routes"]]
        assert api.get(f"/api/routes/{other_id}").status_code == 404
        assert api.patch(f"/api/routes/{other_id}", json={"rate": 1.0}).status_code == 404
    finally:
        _clear()
        db = SessionLocal()
        db.query(Route).filter(Route.id == other_id).delete(synchronize_session=False)
        db.commit(); db.close()


# ── Margin ──────────────────────────────────────────────────────────────────

def test_the_margin_comes_from_real_invoices_and_says_nothing_when_there_are_none(world):
    """A route priced without its billed total is priced by feel.

    Recurring schedules carry no price of their own, so the only honest source
    is what was actually charged for the visits these houses generated. And
    "nothing invoiced yet" reports as no data, not as 100% margin — the
    cheerful version of that number is the dangerous one.
    """
    from database.models import Invoice

    api = _api(_Admin())
    try:
        route = _mk_route(world, api, rate=300.0)
        assert api.get(f"/api/routes/{route['id']}").json()["billing"]["billed"] is None

        # Two completed visits on one past day, invoiced at 250 + 200.
        db = SessionLocal()
        when = business_today() - timedelta(days=7)
        made_jobs, made_invoices = [], []
        for sid, amount in zip(world["schedule_ids"], (250.0, 200.0)):
            s = db.query(RecurringSchedule).filter(RecurringSchedule.id == sid).first()
            j = Job(client_id=s.client_id, property_id=s.property_id, org_id=1,
                    job_type="residential", title="Past visit", scheduled_date=when,
                    start_time=s.start_time, end_time=s.end_time,
                    status="completed", cleaner_ids=[], recurring_schedule_id=sid)
            db.add(j); db.commit(); db.refresh(j); made_jobs.append(j.id)
            inv = Invoice(org_id=1, client_id=s.client_id, job_id=j.id,
                          total=amount, status="sent")
            db.add(inv); db.commit(); db.refresh(inv); made_invoices.append(inv.id)
        db.close()

        billing = api.get(f"/api/routes/{route['id']}").json()["billing"]
        assert billing["occurrences"] == 1
        assert billing["billed"] == 450.0        # one occurrence of the block
        assert billing["margin"] == 150.0        # 450 billed - 300 paid out
        assert billing["margin_pct"] == 33.3
    finally:
        _clear()
        db = SessionLocal()
        db.query(Invoice).filter(Invoice.id.in_(made_invoices or [0])).delete(synchronize_session=False)
        db.query(Job).filter(Job.id.in_(made_jobs or [0])).delete(synchronize_session=False)
        db.commit(); db.close()


def test_a_draft_invoice_is_not_counted_as_billed(world):
    """A draft is a piece of paper, not money."""
    from database.models import Invoice

    api = _api(_Admin())
    made_jobs, made_invoices = [], []
    try:
        route = _mk_route(world, api, rate=100.0)
        db = SessionLocal()
        s = db.query(RecurringSchedule).filter(
            RecurringSchedule.id == world["schedule_ids"][0]).first()
        j = Job(client_id=s.client_id, property_id=s.property_id, org_id=1,
                job_type="residential", title="Past visit",
                scheduled_date=business_today() - timedelta(days=7),
                start_time=s.start_time, end_time=s.end_time, status="completed",
                cleaner_ids=[], recurring_schedule_id=s.id)
        db.add(j); db.commit(); db.refresh(j); made_jobs.append(j.id)
        inv = Invoice(org_id=1, client_id=s.client_id, job_id=j.id,
                      total=999.0, status="draft")
        db.add(inv); db.commit(); db.refresh(inv); made_invoices.append(inv.id)
        db.close()

        assert api.get(f"/api/routes/{route['id']}").json()["billing"]["billed"] is None
    finally:
        _clear()
        db = SessionLocal()
        db.query(Invoice).filter(Invoice.id.in_(made_invoices or [0])).delete(synchronize_session=False)
        db.query(Job).filter(Job.id.in_(made_jobs or [0])).delete(synchronize_session=False)
        db.commit(); db.close()
