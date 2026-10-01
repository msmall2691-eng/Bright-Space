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
    _amount_due, public_view_invoice, record_checkout_payment, start_checkout,
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
    monkeypatch.setattr(sp, "create_checkout_session", _create)
    monkeypatch.setattr(sp, "retrieve_session", lambda sid: None)
    return calls


# ── the gate on the public page ─────────────────────────────────────────────

def test_online_payment_is_off_until_stripe_is_configured(inv_ctx, monkeypatch):
    """False because there is no STRIPE_SECRET_KEY in CI — which is exactly the
    state a half-finished deploy is in, and the page must show "call us" rather
    than a button that 503s after the customer commits."""
    db, _c, inv = inv_ctx
    monkeypatch.setattr(sp, "configured", lambda: False)
    assert public_view_invoice(inv.public_token, db=db)["online_payment_enabled"] is False


def test_online_payment_turns_on_with_stripe(inv_ctx, stripe_on):
    db, _c, inv = inv_ctx
    assert public_view_invoice(inv.public_token, db=db)["online_payment_enabled"] is True


# ── starting a checkout ─────────────────────────────────────────────────────

def test_checkout_refuses_when_stripe_is_not_configured(inv_ctx, monkeypatch):
    db, _c, inv = inv_ctx
    monkeypatch.setattr(sp, "configured", lambda: False)
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
    monkeypatch.setattr(sp, "configured", lambda: True)
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

def _session(inv, *, payment_status="paid", pi="pi_test_1"):
    return {"id": "cs_test_1", "client_reference_id": str(inv.id),
            "payment_status": payment_status, "payment_intent": pi}


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


# ── amount due ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("status,expected", [
    ("sent", 450.0), ("overdue", 450.0), ("paid", 0.0), ("void", 0.0),
])
def test_amount_due_is_zero_once_settled_or_cancelled(inv_ctx, status, expected):
    db, _c, inv = inv_ctx
    inv.status = status
    db.commit()
    assert _amount_due(inv) == expected
