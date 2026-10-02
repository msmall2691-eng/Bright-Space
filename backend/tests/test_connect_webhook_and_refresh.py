"""Connected-account events, and the button that exists for when they go missing.

THE PROBLEM. `account.updated` for a subcontractor's Express account is a
CONNECT event: Stripe delivers it only to an endpoint configured to listen to
connected accounts, and every endpoint carries its own signing secret — so one
secret cannot verify both, however the URLs are arranged.

That is not a cosmetic gap. `account.updated` is the ONLY writer of
`User.stripe_payouts_enabled`, and `sub_payouts.StripeRail` refuses to send to
anyone whose flag is False. Miss the event and the flag sits at its default
forever: the direct-deposit rail never turns on for anybody, silently, while
the manual CSV rail carries on working so nobody notices until the first Stripe
payout run.

So: the handler holds two secrets and accepts whichever verifies, and the crew
screen gets a deliberate "check again" that asks Stripe directly.

These sign payloads with a REAL HMAC rather than stubbing `construct_event`.
Stubbing the verifier would make every test pass whatever the dispatch logic
did with the two secrets, which is the one thing worth pinning here.
"""
import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import User
from modules.auth.router import current_org_id, get_current_user

ACCOUNT_SECRET = "whsec_account_side"
CONNECT_SECRET = "whsec_connect_side"


class _Sub:
    id, org_id, role, status, active = 9992, 1, "cleaner", "active", True
    email, full_name, cleaner_id = "connect-sub@example.com", "Rae Lin", "CT-CONNECT"


@pytest.fixture
def sub():
    db = SessionLocal()
    db.query(User).filter(User.id == _Sub.id).delete()
    u = User(id=_Sub.id, org_id=1, email=_Sub.email, full_name=_Sub.full_name,
             role="cleaner", cleaner_id=_Sub.cleaner_id, password_hash="x",
             active=True, status="active", stripe_account_id="acct_CONNECT",
             stripe_payouts_enabled=False)
    db.add(u); db.commit(); db.close()
    yield _Sub.id
    db = SessionLocal()
    db.query(User).filter(User.id == _Sub.id).delete()
    db.commit(); db.close()


@pytest.fixture
def both_secrets(monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: ACCOUNT_SECRET)
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: CONNECT_SECRET)


def _signed(body: dict, secret: str):
    """A genuinely signed delivery, in Stripe's `t=…,v1=…` scheme."""
    payload = json.dumps(body).encode()
    ts = int(time.time())
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + payload,
                   hashlib.sha256).hexdigest()
    return payload, f"t={ts},v1={mac}"


def _post(body, secret):
    payload, sig = _signed(body, secret)
    return TestClient(app).post(
        "/api/payroll/stripe/webhook", content=payload,
        headers={"stripe-signature": sig, "content-type": "application/json"})


def _event(enabled=True):
    return {"type": "account.updated", "data": {"object": {
        "id": "acct_CONNECT", "payouts_enabled": enabled,
        "requirements": {"currently_due": []}}}}


def _flag():
    db = SessionLocal()
    try:
        return db.query(User).filter(User.id == _Sub.id).first().stripe_payouts_enabled
    finally:
        db.close()


# -- the webhook holds two secrets -------------------------------------------

def test_an_event_signed_with_the_account_secret_is_accepted(sub, both_secrets):
    assert _post(_event(), ACCOUNT_SECRET).status_code == 200
    assert _flag() is True


def test_an_event_signed_with_the_connect_secret_is_accepted(sub, both_secrets):
    """The whole point: a connected-account event is signed by the OTHER
    endpoint's secret, and must still land."""
    assert _post(_event(), CONNECT_SECRET).status_code == 200
    assert _flag() is True


def test_a_foreign_secret_is_still_refused(sub, both_secrets):
    """Trying both secrets is not trying any secret. A payload signed with a
    key we do not hold has to fail, or the dual lookup would be a hole rather
    than a convenience."""
    assert _post(_event(), "whsec_not_ours").status_code == 400
    assert _flag() is False


def test_with_only_the_account_secret_a_connect_event_is_refused(sub, monkeypatch):
    """The state before STRIPE_CONNECT_WEBHOOK_SECRET is configured — and the
    exact reason a sub's payouts never switch on. Refused, not silently
    accepted."""
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: ACCOUNT_SECRET)
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: None)
    assert _post(_event(), CONNECT_SECRET).status_code == 400
    assert _flag() is False


def test_no_secrets_at_all_still_rejects_rather_than_trusts(sub, monkeypatch):
    """Fail-closed survives the second secret: unverifiable is 503, never
    "accept it, we cannot check"."""
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: None)
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: None)
    assert _post(_event(), ACCOUNT_SECRET).status_code == 503
    assert _flag() is False


def test_the_connect_secret_alone_is_enough(sub, monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: None)
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: CONNECT_SECRET)
    assert _post(_event(), CONNECT_SECRET).status_code == 200
    assert _flag() is True


# -- the refresh button ------------------------------------------------------

def _api():
    db = SessionLocal()
    u = db.query(User).filter(User.id == _Sub.id).first()
    db.close()
    app.dependency_overrides[get_current_user] = lambda: u
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


def test_refresh_pulls_the_current_state_from_stripe(sub, monkeypatch):
    """The repair path for a delivery that never arrived."""
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: True)
    monkeypatch.setattr(sc, "account_status", lambda acct: {
        "account_id": acct, "payouts_enabled": True, "requirements": None})

    r = _api().post("/api/crew/me/payouts/refresh", json={})
    assert r.status_code == 200, r.text
    assert r.json()["payouts_enabled"] is True
    assert r.json()["refreshed"] is True
    assert _flag() is True, "the cached column must actually be written"


def test_refresh_reports_what_stripe_is_still_waiting_for(sub, monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: True)
    monkeypatch.setattr(sc, "account_status", lambda acct: {
        "account_id": acct, "payouts_enabled": False,
        "requirements": "individual.id_number"})

    r = _api().post("/api/crew/me/payouts/refresh", json={})
    assert r.status_code == 200, r.text
    assert r.json()["payouts_enabled"] is False
    assert "id_number" in (r.json()["needs"] or "")


def test_a_failed_read_says_so_rather_than_reporting_stale_as_fresh(sub, monkeypatch):
    """`account_status` returns None when the call failed, which is UNKNOWN,
    not "nothing changed". A sub who taps and sees no change deserves to know
    which of those it was."""
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: True)
    monkeypatch.setattr(sc, "account_status", lambda acct: None)

    r = _api().post("/api/crew/me/payouts/refresh", json={})
    assert r.status_code == 502, r.text
    assert _flag() is False


def test_refresh_makes_no_stripe_call_when_there_is_nothing_to_refresh(sub, monkeypatch):
    """No account yet, or Stripe off: answer from what we have rather than
    spending a call (brightbase-economy)."""
    from integrations import stripe_connect as sc
    called = []
    monkeypatch.setattr(sc, "configured", lambda: False)
    monkeypatch.setattr(sc, "account_status", lambda acct: called.append(acct))

    r = _api().post("/api/crew/me/payouts/refresh", json={})
    assert r.status_code == 200, r.text
    assert r.json()["refreshed"] is False
    assert called == [], "asked Stripe when there was nothing to ask about"


def test_refresh_is_metered(sub):
    """A button that costs an API call is a button somebody leans on."""
    import inspect
    from modules.crew import router as crew_router
    src = inspect.getsource(crew_router.refresh_my_payout_account)
    assert "rate_limit" in src or "crew_payout_refresh" in src, \
        "the refresh endpoint must stay rate-limited"
