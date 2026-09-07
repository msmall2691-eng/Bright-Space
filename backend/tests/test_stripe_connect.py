"""A subcontractor's Stripe payout account — migration 108.

WHY THIS EXISTS AT ALL is the W-9 problem, not payment speed. BrightBase has
no SSN or TIN column on purpose, and a sole proprietor's W-9 has an SSN printed
on it — so the rule lived in the schema and died in `sub_documents`, which
keeps the scan as bytes in the application database. Stripe collects tax
identity on its own hosted page and does not hand it back.

What is pinned here is mostly REFUSAL and RESTRAINT:

  * the webhook is public — it has to be, Stripe cannot send our API key — so
    an unsigned request must be rejected, and a MISSING secret must reject
    rather than accept. It is the only writer of a sub's payout state, so
    accepting unsigned would let a stranger mark anyone's payouts enabled;
  * nothing here gates work. "You must open a Stripe account to be eligible"
    is a condition of engagement the arrangement does not need, and the manual
    rail stays registered;
  * with no key configured the whole feature is off and says so, rather than
    raising. A half-configured payments integration must not take the app down.
"""
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import User
from modules.auth.router import current_org_id, get_current_user


class _Sub:
    id, org_id, role, status, active = 9991, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "stripe-sub@example.com", "Dana Reed", "CT-STRIPE"


def _api(user=None):
    app.dependency_overrides[get_current_user] = lambda: (user or _row())
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _row():
    db = SessionLocal()
    u = db.query(User).filter(User.id == _Sub.id).first()
    db.close()
    return u


@pytest.fixture
def sub():
    db = SessionLocal()
    u = User(id=_Sub.id, org_id=1, email=_Sub.email, full_name=_Sub.full_name,
             role="cleaner", cleaner_id=_Sub.cleaner_id, password_hash="x",
             active=True, status="active")
    db.add(u); db.commit(); db.refresh(u); db.close()
    yield _Sub.id
    db = SessionLocal()
    db.query(User).filter(User.id == _Sub.id).delete()
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


# ── off by default, and honest about it ────────────────────────────────────

def test_with_no_key_the_feature_is_off_and_says_so(sub, monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    r = _api().get("/api/crew/me/payouts")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False and body["connected"] is False


def test_setup_refuses_politely_rather_than_exploding(sub, monkeypatch):
    """A payments integration nobody has finished configuring must not be able
    to 500 the crew app."""
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    r = _api().post("/api/crew/me/payouts/setup")
    assert r.status_code == 503, r.text
    assert "office" in r.json()["detail"].lower()


# ── the account, and that it is created once ───────────────────────────────

def test_setup_creates_the_account_once_and_reuses_it(sub, monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: True)
    created = []
    monkeypatch.setattr(sc, "create_account",
                        lambda **kw: created.append(kw) or "acct_TEST123")
    monkeypatch.setattr(sc, "onboarding_link", lambda a, **kw: f"https://connect.stripe.test/{a}")

    api = _api()
    first = api.post("/api/crew/me/payouts/setup")
    assert first.status_code == 200, first.text
    assert first.json()["url"].endswith("acct_TEST123")

    second = api.post("/api/crew/me/payouts/setup")
    assert second.status_code == 200
    # One account, two links. The link is single-use at Stripe's end, so it is
    # minted per tap; the ACCOUNT must not be.
    assert len(created) == 1, created
    db = SessionLocal()
    assert db.query(User).filter(User.id == _Sub.id).first().stripe_account_id == "acct_TEST123"
    db.close()


# ── the webhook: the only writer, and it is public ─────────────────────────

def _post_hook(body, *, sig="whatever"):
    return TestClient(app).post("/api/payroll/stripe/webhook",
                                content=json.dumps(body).encode(),
                                headers={"stripe-signature": sig,
                                         "content-type": "application/json"})


def test_an_unsigned_webhook_cannot_enable_anyone(sub, monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: "whsec_test")
    r = _post_hook({"type": "account.updated",
                    "data": {"object": {"id": "acct_X", "payouts_enabled": True}}})
    assert r.status_code == 400, r.text
    db = SessionLocal()
    assert db.query(User).filter(User.id == _Sub.id).first().stripe_payouts_enabled is False
    db.close()


def test_a_missing_secret_rejects_rather_than_trusts(sub, monkeypatch):
    """The failure mode that matters. With no secret configured we cannot
    verify anything, so the answer is 503 — not "accept it, we can't check"."""
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: None)
    r = _post_hook({"type": "account.updated", "data": {"object": {"id": "acct_X"}}})
    assert r.status_code == 503, r.text


def test_a_verified_event_updates_the_cached_state(sub, monkeypatch):
    db = SessionLocal()
    db.query(User).filter(User.id == _Sub.id).update({"stripe_account_id": "acct_OK"})
    db.commit(); db.close()

    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: "whsec_test")
    import stripe
    monkeypatch.setattr(stripe.Webhook, "construct_event",
                        staticmethod(lambda payload, sig, secret: json.loads(payload)))

    r = _post_hook({"type": "account.updated", "data": {"object": {
        "id": "acct_OK", "payouts_enabled": True, "requirements": {"currently_due": []}}}})
    assert r.status_code == 200, r.text
    db = SessionLocal()
    u = db.query(User).filter(User.id == _Sub.id).first()
    assert u.stripe_payouts_enabled is True and u.stripe_synced_at is not None
    db.close()


def test_what_stripe_is_still_waiting_for_reaches_the_sub(sub, monkeypatch):
    db = SessionLocal()
    db.query(User).filter(User.id == _Sub.id).update({"stripe_account_id": "acct_OK"})
    db.commit(); db.close()

    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: "whsec_test")
    import stripe
    monkeypatch.setattr(stripe.Webhook, "construct_event",
                        staticmethod(lambda payload, sig, secret: json.loads(payload)))
    _post_hook({"type": "account.updated", "data": {"object": {
        "id": "acct_OK", "payouts_enabled": False,
        "requirements": {"currently_due": ["individual.dob.day"],
                         "disabled_reason": "requirements.past_due"}}}})

    monkeypatch.setattr(sc, "configured", lambda: True)
    body = _api().get("/api/crew/me/payouts").json()
    assert body["payouts_enabled"] is False
    assert "individual.dob.day" in body["needs"] and "past_due" in body["needs"]


def test_an_event_for_an_account_we_do_not_know_is_ignored_quietly(sub, monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: "whsec_test")
    import stripe
    monkeypatch.setattr(stripe.Webhook, "construct_event",
                        staticmethod(lambda payload, sig, secret: json.loads(payload)))
    r = _post_hook({"type": "account.updated",
                    "data": {"object": {"id": "acct_STRANGER", "payouts_enabled": True}}})
    # 200, not an error: Stripe retries non-2xx for days, and retrying an event
    # we deliberately do not handle is noise for both sides.
    assert r.status_code == 200 and r.json()["ignored"] is True


# ── it is not a gate ───────────────────────────────────────────────────────

def test_not_having_a_stripe_account_does_not_block_work(sub):
    """The restraint that matters. "You must open a Stripe account to be
    eligible for work" is a condition of engagement this arrangement does not
    need — payment method is a commercial detail between two businesses, not a
    qualification. Nothing in migration 108 may reach blocking_requirements."""
    from services.sub_vetting import REQUIRED_KINDS, blocking_requirements
    assert "stripe" not in " ".join(REQUIRED_KINDS)
    db = SessionLocal()
    u = db.query(User).filter(User.id == _Sub.id).first()
    missing = blocking_requirements(db, u)
    db.close()
    assert not any("stripe" in str(m).lower() or "payout" in str(m).lower() for m in missing), missing


def test_the_webhook_path_is_exempt_from_the_api_key(sub):
    """Stripe cannot send our API key, so the path has to be public or every
    webhook 401s and the cached payout state silently never updates — a total,
    quiet failure of the integration.

    Asserted against `auth._is_public` DIRECTLY rather than through TestClient:
    the suite's autouse fixture injects the API key on every request, so a
    request-level test passes whether or not the path is exempt. That is
    exactly the false pass this test exists to avoid.
    """
    from auth import _is_public
    assert _is_public("/api/payroll/stripe/webhook") is True
    # And the exemption is the webhook alone — it must not open its neighbours.
    assert _is_public("/api/payroll/subcontractors") is False
    assert _is_public("/api/payroll/subcontractors/payouts/send") is False


def test_the_manual_rail_is_still_registered(sub):
    """Partial rollout is the safe rollout, and a sub mid-onboarding still has
    to get paid."""
    from services.sub_payouts import _RAILS, get_rail
    assert "manual" in _RAILS
    assert get_rail("manual").name == "manual"
