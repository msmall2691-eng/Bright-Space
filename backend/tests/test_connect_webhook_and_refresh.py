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


# -- the Settings card can tell the two secrets apart ------------------------
#
# WHY THIS NEEDS A SURFACE AT ALL. From outside, an unsigned probe of the
# webhook returns the same 400 whether one secret is set or both — so after
# adding the second one in Railway there was no way to confirm it had landed
# short of asking a subcontractor to re-onboard. The status endpoint reports
# the halves separately so "did it take?" is one admin screen, not a guess.

def _status_as_admin():
    class _Admin:
        id, org_id, role, email = 9993, 1, "admin", "admin-stripe@example.com"
        full_name, active, status = "Ops Admin", True, "active"

    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    try:
        return TestClient(app).get("/api/settings/stripe-status")
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def key_only(monkeypatch):
    """A live key and both webhook secrets absent.

    `account_health` is stubbed to None (couldn't-probe) so the status
    endpoint never makes a live Stripe call in these tests; the webhook-secret
    behaviour each test exercises is independent of the account probe, and
    None leaves the card exactly as it read before the probe existed. Tests
    that care about the charge-capability override it explicitly.
    """
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: True)
    monkeypatch.setattr(sc, "webhook_secret", lambda: None)
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: None)
    monkeypatch.setattr(sc, "account_health", lambda: None)


def test_the_status_names_the_connect_secret_separately(key_only, monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: ACCOUNT_SECRET)

    body = _status_as_admin().json()
    assert body["configured"] is True
    assert body["webhook_configured"] is True
    # The whole point: the account secret being present says nothing about
    # the Connect one, and the payload must not conflate them.
    assert body["connect_webhook_configured"] is False
    assert "STRIPE_CONNECT_WEBHOOK_SECRET" in body["detail"]


def test_both_secrets_present_reads_as_fully_connected(key_only, monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: ACCOUNT_SECRET)
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: CONNECT_SECRET)

    body = _status_as_admin().json()
    assert body["connect_webhook_configured"] is True
    # No instruction left in the sentence once there is nothing left to add.
    assert "STRIPE_CONNECT_WEBHOOK_SECRET" not in body["detail"]
    assert "on their own" in body["detail"]


def test_a_missing_connect_secret_does_not_claim_payments_are_broken(key_only, monkeypatch):
    """It is not the money-losing state, and must not read like one.

    Without the ACCOUNT secret a payment completes and the invoice is never
    marked paid. Without the CONNECT secret nothing is lost but automatic
    notice of a sub finishing setup, so the detail must still say online
    payment is ON.
    """
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: ACCOUNT_SECRET)

    detail = _status_as_admin().json()["detail"]
    assert "Online invoice payment is on" in detail
    assert "could never" not in detail          # the account-secret warning


def test_a_missing_account_secret_still_wins_the_sentence(key_only, monkeypatch):
    """Precedence: the state that takes money and loses it is the one named."""
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: CONNECT_SECRET)

    body = _status_as_admin().json()
    assert body["connect_webhook_configured"] is True
    assert body["webhook_configured"] is False
    assert "STRIPE_WEBHOOK_SECRET is missing" in body["detail"]


# ── Charge-capability: the state behind a pay button that errors ─────────────
#
# Both keys set and the card still said "Connected" — because the status only
# ever checked that the SECRET KEY was present, never that Stripe would
# actually open a Checkout session. An account that hasn't finished activation
# refuses the live charge; `create_checkout_session` returns ok:False, the
# public page 502s, and the reason lived only in a log line. These pin that the
# status now reads the live capability and names the blocker.

def _both_keys(monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "webhook_secret", lambda: ACCOUNT_SECRET)
    monkeypatch.setattr(sc, "connect_webhook_secret", lambda: CONNECT_SECRET)


def test_keys_set_but_stripe_wont_charge_reads_as_needs_activation(key_only, monkeypatch):
    from integrations import stripe_connect as sc
    _both_keys(monkeypatch)
    monkeypatch.setattr(sc, "account_health", lambda: {
        "charges_enabled": False, "payouts_enabled": False,
        "details_submitted": False,
        "detail": "Stripe account isn't activated for live charges yet — "
                  "finish activation at dashboard.stripe.com and the pay "
                  "button can charge cards.",
    })

    body = _status_as_admin().json()
    # Not a mystery any more: the payload says charges are off and the sentence
    # names activation, taking precedence over the connect-webhook note.
    assert body["charges_enabled"] is False
    assert "activat" in body["detail"].lower()
    assert "STRIPE_CONNECT_WEBHOOK_SECRET" not in body["detail"]


def test_keys_set_and_charges_live_reads_as_connected(key_only, monkeypatch):
    from integrations import stripe_connect as sc
    _both_keys(monkeypatch)
    monkeypatch.setattr(sc, "account_health", lambda: {
        "charges_enabled": True, "payouts_enabled": True,
        "details_submitted": True, "detail": None,
    })

    body = _status_as_admin().json()
    assert body["charges_enabled"] is True
    assert "Online invoice payment is on" in body["detail"]


def test_a_failed_account_probe_does_not_cry_wolf(key_only, monkeypatch):
    """None from the probe means "couldn't check", never "broken". The card
    must stay as it read before the probe existed, not flip to needs-attention
    because Stripe was briefly unreachable."""
    from integrations import stripe_connect as sc
    _both_keys(monkeypatch)
    monkeypatch.setattr(sc, "account_health", lambda: None)

    body = _status_as_admin().json()
    assert body["charges_enabled"] is None
    assert "Online invoice payment is on" in body["detail"]


# ── account_health() itself ──────────────────────────────────────────────────

class _FakeAccount(dict):
    pass


def _stub_client(monkeypatch, account):
    """Point stripe_connect._client at a fake whose Account.retrieve returns
    `account`, so account_health never touches the network."""
    from integrations import stripe_connect as sc

    class _Acct:
        @staticmethod
        def retrieve():
            if isinstance(account, Exception):
                raise account
            return account

    class _FakeStripe:
        Account = _Acct

    monkeypatch.setattr(sc, "_client", lambda: _FakeStripe())


def test_account_health_is_none_when_not_configured(monkeypatch):
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "_client", lambda: None)
    assert sc.account_health() is None


def test_account_health_reports_activation_when_not_submitted(monkeypatch):
    from integrations import stripe_connect as sc
    _stub_client(monkeypatch, _FakeAccount(
        charges_enabled=False, payouts_enabled=False,
        details_submitted=False, requirements={},
    ))
    h = sc.account_health()
    assert h["charges_enabled"] is False
    assert "activat" in h["detail"].lower()


def test_account_health_names_what_stripe_is_waiting_for(monkeypatch):
    from integrations import stripe_connect as sc
    _stub_client(monkeypatch, _FakeAccount(
        charges_enabled=False, payouts_enabled=False, details_submitted=True,
        requirements={"currently_due": ["business_profile.url"], "past_due": []},
    ))
    h = sc.account_health()
    assert h["charges_enabled"] is False
    assert "business_profile.url" in h["detail"]


def test_account_health_is_quiet_when_charges_are_live(monkeypatch):
    from integrations import stripe_connect as sc
    _stub_client(monkeypatch, _FakeAccount(
        charges_enabled=True, payouts_enabled=True, details_submitted=True,
        requirements={},
    ))
    h = sc.account_health()
    assert h["charges_enabled"] is True
    assert h["detail"] is None


def test_account_health_swallows_a_failed_read(monkeypatch):
    from integrations import stripe_connect as sc
    _stub_client(monkeypatch, RuntimeError("stripe down"))
    assert sc.account_health() is None
