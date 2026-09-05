"""The Wednesday round-up (Phase 6).

Everything the pivot added reports somewhere — payouts, vetting, windows,
routes. Five screens, each of which has to be remembered and opened. Nobody
opens five screens on a Wednesday, so the parts that need a decision get found
on Friday, which is when they're expensive.

The properties worth pinning:

  * it is SILENT in a week with nothing to decide. A message that always
    arrives is a message nobody opens, and then the week it matters it's in a
    folder with the others;
  * it doesn't send twice — the tick runs every few minutes and a redeploy
    mid-morning must not repeat it;
  * an EXPIRED document is called out separately from one that's merely due,
    because expired means somebody can't work right now;
  * a turnover nobody has taken AND that was never posted is named as such —
    that's the half the office can still fix;
  * it's org-scoped, like everything else.
"""
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Job, Property, Route, SubAgreement, SubDocument, SubPayout, User,
)
from modules.auth.router import get_current_user, current_org_id
from modules.settings.router import set_setting
from services import bench_digest
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 9701, 1, "admin", "active", True
    email = "digest-admin@example.com"
    full_name = "The Office"
    cleaner_id = None


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def made():
    m = {"clients": [], "properties": [], "jobs": [], "users": [], "routes": [],
         "payouts": []}
    yield m
    db = SessionLocal()
    db.query(SubPayout).filter(SubPayout.id.in_(m["payouts"] or [0])).delete(synchronize_session=False)
    db.query(Route).filter(Route.id.in_(m["routes"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(m["jobs"] or [0])).delete(synchronize_session=False)
    db.query(SubDocument).filter(SubDocument.user_id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(SubAgreement).filter(SubAgreement.user_id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(m["users"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(m["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(m["clients"] or [0])).delete(synchronize_session=False)
    set_setting(db, "bench_digest_enabled", "false")
    set_setting(db, "bench_digest_last_sent", "")
    db.commit(); db.close()


def _mk_turnover(m, when, *, posted=True, taken=False, org_id=1):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"D {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c); m["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"Cabin {tag}", address=f"{tag} Lake Rd",
                 property_type="str", org_id=org_id)
    db.add(p); db.commit(); db.refresh(p); m["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="str_turnover",
            title=f"Turnover {tag}", scheduled_date=when, start_time=time(11, 0),
            end_time=time(14, 0), status="scheduled", org_id=org_id,
            cleaner_ids=(["CT-HAS"] if taken else []),
            open_for_claims=posted and not taken,
            posted_rate=(85.0 if posted else None),
            agreed_rate=(85.0 if taken else None))
    db.add(j); db.commit(); db.refresh(j); m["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _mk_sub_with_coi(m, days_from_now):
    tag = uuid.uuid4().hex[:6]
    db = SessionLocal()
    u = User(email=f"d-{tag}@example.com", role="cleaner", full_name=f"Sub {tag}",
             org_id=1, active=True, status="active", cleaner_id=f"CT-{tag[:5]}")
    db.add(u); db.commit(); db.refresh(u); m["users"].append(u.id)
    db.add(SubDocument(org_id=1, user_id=u.id, kind="coi", status="accepted",
                       data=b"x", expires_at=business_today() + timedelta(days=days_from_now)))
    db.commit()
    uid = u.id; db.close()
    return uid


def _lines(org_id=1):
    db = SessionLocal()
    out = bench_digest.build(db, org_id)
    db.close()
    return out


# ── Silence ─────────────────────────────────────────────────────────────────

def test_a_week_with_nothing_to_decide_produces_nothing(made):
    """A message that always arrives is a message nobody opens."""
    d = _lines()
    assert d["empty"] is True
    assert d["lines"] == []


def test_a_silent_week_still_marks_the_day_so_the_tick_stops_rebuilding_it(made):
    db = SessionLocal()
    set_setting(db, "bench_digest_enabled", "true")
    db.commit()
    out = bench_digest.send(db, org_id=1)
    db.close()
    assert out["sent"] is False and out["reason"] == "nothing to report"
    db = SessionLocal()
    assert bench_digest.due_today(db) is False, "the day is marked even when silent"
    db.close()


# ── What it reports ─────────────────────────────────────────────────────────

def test_uncovered_turnovers_name_the_ones_that_were_never_even_posted(made):
    """That's the half the office can still fix by pressing a button."""
    soon = business_today() + timedelta(days=4)
    _mk_turnover(made, soon, posted=True)
    _mk_turnover(made, soon, posted=False)     # nobody could claim this one
    _mk_turnover(made, soon, taken=True)       # covered, shouldn't appear

    d = _lines()
    assert len(d["sections"]["uncovered_turnovers"]) == 2
    line = next(l for l in d["lines"] if "turnover" in l)
    assert "2 turnovers" in line
    assert "1 not even posted to the bench" in line


def test_a_turnover_beyond_the_horizon_is_not_this_weeks_problem(made):
    _mk_turnover(made, business_today() + timedelta(days=40), posted=True)
    assert _lines()["empty"] is True


def test_an_expired_document_is_reported_separately_from_one_merely_due(made):
    """Expired means somebody can't work right now. That's a different problem
    from one that will need renewing."""
    _mk_sub_with_coi(made, -3)      # lapsed
    _mk_sub_with_coi(made, 12)      # due soon
    _mk_sub_with_coi(made, 300)     # fine, shouldn't appear

    d = _lines()
    assert len(d["sections"]["expiring_documents"]) == 2
    joined = " | ".join(d["lines"])
    assert "1 document already expired" in joined
    assert "can't take work until it's replaced" in joined
    assert "1 document expiring within 30 days" in joined


def test_unanswered_route_offers_and_money_owed_both_appear(made):
    db = SessionLocal()
    r = Route(org_id=1, name="Tuesday North", day_of_week=1, rate=400.0,
              status="offered", owner_cleaner_id="CT-OFFER")
    db.add(r); db.commit(); db.refresh(r); made["routes"].append(r.id)
    u = User(email=f"pay-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="Owed Sub", org_id=1, active=True, status="active",
             cleaner_id="CT-OWED")
    db.add(u); db.commit(); db.refresh(u); made["users"].append(u.id)
    p = SubPayout(org_id=1, user_id=u.id, cleaner_id="CT-OWED", amount=250.0,
                  status="due", earned_on=business_today())
    db.add(p); db.commit(); db.refresh(p); made["payouts"].append(p.id)
    db.close()

    d = _lines()
    joined = " | ".join(d["lines"])
    assert "1 route offered and not answered yet" in joined
    assert "$250.00 owed to subcontractors and not sent" in joined
    assert d["sections"]["payouts_due"] == {"count": 1, "total": 250.0}


def test_a_sub_past_600_this_year_is_flagged_once(made):
    db = SessionLocal()
    u = User(email=f"big-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="Busy Sub", org_id=1, active=True, status="active",
             cleaner_id="CT-BIG")
    db.add(u); db.commit(); db.refresh(u); made["users"].append(u.id)
    for amount in (400.0, 350.0):
        p = SubPayout(org_id=1, user_id=u.id, cleaner_id="CT-BIG", amount=amount,
                      status="paid", earned_on=business_today())
        db.add(p); db.commit(); db.refresh(p); made["payouts"].append(p.id)
    db.close()

    d = _lines()
    assert len(d["sections"]["over_1099"]) == 1
    assert "1 subcontractor past $600 this year" in " | ".join(d["lines"])


# ── Scheduling ──────────────────────────────────────────────────────────────

def test_it_only_fires_on_its_day_and_only_once(made):
    db = SessionLocal()
    set_setting(db, "bench_digest_enabled", "true")
    # Whatever today is, make it the configured day.
    set_setting(db, "bench_digest_weekday", str(business_today().weekday()))
    set_setting(db, "bench_digest_last_sent", "")
    db.commit()
    assert bench_digest.due_today(db) is True

    bench_digest.send(db, org_id=1)
    assert bench_digest.due_today(db) is False, "a redeploy must not send it twice"

    # A different day of the week: not today's problem.
    set_setting(db, "bench_digest_weekday",
                str((business_today().weekday() + 1) % 7))
    set_setting(db, "bench_digest_last_sent", "")
    db.commit()
    assert bench_digest.due_today(db) is False
    db.close()


def test_it_does_not_fire_while_switched_off(made):
    db = SessionLocal()
    set_setting(db, "bench_digest_enabled", "false")
    set_setting(db, "bench_digest_weekday", str(business_today().weekday()))
    set_setting(db, "bench_digest_last_sent", "")
    db.commit()
    assert bench_digest.due_today(db) is False
    db.close()


# ── On demand ───────────────────────────────────────────────────────────────

def test_the_endpoint_returns_the_same_thing_the_digest_would_send(made):
    """One function builds both — a digest that disagreed with the screen it
    links to would be worse than no digest."""
    _mk_turnover(made, business_today() + timedelta(days=3), posted=False)
    api = _api()
    try:
        r = api.get("/api/dashboard/bench")
        assert r.status_code == 200, r.text
        assert r.json() == _lines()
    finally:
        _clear()


def test_another_orgs_bench_is_not_in_this_digest(made):
    """Org 2's uncovered turnover isn't org 1's Wednesday problem."""
    _mk_turnover(made, business_today() + timedelta(days=3), posted=False, org_id=2)
    assert _lines(org_id=1)["empty"] is True
    assert _lines(org_id=2)["empty"] is False, "and it IS org 2's problem"
