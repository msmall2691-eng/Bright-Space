"""The rail that actually moves money (Stripe Connect, part two).

Part one gave a subcontractor an account. This is the half that pays it, and
almost everything pinned here is about NOT PAYING SOMEBODY TWICE.

The dangerous case is not a failed transfer — it is a transfer whose outcome
was never learned. A timeout, a killed process, a dropped connection: the money
may well have moved, and the row still says `due`. Retrying that row blind is
how one person gets paid twice, and it is invisible until they tell you.

So the rail stamps every row it is about to attempt, in one commit, before any
money moves. A row that comes back `due`, stamped, with no transfer id is
refused on the next attempt and reported for a human to look up in Stripe.
Refusing to pay somebody until a person checks costs a minute. The other
mistake costs a phone call and a favour.

The rest: a batch is checked against the platform balance before anything is
sent rather than discovered on the fourth of eleven transfers; a sub who hasn't
finished onboarding is reported and skipped, never sent and never silently
dropped; a reversed transfer puts the row back to `due` and clears `paid_at`,
because a ledger that says "paid" about money that came home is a wrong 1099.
"""
import uuid
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Property, SubPayout, User
from modules.auth.router import get_current_user, current_org_id
from services import sub_payouts
from services.sub_payouts import PayoutRailUnavailable, StripeRail

IN_PERIOD = date(2026, 3, 10)


class _Admin:
    id, org_id, role, status, active = 9401, 1, "admin", "active", True
    email, full_name, cleaner_id = "rail-admin@example.com", "The Office", None


@pytest.fixture
def ids():
    ids = {"clients": [], "properties": [], "jobs": [], "users": []}
    yield ids
    db = SessionLocal()
    db.query(SubPayout).filter(
        SubPayout.user_id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.query(Job).filter(Job.id.in_(ids["jobs"] or [0])).delete(synchronize_session=False)
    db.query(Property).filter(
        Property.id.in_(ids["properties"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(
        Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_sub(ids, *, connected=True, payouts_enabled=True, requirements=None):
    db = SessionLocal()
    u = User(email=f"sub-{uuid.uuid4().hex[:6]}@example.com", role="cleaner",
             full_name="Dana Sub", org_id=1, active=True, status="active",
             cleaner_id=f"CT-{uuid.uuid4().hex[:6]}",
             stripe_account_id=f"acct_{uuid.uuid4().hex[:12]}" if connected else None,
             stripe_payouts_enabled=payouts_enabled,
             stripe_requirements=requirements)
    db.add(u); db.commit(); db.refresh(u)
    ids["users"].append(u.id)
    out = (u.id, u.cleaner_id, u.stripe_account_id)
    db.close()
    return out


def _mk_payout(ids, user_id, cleaner_id, *, amount=140.0, status="due",
               method=None, external_ref=None):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    c = Client(name=f"Rail {tag}", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c); ids["clients"].append(c.id)
    p = Property(client_id=c.id, name=f"9 Rail {tag}", address=f"9 Rail {tag}", org_id=1)
    db.add(p); db.commit(); db.refresh(p); ids["properties"].append(p.id)
    j = Job(client_id=c.id, property_id=p.id, job_type="residential",
            title="Weekly clean", scheduled_date=IN_PERIOD, status="completed",
            cleaner_ids=[cleaner_id], org_id=1, agreed_rate=amount,
            agreed_cleaner_id=cleaner_id)
    db.add(j); db.commit(); db.refresh(j); ids["jobs"].append(j.id)
    row = SubPayout(org_id=1, user_id=user_id, cleaner_id=cleaner_id, job_id=j.id,
                    amount=amount, status=status, method=method,
                    external_ref=external_ref, memo="Weekly clean",
                    earned_on=IN_PERIOD)
    db.add(row); db.commit(); db.refresh(row)
    pid = row.id
    db.close()
    return pid


def _api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _read(pid):
    db = SessionLocal()
    r = db.query(SubPayout).filter(SubPayout.id == pid).first()
    out = (r.status, r.method, r.external_ref, r.paid_at)
    db.close()
    return out


class _Stripe:
    """A stand-in for the Stripe module functions the rail calls.

    Records every transfer so a test can assert on the COUNT, which is how
    "one transfer per payout row" and "nothing was sent" are checked — both are
    claims about calls that did or did not happen, not about return values.
    """

    def __init__(self, *, available_cents=1_000_000, result=None, results=None):
        self.available_cents = available_cents
        self.calls = []
        self._result = result
        self._results = list(results or [])

    def configured(self):
        return True

    def platform_balance(self):
        if self.available_cents is None:
            return None
        return {"available_cents": self.available_cents, "pending_cents": 0}

    def transfer(self, **kw):
        self.calls.append(kw)
        if self._results:
            return self._results.pop(0)
        if self._result is not None:
            return self._result
        return {"ok": True, "id": f"tr_{len(self.calls)}", "definite": True,
                "error": None}


def _install(monkeypatch, fake):
    from integrations import stripe_connect as sc
    for attr in ("configured", "platform_balance", "transfer"):
        monkeypatch.setattr(sc, attr, getattr(fake, attr))
    return fake


def _send(ids_of_payouts, org_id=1):
    db = SessionLocal()
    rows = [p for p in sub_payouts.list_payouts(db, org_id, status="due")
            if p["id"] in set(ids_of_payouts)]
    try:
        return StripeRail().send(db, org_id, rows)
    finally:
        db.close()


# ── The happy path, and the shape of the record it leaves ───────────────────

def test_a_successful_transfer_marks_the_row_paid_with_its_transfer_id(ids, monkeypatch):
    uid, cid, acct = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid, amount=140.0)
    fake = _install(monkeypatch, _Stripe())

    out = _send([pid])

    assert out["count"] == 1 and out["total"] == 140.0
    assert out["blocked"] == [] and out["failed"] == [] and out["needs_check"] == []
    status, method, ref, paid_at = _read(pid)
    assert (status, method) == ("paid", "stripe")
    # The transfer id is the answer to "which payment was that" — a payout with
    # no external_ref is unreconcilable against a Stripe statement.
    assert ref == "tr_1" and paid_at is not None
    call = fake.calls[0]
    assert call["account_id"] == acct and call["amount_cents"] == 14000
    assert call["metadata"]["brightbase_payout_id"] == str(pid)


def test_one_transfer_per_payout_row_not_one_per_batch(ids, monkeypatch):
    """A single transfer covering four jobs cannot be traced to the job it paid
    for, reversed for one of them, or reconciled against the ledger."""
    uid, cid, _ = _mk_sub(ids)
    pids = [_mk_payout(ids, uid, cid, amount=50.0) for _ in range(3)]
    fake = _install(monkeypatch, _Stripe())

    out = _send(pids)

    assert len(fake.calls) == 3, "one transfer per row"
    assert out["count"] == 3 and out["total"] == 150.0
    assert len({c["idempotency_key"] for c in fake.calls}) == 3


# ── Not paying twice: the stamp, and what it refuses ────────────────────────

def test_a_row_whose_outcome_was_never_learned_is_refused_not_retried(ids, monkeypatch):
    """THE point of this file.

    A network failure leaves the row stamped and `due`. The money may have
    moved. The next attempt must not send it again — it must say so and stop.
    """
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    # First attempt: Stripe never answered, so nothing is certain.
    fake = _install(monkeypatch, _Stripe(result={
        "ok": False, "id": None, "definite": False, "error": "connection reset"}))
    first = _send([pid])
    assert first["count"] == 0
    assert first["failed"][0]["certain_nothing_sent"] is False
    status, method, ref, _paid = _read(pid)
    # Still owed, but STAMPED — that stamp is the whole recovery mechanism.
    assert (status, method, ref) == ("due", "stripe", None)

    # Second attempt: refused without touching Stripe at all.
    fake2 = _install(monkeypatch, _Stripe())
    second = _send([pid])
    assert fake2.calls == [], "a row of unknown outcome must not be re-sent"
    assert second["count"] == 0 and second["failed"] == []
    assert len(second["needs_check"]) == 1
    assert "Check Stripe" in second["needs_check"][0]["reason"]
    assert _read(pid)[0] == "due"


def test_a_refusal_stripe_actually_answered_is_cleanly_retryable(ids, monkeypatch):
    """The other side of the same coin. Stripe answered and said no, so no
    transfer exists — leaving the row stamped would strand it forever."""
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    _install(monkeypatch, _Stripe(result={
        "ok": False, "id": None, "definite": True,
        "error": "Insufficient funds in your Stripe balance"}))

    out = _send([pid])

    assert out["count"] == 0
    assert out["failed"][0]["certain_nothing_sent"] is True
    status, method, ref, _paid = _read(pid)
    assert (status, method, ref) == ("due", None, None), "the stamp is taken back off"

    # And it really does go through next time.
    fake = _install(monkeypatch, _Stripe())
    assert _send([pid])["count"] == 1
    assert len(fake.calls) == 1
    assert _read(pid)[0] == "paid"


def test_one_row_failing_does_not_stop_the_others_being_paid(ids, monkeypatch):
    uid, cid, _ = _mk_sub(ids)
    a = _mk_payout(ids, uid, cid, amount=100.0)
    b = _mk_payout(ids, uid, cid, amount=60.0)
    _install(monkeypatch, _Stripe(results=[
        {"ok": False, "id": None, "definite": True, "error": "account frozen"},
        {"ok": True, "id": "tr_ok", "definite": True, "error": None},
    ]))

    out = _send([a, b])

    assert out["count"] == 1 and len(out["failed"]) == 1
    paid = {r[0] for r in (_read(a), _read(b))}
    assert paid == {"due", "paid"}


# ── Who can be paid at all ──────────────────────────────────────────────────

def test_a_sub_who_has_not_finished_onboarding_is_reported_never_sent(ids, monkeypatch):
    uid, cid, _ = _mk_sub(ids, payouts_enabled=False,
                          requirements="individual.verification.document")
    pid = _mk_payout(ids, uid, cid)
    fake = _install(monkeypatch, _Stripe())

    out = _send([pid])

    assert fake.calls == []
    assert out["count"] == 0 and len(out["blocked"]) == 1
    # The reason is Stripe's own words, so the office can tell the person what
    # to go and do rather than "it didn't work".
    assert out["blocked"][0]["reason"] == "individual.verification.document"
    assert _read(pid) == ("due", None, None, None), "and it stays plainly owed"


def test_a_sub_with_no_stripe_account_is_reported_never_dropped(ids, monkeypatch):
    uid, cid, _ = _mk_sub(ids, connected=False, payouts_enabled=False)
    pid = _mk_payout(ids, uid, cid)
    fake = _install(monkeypatch, _Stripe())

    out = _send([pid])

    assert fake.calls == []
    assert [b["id"] for b in out["blocked"]] == [pid]
    assert "direct deposit" in out["blocked"][0]["reason"]


# ── Refusing the whole batch, before anything moves ─────────────────────────

def test_a_batch_bigger_than_the_balance_sends_nothing(ids, monkeypatch):
    """Checked once up front rather than discovered on the fourth transfer.
    This is the EXPECTED failure: clients pay through Square, so the Stripe
    balance is only ever what was deliberately put there."""
    uid, cid, _ = _mk_sub(ids)
    pids = [_mk_payout(ids, uid, cid, amount=100.0) for _ in range(3)]
    fake = _install(monkeypatch, _Stripe(available_cents=25_000))  # $250 < $300

    with pytest.raises(PayoutRailUnavailable) as e:
        _send(pids)

    assert fake.calls == []
    assert "$250.00" in str(e.value) and "$300.00" in str(e.value)
    for pid in pids:
        assert _read(pid) == ("due", None, None, None), "not even stamped"


def test_an_unreadable_balance_does_not_block_paying_anyone(ids, monkeypatch):
    """None means UNKNOWN, not zero. A balance read that timed out must not
    read as 'you have no money' and stop payroll."""
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    _install(monkeypatch, _Stripe(available_cents=None))

    assert _send([pid])["count"] == 1


def test_with_no_key_the_rail_refuses_and_moves_nothing(ids, monkeypatch):
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: False)

    with pytest.raises(PayoutRailUnavailable):
        _send([pid])
    assert _read(pid) == ("due", None, None, None)


# ── Reversal: money that came home ──────────────────────────────────────────

def test_the_idempotency_key_changes_after_a_reversal(ids, monkeypatch):
    """Replaying the original key inside 24 hours hands back the REVERSED
    transfer, and the row would be marked paid on money that came home."""
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    db = SessionLocal()
    row = db.query(SubPayout).filter(SubPayout.id == pid).first()
    fresh = StripeRail()._key(row)
    row.external_ref = "tr_reversed_one"
    after_reversal = StripeRail()._key(row)
    db.close()

    assert fresh == f"bb-payout-{pid}"
    assert after_reversal != fresh and after_reversal.startswith(f"bb-payout-{pid}-r")


def test_a_reversed_transfer_puts_the_payout_back_on_the_books(ids, monkeypatch):
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    _install(monkeypatch, _Stripe())
    assert _send([pid])["count"] == 1
    assert _read(pid)[0] == "paid"

    _webhook(monkeypatch, "transfer.reversed", {"id": "tr_1"})

    status, method, ref, paid_at = _read(pid)
    assert status == "due", "money that came home is owed again"
    # paid_at cleared: `mark` never re-stamps it, so a stale date would survive
    # a later real payment and misdate it.
    assert paid_at is None
    # The transfer id STAYS — it is the audit trail, and it is what makes the
    # re-send use a fresh idempotency key.
    assert ref == "tr_1"


def test_a_reversal_for_a_transfer_we_never_made_changes_nothing(ids, monkeypatch):
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    _install(monkeypatch, _Stripe())
    _send([pid])

    body = _webhook(monkeypatch, "transfer.reversed", {"id": "tr_someone_else"})

    assert body["ignored"] is True
    assert _read(pid)[0] == "paid"


def _webhook(monkeypatch, kind, obj):
    """Post a verified Stripe event, with the signature check stubbed.

    The signature itself is pinned in test_stripe_connect.py — including that a
    MISSING secret rejects. Repeating it here would test the same guard twice
    and hide what these cases are actually about.
    """
    import stripe
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    monkeypatch.setattr(stripe.Webhook, "construct_event",
                        staticmethod(lambda payload, sig, secret: {
                            "type": kind, "data": {"object": obj}}))
    r = _api().post("/api/payroll/stripe/webhook", content=b"{}",
                    headers={"stripe-signature": "t=1,v1=x"})
    assert r.status_code == 200, r.text
    return r.json()


# ── Choosing the rail ───────────────────────────────────────────────────────

def test_the_rail_can_actually_be_selected(ids):
    """Without a writer for this setting the Stripe rail could be built and
    never used — nothing in the app set `sub_payout_rail`."""
    api = _api()
    try:
        r = api.post("/api/payroll/subcontractors/rail", json={"name": "stripe"})
        assert r.status_code == 200, r.text
        assert r.json()["name"] == "stripe" and r.json()["settles"] is True

        view = api.get("/api/payroll/subcontractors"
                       "?start_date=2026-03-01&end_date=2026-03-31")
        assert view.json()["rail"]["name"] == "stripe"
    finally:
        api.post("/api/payroll/subcontractors/rail", json={"name": "manual"})


def test_an_unknown_rail_is_rejected_rather_than_quietly_saved(ids):
    """`get_rail` falls back to manual on an unknown name, so saving a typo
    would mean the screen says one thing and the money goes another way."""
    r = _api().post("/api/payroll/subcontractors/rail", json={"name": "venmo"})
    assert r.status_code == 422
    db = SessionLocal()
    from modules.settings.router import get_setting
    assert (get_setting(db, "sub_payout_rail") or "manual") == "manual"
    db.close()


def test_send_reports_a_rail_that_cannot_pay_instead_of_a_500(ids, monkeypatch):
    uid, cid, _ = _mk_sub(ids)
    pid = _mk_payout(ids, uid, cid)
    from integrations import stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: False)
    api = _api()
    try:
        api.post("/api/payroll/subcontractors/rail", json={"name": "stripe"})
        r = api.post("/api/payroll/subcontractors/payouts/send",
                     json={"payout_ids": [pid]})
        assert r.status_code == 422
        assert "Stripe isn't connected" in r.json()["detail"]
    finally:
        api.post("/api/payroll/subcontractors/rail", json={"name": "manual"})


# ── What the office screen is told ──────────────────────────────────────────

def test_the_ledger_says_who_can_be_paid_electronically(ids):
    ready_uid, ready_cid, _ = _mk_sub(ids)
    not_uid, not_cid, _ = _mk_sub(ids, connected=False, payouts_enabled=False)
    a = _mk_payout(ids, ready_uid, ready_cid)
    b = _mk_payout(ids, not_uid, not_cid)

    db = SessionLocal()
    rows = {p["id"]: p for p in sub_payouts.list_payouts(db, 1)}
    db.close()

    assert rows[a]["direct_deposit"] is True
    assert rows[b]["direct_deposit"] is False


def test_year_to_date_hands_over_the_threshold_it_measured_against(ids):
    """The "$600" literal outlived its own truth in four places. A number the
    screen is handed cannot drift from the number the flag used."""
    db = SessionLocal()
    from services.bench import form_1099_threshold
    for year in (2025, 2026):
        assert sub_payouts.year_to_date(db, 1, year)["threshold"] == \
            form_1099_threshold(year)
    db.close()
    # And they really are different, or this test proves nothing.
    from services.bench import form_1099_threshold as t
    assert t(2025) != t(2026)
