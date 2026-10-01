"""Online invoice payment — hosted Stripe Checkout (migration 122).

The two things worth pinning are both about NOT taking money twice and NOT
booking money that hasn't arrived:

  * one invoice has at most one live checkout session, so two tabs cannot
    become two payments;
  * an invoice flips to paid on `payment_status == "paid"` and never on the
    event name — `checkout.session.completed` fires for a bank debit while it
    is still clearing, and treating that as settled would put unsettled ACH
    money into the revenue figure.

Nothing here talks to Stripe. The module boundary (`integrations.stripe_payments`)
is stubbed, which is the point: the logic under test is BrightBase's, and a
test that needed a Stripe key could never run in CI.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Activity, Client, Invoice, Message
from integrations import stripe_payments as sp
from modules.invoicing.router import (
    InvoiceItem, InvoiceUpdate, _amount_due, public_view_invoice,
    record_checkout_payment, start_checkout, update_invoice,
)


def _naive_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture
def inv_ctx():
    db = SessionLocal()
    c = Client(name="Checkout Test", email="buyer@example.com",
               phone="+12075551111", address="9 Pay St", status="active")
    db.add(c); db.commit(); db.refresh(c)
    inv = Invoice(
        client_id=c.id, invoice_number=f"INV-{uuid.uuid4().hex[:6]}",
        items=[{"name": "Deep clean", "qty": 1, "unit_price": 450}],
        subtotal=450, tax_rate=0, tax=0, discount=0, total=450,
        status="sent", due_date="October 15, 2026",
        public_token=uuid.uuid4().hex,
    )
    db.add(inv); db.commit(); db.refresh(inv)
    yield db, c, inv
    db.rollback()
    # Activity rows too, and they are the easy ones to forget: settling an
    # invoice writes an `invoice_paid` activity, and SQLite hands a deleted
    # client's rowid to the NEXT client created. Leaving these behind made a
    # later test's brand-new client inherit this one's payment history —
    # test_invoice_timeline saw 5 `invoice_paid` events on an invoice it had
    # paid once. A fixture that deletes the client but not what the client's
    # payments wrote is a time bomb for whatever runs after it.
    db.query(Activity).filter(Activity.client_id == c.id).delete(synchronize_session=False)
    db.query(Message).filter(Message.client_id == c.id).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.id == inv.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


@pytest.fixture
def stripe_on(monkeypatch):
    """Stripe 'configured', with a session factory that records its calls."""
    calls = []

    def _create(**kw):
        calls.append(kw)
        n = len(calls)
        return {"ok": True, "id": f"cs_test_{n}", "url": f"https://checkout.test/{n}",
                "expires_at": _naive_now() + timedelta(hours=24), "error": None}

    monkeypatch.setattr(sp, "configured", lambda: True)
    monkeypatch.setattr(sp, "can_take_payments", lambda: True)
    monkeypatch.setattr(sp, "create_checkout_session", _create)
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: None)
    return calls


# ── the gate on the public page ─────────────────────────────────────────────

def test_online_payment_is_off_until_stripe_is_configured(inv_ctx, monkeypatch):
    """False because there is no STRIPE_SECRET_KEY in CI — which is exactly the
    state a half-finished deploy is in, and the page must show "call us" rather
    than a button that 503s after the customer commits."""
    db, _c, inv = inv_ctx
    monkeypatch.setattr(sp, "can_take_payments", lambda: False)
    assert public_view_invoice(inv.public_token, db=db)["online_payment_enabled"] is False


def test_online_payment_turns_on_with_stripe(inv_ctx, stripe_on):
    db, _c, inv = inv_ctx
    assert public_view_invoice(inv.public_token, db=db)["online_payment_enabled"] is True


# ── starting a checkout ─────────────────────────────────────────────────────

def test_checkout_refuses_when_stripe_is_not_configured(inv_ctx, monkeypatch):
    db, _c, inv = inv_ctx
    monkeypatch.setattr(sp, "can_take_payments", lambda: False)
    with pytest.raises(HTTPException) as e:
        start_checkout(inv.public_token, db=db)
    # 503, not 400: nothing is wrong with the request.
    assert e.value.status_code == 503


def test_checkout_404s_on_an_unknown_token(inv_ctx, stripe_on):
    db, _c, _inv = inv_ctx
    with pytest.raises(HTTPException) as e:
        start_checkout("not-a-real-token", db=db)
    assert e.value.status_code == 404


@pytest.mark.parametrize("status", ["paid", "void", "draft"])
def test_checkout_refuses_an_uncollectable_invoice(inv_ctx, stripe_on, status):
    """A paid invoice is settled, a void one isn't owed, a draft hasn't been
    sent — none of them should open a checkout for any amount."""
    db, _c, inv = inv_ctx
    inv.status = status
    db.commit()
    with pytest.raises(HTTPException) as e:
        start_checkout(inv.public_token, db=db)
    assert e.value.status_code == 409
    assert stripe_on == [], "no Stripe session should be created"


def test_checkout_creates_a_session_and_remembers_it(inv_ctx, stripe_on):
    db, _c, inv = inv_ctx
    out = start_checkout(inv.public_token, db=db)
    assert out["url"] == "https://checkout.test/1"
    assert out["reused"] is False
    # Amount is the invoice total, converted to cents exactly once.
    assert stripe_on[0]["amount_cents"] == 45000
    assert stripe_on[0]["invoice_id"] == inv.id
    db.refresh(inv)
    assert inv.stripe_checkout_session_id == "cs_test_1"
    assert inv.stripe_checkout_expires_at is not None


def test_checkout_reuses_an_open_session_rather_than_making_a_second(inv_ctx, stripe_on, monkeypatch):
    """THE DOUBLE-PAY GUARD. Two taps on the same invoice must land on the same
    Stripe session, because two live sessions are two payments."""
    db, _c, inv = inv_ctx
    first = start_checkout(inv.public_token, db=db)

    monkeypatch.setattr(sp, "retrieve_session", lambda sid: {
        "id": sid, "status": "open", "url": "https://checkout.test/1",
        "payment_status": "unpaid", "payment_intent": None,
        "expires_at": _naive_now() + timedelta(hours=23),
    })
    second = start_checkout(inv.public_token, db=db)

    assert second["reused"] is True
    assert second["url"] == first["url"]
    assert len(stripe_on) == 1, "a second session was created"


def test_an_expired_cached_session_mints_a_new_one_without_asking_stripe(inv_ctx, stripe_on, monkeypatch):
    """The cached expiry is a fast negative check (brightbase-economy): once it
    has passed there is no point asking Stripe about a session we know is
    dead."""
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    db.refresh(inv)
    inv.stripe_checkout_expires_at = _naive_now() - timedelta(minutes=1)
    db.commit()

    asked = []
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: asked.append(sid))
    out = start_checkout(inv.public_token, db=db)

    assert asked == [], "an expired session should not be looked up"
    assert out["reused"] is False
    assert len(stripe_on) == 2
    db.refresh(inv)
    assert inv.stripe_checkout_session_id == "cs_test_2"


def test_a_dead_session_is_replaced_not_reused(inv_ctx, stripe_on, monkeypatch):
    """Cached expiry still in the future, but Stripe says the session is gone.
    Stripe wins."""
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: {
        "id": sid, "status": "expired", "url": None, "payment_status": "unpaid",
        "payment_intent": None, "expires_at": None,
    })
    out = start_checkout(inv.public_token, db=db)
    assert out["reused"] is False
    assert len(stripe_on) == 2


def test_checkout_502s_when_stripe_refuses(inv_ctx, monkeypatch):
    db, _c, inv = inv_ctx
    monkeypatch.setattr(sp, "can_take_payments", lambda: True)
    monkeypatch.setattr(sp, "create_checkout_session", lambda **kw: {
        "ok": False, "id": None, "url": None, "expires_at": None,
        "error": "card_declined",
    })
    with pytest.raises(HTTPException) as e:
        start_checkout(inv.public_token, db=db)
    assert e.value.status_code == 502
    # Stripe's raw error is logged, not handed to the customer.
    assert "card_declined" not in e.value.detail
    db.refresh(inv)
    assert inv.stripe_checkout_session_id is None


# ── the webhook ─────────────────────────────────────────────────────────────

def _session(inv, *, payment_status="paid", pi="pi_test_1", amount_total=None,
             currency="usd"):
    """A checkout.session payload. `amount_total` defaults to the invoice's
    own total in cents — the normal case, where what Stripe charged and what
    the invoice wants are the same number."""
    if amount_total is None:
        amount_total = int(round(float(inv.total) * 100))
    return {"id": "cs_test_1", "client_reference_id": str(inv.id),
            "payment_status": payment_status, "payment_intent": pi,
            "amount_total": amount_total, "currency": currency}


def test_a_paid_session_settles_the_invoice(inv_ctx):
    db, c, inv = inv_ctx
    out = record_checkout_payment(db, _session(inv), event_type="checkout.session.completed")
    assert out["paid"] is True
    db.refresh(inv)
    assert inv.status == "paid"
    assert inv.paid_at is not None
    assert inv.stripe_payment_intent_id == "pi_test_1"
    # The payment is on the client's timeline, labelled as an online one.
    msgs = db.query(Message).filter(Message.client_id == c.id,
                                    Message.channel == "payment").all()
    assert len(msgs) == 1 and "Stripe" in msgs[0].body


def test_an_unsettled_bank_debit_does_not_mark_the_invoice_paid(inv_ctx):
    """THE ACH CASE, and the reason the gate is `payment_status` and not the
    event name. `checkout.session.completed` arrives for a bank debit while the
    debit is still clearing and can still fail. Booking it as collected would
    make the revenue figure disagree with the bank."""
    db, c, inv = inv_ctx
    out = record_checkout_payment(db, _session(inv, payment_status="unpaid"),
                                  event_type="checkout.session.completed")
    assert out["paid"] is False
    db.refresh(inv)
    assert inv.status == "sent"
    assert inv.paid_at is None
    # The handle is still recorded, so the later async event can be matched.
    assert inv.stripe_payment_intent_id == "pi_test_1"
    assert db.query(Message).filter(Message.client_id == c.id,
                                    Message.channel == "payment").count() == 0


def test_the_later_async_success_settles_it(inv_ctx):
    """The bank debit clears days later and arrives as its own event."""
    db, _c, inv = inv_ctx
    record_checkout_payment(db, _session(inv, payment_status="unpaid"),
                            event_type="checkout.session.completed")
    record_checkout_payment(db, _session(inv, payment_status="paid"),
                            event_type="checkout.session.async_payment_succeeded")
    db.refresh(inv)
    assert inv.status == "paid"


def test_a_retried_webhook_changes_nothing(inv_ctx):
    """Stripe retries a non-2xx for days, and will redeliver an event it has
    already sent. Recording the same payment twice must not write a second
    message or move the payment date."""
    db, c, inv = inv_ctx
    record_checkout_payment(db, _session(inv), event_type="checkout.session.completed")
    db.refresh(inv)
    first_paid_at = inv.paid_at

    again = record_checkout_payment(db, _session(inv), event_type="checkout.session.completed")
    assert again["already_paid"] is True
    db.refresh(inv)
    assert inv.paid_at == first_paid_at, "the real payment date moved"
    assert db.query(Message).filter(Message.client_id == c.id,
                                    Message.channel == "payment").count() == 1


def test_an_unknown_invoice_is_ignored_not_an_error(inv_ctx):
    """A 500 here would have Stripe retry a session that will never match —
    the same Stripe account can serve more than one thing."""
    db, _c, _inv = inv_ctx
    out = record_checkout_payment(
        db, {"id": "cs_other", "client_reference_id": "99999999",
             "payment_status": "paid", "payment_intent": "pi_x"},
        event_type="checkout.session.completed")
    assert out == {"ok": True, "ignored": True}


def test_the_session_id_resolves_the_invoice_when_the_reference_is_missing(inv_ctx, stripe_on):
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    out = record_checkout_payment(
        db, {"id": "cs_test_1", "client_reference_id": None,
             "payment_status": "paid", "payment_intent": "pi_test_9"},
        event_type="checkout.session.completed")
    assert out["paid"] is True
    db.refresh(inv)
    assert inv.status == "paid"


def test_a_reopened_invoice_gets_todays_payment_date_not_the_old_one(inv_ctx):
    """BB-INV-03 cuts both ways.

    Never MOVING a real payment date is the famous half (a cheque banked last
    month must not jump into this month's revenue). The other half: an invoice
    that was paid, reopened to `sent`, and is now genuinely being paid again
    carries a stale `paid_at`, and the payment being recorded happened TODAY.
    Preserving the old date there would backdate live revenue — so "heal, don't
    overwrite" applies to the already-paid branch only, and a real transition
    always stamps now.
    """
    db, _c, inv = inv_ctx
    stale = datetime(2026, 1, 15, 12, 0, 0)
    inv.status = "sent"
    inv.paid_at = stale        # reopened, old date still on the row
    db.commit()

    record_checkout_payment(db, _session(inv), event_type="checkout.session.completed")
    db.refresh(inv)
    assert inv.status == "paid"
    assert inv.paid_at != stale, "a re-payment was backdated to the old date"
    assert inv.paid_at > stale


# ── Codex review P1s. Each of these four was a real way to take money wrong. ──

def test_a_secret_key_without_a_webhook_secret_takes_no_payments(inv_ctx, monkeypatch):
    """P1: a secret key alone is enough to CHARGE and not enough to CONFIRM.

    The webhook handler refuses an event it cannot verify, so with no
    STRIPE_WEBHOOK_SECRET every payment completes at Stripe and no invoice is
    ever marked paid — charged customer, invoice still chasing them. The pay
    button must not appear in that state. Patched at the stripe_connect layer
    so this exercises the real `can_take_payments`, not a stub of it.
    """
    db, _c, inv = inv_ctx
    import integrations.stripe_connect as sc
    monkeypatch.setattr(sc, "configured", lambda: True)
    monkeypatch.setattr(sc, "webhook_secret", lambda: None)

    assert sp.can_take_payments() is False
    assert public_view_invoice(inv.public_token, db=db)["online_payment_enabled"] is False
    with pytest.raises(HTTPException) as e:
        start_checkout(inv.public_token, db=db)
    assert e.value.status_code == 503

    # Both halves present → on. (Payouts keep working on the key alone, which
    # is why `configured` stays a separate question.)
    monkeypatch.setattr(sc, "webhook_secret", lambda: "whsec_test")
    assert sp.can_take_payments() is True


def test_a_completed_but_unsettled_session_blocks_a_second_one(inv_ctx, stripe_on, monkeypatch):
    """P1, and the nastiest of the four. Stripe flips a session to `complete`
    the moment the customer submits — for a bank debit the money then takes
    DAYS to clear, so the session is neither open nor paid. Reusing only `open`
    sessions meant this window minted a second payable session, and both debits
    would settle."""
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: {
        "id": sid, "status": "complete", "payment_status": "unpaid",
        "url": None, "payment_intent": "pi_test_1",
        "expires_at": _naive_now() + timedelta(hours=20),
    })
    with pytest.raises(HTTPException) as e:
        start_checkout(inv.public_token, db=db)
    assert e.value.status_code == 409
    assert "still going through" in e.value.detail
    assert len(stripe_on) == 1, "a second payable session was created"


def test_a_session_paid_but_awaiting_the_webhook_blocks_a_second_one(inv_ctx, stripe_on, monkeypatch):
    """Paid at Stripe, invoice not caught up yet. Never a reason to charge
    again."""
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: {
        "id": sid, "status": "complete", "payment_status": "paid",
        "url": None, "payment_intent": "pi_test_1",
        "expires_at": _naive_now() + timedelta(hours=20),
    })
    with pytest.raises(HTTPException) as e:
        start_checkout(inv.public_token, db=db)
    assert e.value.status_code == 409
    assert len(stripe_on) == 1


def test_a_failed_session_read_refuses_rather_than_risking_a_second_charge(inv_ctx, stripe_on, monkeypatch):
    """A read that failed is UNKNOWN, not "no session".

    The first cut fell through here on the reasoning "don't refuse to take the
    money". That errs on the wrong side: a customer retrying in a minute is a
    nuisance, a customer debited twice is a refund and a phone call.
    """
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: None)
    with pytest.raises(HTTPException) as e:
        start_checkout(inv.public_token, db=db)
    assert e.value.status_code == 503
    assert len(stripe_on) == 1, "a second session was created on an unknown state"


def test_an_async_failure_releases_the_hold(inv_ctx, stripe_on, monkeypatch):
    """The other half of the ACH hold. Blocking a new session while the debit
    is in flight is right; still blocking after it BOUNCED would lock the
    customer out of paying at all."""
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    db.refresh(inv)
    assert inv.stripe_checkout_session_id is not None

    out = record_checkout_payment(
        db, _session(inv, payment_status="unpaid"),
        event_type="checkout.session.async_payment_failed")
    assert out["failed"] is True
    db.refresh(inv)
    assert inv.stripe_checkout_session_id is None
    assert inv.stripe_checkout_expires_at is None
    assert inv.status == "sent", "a failed debit must not mark the invoice paid"

    # They can now try again with a different method.
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: None)
    out2 = start_checkout(inv.public_token, db=db)
    assert out2["reused"] is False
    assert len(stripe_on) == 2


def test_an_underpayment_is_not_booked_as_full_collection(inv_ctx):
    """P1: a session charges the total it was CREATED with. If the office
    reprices the invoice afterwards, Stripe still collects the old amount while
    the row wants the new one — and checking only `payment_status` would mark a
    $600 invoice paid on a $450 charge and write "$600 received" to the
    timeline. The shortfall would be invisible forever."""
    db, c, inv = inv_ctx
    inv.total = 600.0           # repriced up after the session was created
    db.commit()

    out = record_checkout_payment(db, _session(inv, amount_total=45000),
                                  event_type="checkout.session.completed")
    assert out["paid"] is False
    assert out["underpaid"] is True
    db.refresh(inv)
    assert inv.status == "sent", "a short payment was booked as full collection"
    assert inv.paid_at is None
    # The money that DID arrive is recorded, at its real figure.
    msgs = db.query(Message).filter(Message.client_id == c.id,
                                    Message.channel == "payment").all()
    assert len(msgs) == 1
    assert "450.00" in msgs[0].body and "150.00" in msgs[0].body


def test_an_overpayment_still_settles_the_invoice(inv_ctx):
    """Repriced DOWN. They have covered it; the surplus is a refund decision
    for a person, not a reason to leave the invoice owed."""
    db, _c, inv = inv_ctx
    inv.total = 300.0
    db.commit()
    out = record_checkout_payment(db, _session(inv, amount_total=45000),
                                  event_type="checkout.session.completed")
    assert out["paid"] is True
    db.refresh(inv)
    assert inv.status == "paid"


def test_repricing_an_invoice_kills_its_payment_link(inv_ctx, stripe_on):
    """P1 root cause. A Checkout session cannot be amended, so the only way the
    old amount stops being payable is for the link to stop existing."""
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    db.refresh(inv)
    assert inv.stripe_checkout_session_id is not None

    update_invoice(inv.id, InvoiceUpdate(
        items=[InvoiceItem(name="Deep clean", qty=1, unit_price=600)],
    ), db=db, org_id=inv.org_id)

    db.refresh(inv)
    assert inv.total == 600
    assert inv.stripe_checkout_session_id is None, "the old-price link is still live"
    assert inv.stripe_checkout_expires_at is None


def test_a_reprice_that_changes_nothing_keeps_the_link(inv_ctx, stripe_on):
    """A no-op edit shouldn't invalidate a link the customer may have open."""
    db, _c, inv = inv_ctx
    start_checkout(inv.public_token, db=db)
    db.refresh(inv)
    sid = inv.stripe_checkout_session_id

    update_invoice(inv.id, InvoiceUpdate(
        items=[InvoiceItem(name="Deep clean", qty=1, unit_price=450)],
    ), db=db, org_id=inv.org_id)

    db.refresh(inv)
    assert inv.total == 450
    assert inv.stripe_checkout_session_id == sid


def test_checkout_claims_the_invoice_row_under_a_lock():
    """P1: the one-live-session invariant rests on a row lock, and the columns
    cannot enforce it — the duplicate is created at STRIPE, not in this table.

    Asserted against the source because the failure needs two genuinely
    concurrent transactions, which SQLite (one writer, FOR UPDATE ignored)
    cannot stage. It is a crude test that exists for one reason: if somebody
    drops the lock while tidying, the invariant goes silently and the symptom
    is a customer charged twice. Same posture as the route-list assertion in
    test_portal.py.
    """
    import inspect
    from modules.invoicing import router as inv_router
    src = inspect.getsource(inv_router.start_checkout)
    assert "with_for_update()" in src, \
        "start_checkout must lock the invoice row for the whole decision"


def test_a_non_usd_payment_is_refused_rather_than_converted(inv_ctx):
    """Belt-and-braces, and deliberately so.

    Every session this app creates is `usd` with no branch that varies it, so
    this is unreachable today — which is the reason to assert it rather than
    assume it. The day a second currency appears, `amount_total` quietly stops
    being comparable to a dollar total and 500 CAD would settle a $500 invoice.
    There is no rate to convert with, so refuse and leave it to a person.
    """
    db, c, inv = inv_ctx
    out = record_checkout_payment(db, _session(inv, currency="cad"),
                                  event_type="checkout.session.completed")
    assert out["paid"] is False
    assert out["currency_mismatch"] == "cad"
    db.refresh(inv)
    assert inv.status == "sent"
    assert inv.paid_at is None
    # The handle is still kept so the payment can be traced.
    assert inv.stripe_payment_intent_id == "pi_test_1"


def test_a_missing_currency_does_not_block_settlement(inv_ctx):
    """Absent is not wrong. An older event shape, or a hand-built replay,
    should not be refused for a field it never carried."""
    db, _c, inv = inv_ctx
    sess = _session(inv)
    del sess["currency"]
    out = record_checkout_payment(db, sess, event_type="checkout.session.completed")
    assert out["paid"] is True
    db.refresh(inv)
    assert inv.status == "paid"


# ── amount due ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("status,expected", [
    ("sent", 450.0), ("overdue", 450.0), ("paid", 0.0), ("void", 0.0),
])
def test_amount_due_is_zero_once_settled_or_cancelled(inv_ctx, status, expected):
    db, _c, inv = inv_ctx
    inv.status = status
    db.commit()
    assert _amount_due(inv) == expected
