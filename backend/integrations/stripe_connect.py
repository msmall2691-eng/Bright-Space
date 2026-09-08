"""Stripe Connect — the payout account a subcontractor owns.

WHY STRIPE AT ALL, and it is not mainly about moving money faster. The ledger's
manual rail marks a payout `sent` and never `paid` because a human writes the
cheque. The deciding reason is the W-9: BrightBase deliberately has no SSN or
TIN column, and a sole proprietor's W-9 has an SSN printed on it — so the rule
lived in the schema and died in `sub_documents`, which keeps the scan as bytes
in the application database. Stripe collects tax identity on its own page,
verifies name+TIN against IRS records, and does not hand it back:

    "Stripe doesn't share the updated sensitive PII (such as SSN or EIN) from
    accounts with your platform through the API for security reasons."
    — docs.stripe.com/connect/express-dashboard-taxes

THE ACCOUNT SHAPE, and each choice is load-bearing.

RECIPIENT-ONLY, NOT A MERCHANT. A sub never charges anybody; they receive
transfers from the platform balance. So: the transfers capability, and no
card-payments capability.

`dashboard = "express"`. This is what makes STRIPE the requirements collector
rather than BrightBase — identity data is typed into Stripe's hosted pages and
never traverses this application. It is also what makes 1099 e-delivery
possible. Setting `losses_collector = application` together with
`dashboard = "none"` would flip requirements collection back to us, which is
the opposite of the point.

FULL SERVICE AGREEMENT, NOT `recipient`. The recipient agreement is tempting —
three fields and the sub is done — and it is a trap that cannot be undone:

  * transfers to recipient accounts take an extra 24 hours to become available;
  * Instant Payouts require full terms of service, and same-day money is the
    single most persuasive thing you can offer a bench of independent cleaners;
  * "Stripe doesn't provide direct support to accounts on the recipient service
    agreement" — every "where's my money" question routes to the office;
  * "After a connected account accepts it, you can't modify the type of service
    agreement." The fix is deleting and recreating the account.

THE 1099 CAPABILITY GOES ON AT CREATION. Applying it to an account that has
already been paid $600+ disables that account's payouts *immediately*
(docs.stripe.com/connect/required-verification-information-taxes). Requested
up front, before there is any volume, it is a form the sub fills in early
rather than a freeze in November.

DEGRADES QUIETLY WHEN UNCONFIGURED, the same way push does without VAPID keys.
No STRIPE_SECRET_KEY means `configured()` is False, every call here returns
None, and the crew screen says "not set up yet" instead of raising. A payments
integration nobody has finished configuring must not be able to take the app
down.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# One place. Changing it is a deliberate act with a changelog to read first.
API_VERSION = "2025-03-31.basil"


def _key() -> Optional[str]:
    return (os.getenv("STRIPE_SECRET_KEY") or "").strip() or None


def configured() -> bool:
    """True when a secret key is present. Cheap — safe to call per request."""
    return _key() is not None


def webhook_secret() -> Optional[str]:
    return (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip() or None


# A payout or balance call must not pin a worker for the SDK's default 80
# seconds. STRIPE_TIMEOUT_SECONDS overrides; 30s is long enough for a slow-but-
# real response and short enough that a hung Stripe edge frees the worker.
_HTTP_CLIENT = None


def _timed_http_client():
    """A Stripe HTTP client with a bounded request timeout, built once.

    Guarded because the constructor lives under stripe's private `_http_client`
    module (it moved there in 15.x); if a future SDK relocates it, we fall back
    to the SDK default rather than failing every Stripe call. The pin in
    requirements plus dependabot are what keep that from going stale silently.
    """
    global _HTTP_CLIENT
    if _HTTP_CLIENT is not None:
        return _HTTP_CLIENT
    try:
        from stripe import _http_client as _hc
        from config import env_int
        _HTTP_CLIENT = _hc.new_default_http_client(
            timeout=env_int("STRIPE_TIMEOUT_SECONDS", 30)
        )
    except Exception:  # pragma: no cover - SDK internals moved
        logger.warning("[stripe] could not set a request timeout; using SDK default")
        _HTTP_CLIENT = False  # sentinel: tried and failed, don't retry every call
    return _HTTP_CLIENT or None


def _client():
    """The SDK, configured, or None. Imported lazily: `stripe` is an optional
    dependency and importing it at module scope would make every process that
    touches this file pay for it."""
    if not configured():
        return None
    try:
        import stripe
    except ImportError:  # pragma: no cover - the package is in requirements
        logger.warning("[stripe] SDK not installed; payout account features are off")
        return None
    stripe.api_key = _key()
    stripe.api_version = API_VERSION
    hc = _timed_http_client()
    if hc is not None:
        stripe.default_http_client = hc
    return stripe


def create_account(*, email: str, name: Optional[str] = None) -> Optional[str]:
    """Create the sub's connected account and return its id.

    Individual, US, transfers-only, express dashboard, full ToS, 1099
    reporting requested up front. See the module docstring for why each.
    """
    s = _client()
    if s is None:
        return None
    try:
        acct = s.Account.create(
            type="express",
            country="US",
            email=email,
            business_type="individual",
            capabilities={
                "transfers": {"requested": True},
                # Requested AT CREATION, deliberately — see the module
                # docstring. Turning it on later freezes an account that has
                # already been paid.
                "us_1099_nec": {"requested": True},
            },
            business_profile={
                # Residential cleaning. Stripe wants an MCC and will ask the
                # sub for one otherwise, which is a question about their
                # business they should not have to research.
                "mcc": "7349",
                "product_description": "Residential and short-term-rental cleaning",
            },
            metadata={"brightbase_name": (name or "")[:200]},
        )
        return acct.get("id")
    except Exception:
        logger.exception("[stripe] could not create a connected account")
        return None


def onboarding_link(account_id: str, *, return_url: str, refresh_url: str) -> Optional[str]:
    """A single-use URL that takes the sub to Stripe's own onboarding.

    Short-lived by design at Stripe's end, which is why this is generated per
    tap rather than stored. `refresh_url` is where Stripe sends them when the
    link has expired — it must mint a new one, not show an error.
    """
    s = _client()
    if s is None:
        return None
    try:
        link = s.AccountLink.create(
            account=account_id,
            type="account_onboarding",
            return_url=return_url,
            refresh_url=refresh_url,
            collection_options={"fields": "eventually_due"},
        )
        return link.get("url")
    except Exception:
        logger.exception("[stripe] could not create an onboarding link for %s", account_id)
        return None


def account_status(account_id: str) -> Optional[dict]:
    """Fetch one account's payout state. Used on the office's read-through and
    as a repair path when a webhook was missed — NOT per crew screen render."""
    s = _client()
    if s is None:
        return None
    try:
        return summarize(s.Account.retrieve(account_id))
    except Exception:
        logger.exception("[stripe] could not read account %s", account_id)
        return None


def summarize(account) -> dict:
    """The three things worth storing, from an Account object or webhook body.

    `requirements` is flattened to a short human string rather than kept as
    structure: it is displayed and logged, never queried, and keeping the raw
    hash would invite somebody to branch on Stripe's internal field names.
    """
    req = (account.get("requirements") or {}) if isinstance(account, dict) else {}
    due = list(req.get("currently_due") or []) + list(req.get("past_due") or [])
    disabled = req.get("disabled_reason")
    parts = []
    if disabled:
        parts.append(f"blocked: {disabled}")
    if due:
        parts.append(", ".join(sorted(set(due))[:8]))
    return {
        "account_id": account.get("id"),
        "payouts_enabled": bool(account.get("payouts_enabled")),
        "requirements": " · ".join(parts) or None,
    }


# ── Moving money (part two) ─────────────────────────────────────────────────
#
# A transfer takes money from the PLATFORM's Stripe balance and puts it in a
# connected account's. It is not a bank deposit — Stripe pays the sub's bank
# out of their own balance on their own schedule. From TMCC's books the money
# is gone the moment the transfer succeeds, which is what the ledger records.
#
# The platform balance is the constraint nobody expects: TMCC is paid by
# clients through Square and invoices, not Stripe, so that balance starts at
# zero and stays there until it is funded. `platform_balance` exists so the
# office is told that in numbers before pressing a button, rather than by a
# rejected transfer.


def _definite(exc) -> bool:
    """True when Stripe ANSWERED, said no, and created nothing — the only case
    where retrying is safe.

    This is the whole difference between a payout that is safe to retry and one
    that must not be. The caller strips the stamp and re-queues a `definite`
    failure; it leaves an indefinite one alone, because the transfer may exist
    and a second attempt is how somebody gets paid twice.

    A 4xx is definite: Stripe validated the request, rejected it, and created
    no transfer. A 5xx is NOT — the request reached Stripe and its server
    failed, which can happen AFTER the transfer was created but before the
    response came back, exactly like a timeout. Treating a 5xx as "nothing
    sent" (the old `http_status is not None`) and re-queuing it is a
    double-pay. A missing status (connection error / timeout) is indefinite for
    the same reason.
    """
    status = getattr(exc, "http_status", None)
    try:
        return status is not None and 400 <= int(status) < 500
    except (TypeError, ValueError):
        return False


def _message(exc) -> str:
    for attr in ("user_message", "_message"):
        m = getattr(exc, attr, None)
        if m:
            return str(m)
    return str(exc) or exc.__class__.__name__


def transfer(*, account_id: str, amount_cents: int, idempotency_key: str,
             description: Optional[str] = None,
             metadata: Optional[dict] = None) -> dict:
    """Send money to one connected account.

    Returns `{"ok", "id", "error", "definite"}`. The caller decides what to
    write down; this function never touches the ledger, for the same reason
    the manual rail doesn't — a rail that records its own success can claim
    money moved when it didn't.

    IDEMPOTENCY KEY, and its limit. Replaying the same key inside 24 hours
    returns the transfer Stripe already made, so a crash between "transfer
    succeeded" and "ledger written" is recoverable. After 24 hours the key is
    forgotten and the same key makes a SECOND transfer, which is why the rail
    refuses to retry a row whose outcome it never learned rather than leaning
    on this.
    """
    s = _client()
    if s is None:
        return {"ok": False, "id": None, "definite": True,
                "error": "Stripe isn't connected."}
    try:
        tr = s.Transfer.create(
            amount=int(amount_cents),
            currency="usd",
            destination=account_id,
            description=(description or "")[:200] or None,
            metadata=metadata or {},
            idempotency_key=idempotency_key,
        )
        return {"ok": True, "id": tr.get("id"), "definite": True, "error": None}
    except Exception as e:  # noqa: BLE001 - the branch on `definite` is the point
        definite = _definite(e)
        logger.warning("[stripe] transfer to %s failed (answered=%s): %s",
                       account_id, definite, _message(e))
        return {"ok": False, "id": None, "definite": definite, "error": _message(e)}


def platform_balance() -> Optional[dict]:
    """USD available and pending on the PLATFORM account, in cents.

    None when Stripe isn't configured or the call failed — which the caller
    must treat as "unknown", not "zero". Refusing to pay because a balance
    read timed out would be the wrong failure.
    """
    s = _client()
    if s is None:
        return None
    try:
        bal = s.Balance.retrieve()
    except Exception:
        logger.exception("[stripe] could not read the platform balance")
        return None

    def _usd(bucket) -> int:
        return sum(int(b.get("amount") or 0) for b in (bal.get(bucket) or [])
                   if (b.get("currency") or "").lower() == "usd")

    return {"available_cents": _usd("available"), "pending_cents": _usd("pending")}
