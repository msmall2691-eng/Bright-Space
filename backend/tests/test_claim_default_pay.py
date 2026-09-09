"""BB-CLAIM-04: default the offer rate to a share of what a job bills.

When the office opens a job to the crew without naming a rate, and a default
pay % is set (Settings → Rules, off by default), the posted rate is filled from
the job's billed amount × that percentage. So an offer never lands on the
bench's phones with no price, and the office isn't hand-pricing every post.

It only fills a rate the office DIDN'T type, on a job with something to price
against, and never overrides a rate already there. Still a per-job dollar
figure (marketplace Rule 0: never per-hour); a counter above it still comes to
the office.
"""
import uuid
from datetime import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property, Job, JobClaimRequest, AppSetting
from modules.auth.router import get_current_user, current_org_id
from modules.settings.router import set_setting
from services.standing_rules import claim_default_pay_pct, list_rules
from utils.dates import business_today


class _Admin:
    id, org_id, role, status, active = 9970, 1, "admin", "active", True
    email = "admin-defpay@example.com"
    full_name = "The Office"
    cleaner_id = None


def _office():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _set_pct(pct):
    db = SessionLocal()
    set_setting(db, "claim_default_pay_pct", str(pct))
    db.commit(); db.close()


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": []}
    yield ids
    db = SessionLocal()
    db.query(JobClaimRequest).filter(JobClaimRequest.job_id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(AppSetting).filter(AppSetting.key == "claim_default_pay_pct").delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_job(ids, *, price=None, posted_rate=None, cleaner_ids=(), org_id=1):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"DefPay {tag}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name=f"3 Elm {tag}", address=f"3 Elm {tag}", org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential", title=f"Clean {tag}",
            scheduled_date=business_today(), start_time=time(9, 0), end_time=time(11, 0),
            cleaner_ids=list(cleaner_ids), status="scheduled", org_id=org_id,
            open_for_claims=False, posted_rate=posted_rate, price=price)
    db.add(j); db.commit(); db.refresh(j)
    ids["clients"].append(c.id); ids["properties"].append(p.id); ids["jobs"].append(j.id)
    jid = j.id; db.close()
    return jid


def _posted_rate(jid):
    db = SessionLocal()
    r = db.query(Job).filter(Job.id == jid).first().posted_rate
    db.close()
    return r


# ── the rule ─────────────────────────────────────────────────────────────────

def test_the_rule_is_listed_and_defaults_to_off():
    db = SessionLocal()
    try:
        rules = {r["key"]: r for r in list_rules(db)["rules"]}
        assert "claim_default_pay" in rules
        field = rules["claim_default_pay"]["fields"][0]
        assert field["key"] == "claim_default_pay_pct"
        assert field["default"] == 0
        assert claim_default_pay_pct(db) == 0        # unset → off
    finally:
        db.close()


# ── the derivation, through the real post path (update_job) ───────────────────

def test_opening_a_priced_job_fills_the_rate_from_the_percentage(ids):
    _set_pct(55)
    jid = _mk_job(ids, price=200.0)              # $200 job, no rate yet
    try:
        office = _office()
        r = office.patch(f"/api/jobs/{jid}", json={"open_for_claims": True})
        assert r.status_code == 200, r.text
        assert _posted_rate(jid) == 110.0          # 55% of $200
    finally:
        _clear()


def test_off_by_default_leaves_the_job_unpriced(ids):
    # No percentage set (0 = off): posting leaves posted_rate None so a sub
    # names their own price, exactly as before this feature.
    jid = _mk_job(ids, price=200.0)
    try:
        office = _office()
        assert office.patch(f"/api/jobs/{jid}", json={"open_for_claims": True}).status_code == 200
        assert _posted_rate(jid) is None
    finally:
        _clear()


def test_a_typed_rate_is_never_overridden_by_the_default(ids):
    _set_pct(55)
    jid = _mk_job(ids, price=200.0)
    try:
        office = _office()
        r = office.patch(f"/api/jobs/{jid}",
                         json={"open_for_claims": True, "posted_rate": 90.0})
        assert r.status_code == 200, r.text
        assert _posted_rate(jid) == 90.0           # what she typed, not 110
    finally:
        _clear()


def test_a_rate_already_on_the_job_is_left_alone(ids):
    _set_pct(55)
    jid = _mk_job(ids, price=200.0, posted_rate=70.0)   # already priced
    try:
        office = _office()
        assert office.patch(f"/api/jobs/{jid}", json={"open_for_claims": True}).status_code == 200
        assert _posted_rate(jid) == 70.0
    finally:
        _clear()


def test_an_unbillable_job_is_left_unpriced_even_with_a_default(ids):
    # No price, no quote, no house history → nothing to take a percentage of.
    # Better an unpriced offer the sub names than a number invented from air.
    _set_pct(55)
    jid = _mk_job(ids, price=None)
    try:
        office = _office()
        assert office.patch(f"/api/jobs/{jid}", json={"open_for_claims": True}).status_code == 200
        assert _posted_rate(jid) is None
    finally:
        _clear()
