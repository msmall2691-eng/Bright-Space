"""Stripe Checkout — the customer paying an invoice.

The other half of integrations/stripe_connect.py, and deliberately a separate
file: that one is the account a SUBCONTRACTOR owns and receives transfers into,
this one is TMCC charging a CUSTOMER. Same vendor, same SDK (shared via
`stripe_connect.client()`), opposite direction of money.

WHY THE MONEY LANDS ON THE PLATFORM ACCOUNT, and this is the reason Stripe is
on both sides rather than Square here and Stripe there. There is no
`transfer_data` and no `on_behalf_of` below: a paid invoice credits TMCC's own
Stripe balance, which is the exact balance `services/sub_payouts.StripeRail`
spends from when it pays the bench. Before this, that balance started at zero
and stayed there — the rail's own comment says so — so paying subs meant
manually funding Stripe first. Collections landing here closes that loop:
customer pays in, sub gets paid out, one account, one reconciliation.

HOSTED CHECKOUT, NOT ELEMENTS. Stripe hosts the card page; no card number ever
reaches this application, so there is no Stripe.js to load, no CSP to widen and
no cardholder data in scope. It is the same posture as Express onboarding — the
sensitive step happens on Stripe's page, not ours — and for the same reason:
the thing we most want to not be holding is the thing we don't collect.

`payment_method_types` IS DELIBERATELY NOT SET. Stripe then serves whatever the
account has enabled, which makes ACH a dashboard toggle rather than a code
change — and, more importantly, means this call cannot 400 on an account that
hasn't enabled ACH yet. Naming `us_bank_account` explicitly would make the
cheaper rail a hard dependency of the checkout working at all. ACH is worth
having (0.8% capped at $5 against 2.9% + 30c on a card, so a $450 deep clean
costs ~$3.60 instead of ~$13.35), but not at the price of a dead pay button.

NO IDEMPOTENCY KEY ON SESSION CREATION, which is the opposite of the payout
rail and for a specific reason. Replaying a key returns the ORIGINAL response,
so once a session has expired the key would keep handing back that dead
session — an idempotency key here would cache a broken checkout for 24 hours.
One-live-session-per-invoice is enforced in the database instead
(`Invoice.stripe_checkout_session_id` + `_expires_at`), where it can be
re-evaluated rather than replayed.

DEGRADES QUIETLY WHEN UNCONFIGURED, exactly like stripe_connect: no
STRIPE_SECRET_KEY means every call here returns an `ok: False` with a readable
reason, and the public pay page shows "call/text us" instead of a dead button.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


def configured() -> bool:
    """True when Stripe is usable. Shares one definition with the payout side
    so the two cannot disagree about whether Stripe is set up.

    This is the SECRET KEY only. Taking a customer's money needs more than
    that — see `can_take_payments`.
    """
    from integrations.stripe_connect import configured as _c
    return _c()


def can_take_payments() -> bool:
    """Both halves, because the missing half charges people and tells no one.

    A secret key alone is enough to open a Checkout session and take the
    money. It is NOT enough to learn that the money arrived: the webhook
    handler refuses an event it cannot verify (503, same fail-closed posture as
    the Twilio webhook), so with STRIPE_WEBHOOK_SECRET unset every payment
    completes at Stripe and no invoice is ever marked paid. The customer is
    charged, the invoice chases them by email, and the office finds out from a
    phone call.

    So the pay button is gated on BOTH. A warning on the settings screen was
    the first attempt at this and is not a control — it tells the operator
    about a state it still allows. "Not available" is the right answer while
    half-configured; the payout rail, which needs no webhook to send a
    transfer, keeps using `configured()` and is unaffected.
    """
    from integrations.stripe_connect import configured as _c, webhook_secret
    return bool(_c() and webhook_secret())


def dollars_to_cents(amount) -> int:
    """Money is float dollars in this schema (schema-guardian) and integer
    cents at Stripe. Round ONCE, here, at the boundary — a second rounding
    somewhere downstream is how a total drifts by a penny."""
    try:
        return int(round(float(amount) * 100))
    except (TypeError, ValueError):
        return 0


def _message(exc) -> str:
    for attr in ("user_message", "_message"):
        m = getattr(exc, attr, None)
        if m:
            return str(m)
    return str(exc) or exc.__class__.__name__


def _naive_utc(epoch) -> Optional[datetime]:
    """Stripe's epoch seconds → naive UTC, which is what `invoices` stores.

    Naive to match `Invoice.paid_at` (and `stripe_checkout_expires_at`): the
    value is only ever compared against "now", and mixing naive and aware
    datetimes raises on the path a customer is trying to pay through.
    """
    try:
        return datetime.fromtimestamp(int(epoch), timezone.utc).replace(tzinfo=None)
    except (TypeError, ValueError, OSError):
        return None


def create_checkout_session(*, amount_cents: int, invoice_number: str,
                            invoice_id: int, success_url: str, cancel_url: str,
                            customer_email: Optional[str] = None,
                            metadata: Optional[dict] = None) -> dict:
    """Open a hosted payment page for one invoice.

    Returns `{"ok", "id", "url", "expires_at", "error"}`. Never raises for an
    ordinary Stripe refusal — the caller is serving a customer-facing page and
    needs a message, not a traceback.

    `client_reference_id` carries the invoice id because the webhook resolves
    the invoice from it. It is Stripe echoing back what we sent, on a request
    whose signature we verified, which is a different trust class from a value
    a browser could put in a URL.
    """
    s = _client_or_none()
    if s is None:
        return {"ok": False, "id": None, "url": None, "expires_at": None,
                "error": "Online payment isn't switched on."}
    if int(amount_cents) <= 0:
        return {"ok": False, "id": None, "url": None, "expires_at": None,
                "error": "Nothing to pay on this invoice."}
    try:
        sess = s.checkout.Session.create(
            mode="payment",
            success_url=success_url,
            cancel_url=cancel_url,
            # The webhook's handle on the invoice. See the docstring.
            client_reference_id=str(invoice_id),
            customer_email=(customer_email or None),
            line_items=[{
                "quantity": 1,
                "price_data": {
                    "currency": "usd",
                    "unit_amount": int(amount_cents),
                    "product_data": {
                        # What the customer reads on Stripe's page. Their own
                        # invoice number, so the page they land on is visibly
                        # about the invoice they clicked.
                        "name": f"Invoice {invoice_number}",
                    },
                },
            }],
            payment_intent_data={
                "description": f"Invoice {invoice_number}",
                "metadata": {"brightbase_invoice_id": str(invoice_id),
                             "brightbase_invoice_number": str(invoice_number)},
            },
            metadata={**(metadata or {}),
                      "brightbase_invoice_id": str(invoice_id),
                      "brightbase_invoice_number": str(invoice_number)},
        )
        return {"ok": True, "id": sess.get("id"), "url": sess.get("url"),
                "expires_at": _naive_utc(sess.get("expires_at")), "error": None}
    except Exception as e:  # noqa: BLE001 — a customer-facing page needs a message
        logger.warning("[stripe] could not open checkout for invoice %s: %s",
                       invoice_id, _message(e))
        return {"ok": False, "id": None, "url": None, "expires_at": None,
                "error": _message(e)}


def retrieve_session(session_id: str) -> Optional[dict]:
    """One session's current state, as `{id, status, payment_status,
    payment_intent, url, expires_at}` — or None when Stripe isn't configured
    or the call failed, which the caller must read as "unknown", not "unpaid".

    This is the REPAIR path, for a payment whose webhook never arrived. It is
    not called to render a page (brightbase-economy) — the cached
    `stripe_checkout_expires_at` answers the reuse question without a round
    trip.
    """
    s = _client_or_none()
    if s is None or not session_id:
        return None
    try:
        sess = s.checkout.Session.retrieve(session_id)
    except Exception:
        logger.exception("[stripe] could not read checkout session %s", session_id)
        return None
    pi = sess.get("payment_intent")
    return {
        "id": sess.get("id"),
        "status": sess.get("status"),                  # open | complete | expired
        "payment_status": sess.get("payment_status"),  # paid | unpaid | no_payment_required
        # Expanded or not depending on the call, so normalize to the id.
        "payment_intent": pi if isinstance(pi, str) else (pi or {}).get("id"),
        "url": sess.get("url"),
        "expires_at": _naive_utc(sess.get("expires_at")),
    }


def _client_or_none():
    from integrations.stripe_connect import client
    return client()
