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
