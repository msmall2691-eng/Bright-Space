"""Inbox triage — classify the automated/bulk email stream for the Ops Board.

BrightBase threads *human* email into Conversations (the board's "Real People
Waiting" section). The rest — SaaS/billing notices, receipts, security alerts,
newsletters, promotions — used to be dropped by integrations/email_filter and
discarded. This module classifies that stream into two board buckets:

  - "systems"        → Systems & Subscriptions: SaaS / billing / security notices
                       worth a glance (you pay for these, or they touch money or
                       account access).
  - "safe_to_ignore" → Safe to Ignore: promotions, newsletters, social —
                       dismissible noise.

Classification is **rules-first** (Gmail CATEGORY_* labels when present, the
List-Unsubscribe / bulk headers already parsed by the sync, and sender-domain /
local-part / subject heuristics), reusing the signals in
integrations.email_filter. `capture_triage_item` upserts a classified row
(deduped on the email Message-ID per org); the board reads them back.

`ai_classify_email` is an optional refinement that asks Claude to pick the
category/vendor when ANTHROPIC_API_KEY is configured, and degrades to the exact
rules result otherwise — the same graceful-fallback pattern as modules.ai's
enrich_entity. The hot sync path stays rules-only (no LLM per message); the AI
pass is opt-in for callers that want it.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from database.models import InboxTriageItem
from integrations.email_filter import _split_addr, is_bulk_mail, looks_like_cold_outreach

# ── Section routing ──────────────────────────────────────────────────────────
# Which board section each category lands in.
_SYSTEMS_CATEGORIES = {"saas", "finance", "security"}
_CATEGORY_SECTION = {
    "saas": "systems", "finance": "systems", "security": "systems",
    "promotions": "safe_to_ignore", "social": "safe_to_ignore",
    "updates": "safe_to_ignore", "other": "safe_to_ignore",
}


def _section_for(category: str) -> str:
    return _CATEGORY_SECTION.get(category, "safe_to_ignore")


# ── Signal vocabularies ──────────────────────────────────────────────────────
# Money / billing senders — a bill, receipt or payout the operator actually cares
# about. Matched as domain suffix.
FINANCE_DOMAINS = {
    "stripe.com", "intuit.com", "quickbooks.com", "squareup.com", "square.com",
    "paypal.com", "wise.com", "waveapps.com", "gusto.com", "bill.com", "ramp.com",
    "brex.com", "mercury.com", "melio.com", "chase.com", "americanexpress.com",
    "bankofamerica.com", "wellsfargo.com", "capitalone.com",
}
FINANCE_LOCALS = {
    "billing", "invoice", "invoices", "invoicing", "receipt", "receipts",
    "payment", "payments", "payouts", "payout", "statement", "statements",
    "accounting", "ar", "accountsreceivable",
}
FINANCE_SUBJECT = (
    "invoice", "receipt", "payment received", "your bill", "past due",
    "autopay", "renews", "renewal", "subscription", "you paid", "we charged",
    "payout", "deposit", "statement is ready",
)

# Account-security / access notices — always worth a glance.
SECURITY_KEYWORDS = (
    "security alert", "new sign-in", "new sign in", "new login", "sign-in attempt",
    "unusual activity", "suspicious", "password was", "reset your password",
    "verify your", "verification code", "two-factor", "2fa", "unauthorized",
    "was accessed", "we noticed", "confirm your email", "confirm your identity",
)

# Operational tools & subscriptions the business runs on. Matched as domain
# suffix. Notices from these belong in "Systems & Subscriptions", not the junk
# pile — they include the STR booking channels (Airbnb/VRBO/Turno) that a
# cleaning company schedules turnovers around.
OPS_SAAS_DOMAINS = {
    "twilio.com", "connecteam.com", "squareup.com", "turno.com", "turnoverbnb.com",
    "airbnb.com", "vrbo.com", "homeaway.com", "hostaway.com", "guesty.com",
    "google.com", "googlemail.com", "workspace.google.com", "godaddy.com",
    "mailchimp.com", "hubspot.com", "zoom.us", "slack.com", "notion.so",
    "linear.app", "figma.com", "atlassian.net", "github.com", "gitlab.com",
    "vercel.com", "railway.app", "supabase.io", "supabase.com", "dropbox.com",
    "docusign.net", "calendly.com", "zapier.com", "asana.com", "trello.com",
    "quickbooks.com", "intuit.com",
}

# Social networks — safe to ignore.
SOCIAL_DOMAINS = {
    "facebookmail.com", "facebook.com", "linkedin.com", "pinterest.com",
    "instagram.com", "twitter.com", "x.com", "nextdoor.com", "youtube.com",
    "tiktok.com", "reddit.com", "meetup.com",
}

# ESP / relay subdomains stripped when deriving a clean vendor label.
_VENDOR_STRIP_PREFIXES = ("mail", "email", "e", "em", "news", "newsletter",
                          "mailer", "reply", "notifications", "notify", "info",
                          "hello", "no-reply", "noreply", "updates", "t", "m")


def _domain_matches(domain: str, needles: set) -> bool:
    if not domain:
        return False
    return any(domain == d or domain.endswith("." + d) for d in needles)


def _vendor_label(from_name: str, domain: str) -> str:
    """A short brand label. Prefer the registrable domain part (stable), fall
    back to the display name. 'mail.notion.so' → 'Notion', 'stripe.com' → 'Stripe'."""
    if domain:
        parts = [p for p in domain.split(".") if p]
        # Drop a leading ESP/relay subdomain (mail., email., news., ...).
        while len(parts) > 2 and parts[0] in _VENDOR_STRIP_PREFIXES:
            parts = parts[1:]
        if len(parts) >= 2:
            label = parts[-2]           # second-level domain ("notion", "stripe")
        elif parts:
            label = parts[0]
        else:
            label = ""
        label = label.replace("-", " ").strip()
        if label:
            return label[:1].upper() + label[1:]
    name = (from_name or "").strip()
    return name[:60] if name else (domain or "Unknown")


_URL_RE = re.compile(r"https?://[^\s<>,;]+", re.IGNORECASE)


def _unsubscribe_url(list_unsubscribe: str) -> Optional[str]:
    """Extract the http(s) target from a List-Unsubscribe header
    ('<https://...>, <mailto:...>'), ignoring the mailto: form."""
    if not list_unsubscribe:
        return None
    m = _URL_RE.search(list_unsubscribe)
    return m.group(0).rstrip(">") if m else None


# Explicit marketing/sale language — beats the ops-tool rule so a promo blast
# from a vendor you also use (Mailchimp "50% off") reads as safe-to-ignore.
PROMO_SUBJECT = (
    "% off", " sale", "flash sale", "discount", "coupon", "save big",
    "limited time", "deal of", "buy now", "shop now", "new arrivals",
    "newsletter", "digest", "weekly roundup", "this week", "don't miss",
    "best deals", "on sale",
)


def _is_promotional(em: dict, labels: set, subject: str) -> bool:
    if "CATEGORY_PROMOTIONS" in labels:
        return True
    subj = (subject or "").lower()
    if any(k in subj for k in PROMO_SUBJECT):
        return True
    return looks_like_cold_outreach(subject, em.get("snippet") or em.get("body"))


def _has_security_signal(subject: str, local: str) -> bool:
    hay = f"{subject or ''} {local or ''}".lower()
    return any(k in hay for k in SECURITY_KEYWORDS)


def _has_finance_signal(subject: str, local: str, domain: str) -> bool:
    if _domain_matches(domain, FINANCE_DOMAINS):
        return True
    if local in FINANCE_LOCALS:
        return True
    subj = (subject or "").lower()
    return any(k in subj for k in FINANCE_SUBJECT)


def classify_email(em: dict) -> dict:
    """Rules classify an inbound email dict (the shape produced by the Gmail
    sync) into a triage bucket.

    Returns {category, section, vendor, unsubscribe_url, classified_by:"rules"}.
    Priority is deliberate: access/money first (never bury a security or billing
    notice under a promo label), then the ops tools you subscribe to, then the
    social/promotional noise.
    """
    addr = (em.get("from_email") or "").strip().lower()
    local, domain = _split_addr(addr)
    subject = em.get("subject") or ""
    labels = set(em.get("labels") or [])       # Gmail CATEGORY_* (per-account path only)
    from_name = em.get("from_name") or ""
    vendor = _vendor_label(from_name, domain)
    unsub = _unsubscribe_url(em.get("list_unsubscribe") or "")

    def result(category: str) -> dict:
        return {
            "category": category,
            "section": _section_for(category),
            "vendor": vendor,
            "unsubscribe_url": unsub,
            "classified_by": "rules",
        }

    # 1. Security / account-access — highest priority, always "systems".
    if _has_security_signal(subject, local):
        return result("security")

    # 2. Money / billing.
    if _has_finance_signal(subject, local, domain):
        return result("finance")

    # 3. Promotions — Gmail's promo label or explicit sale/marketing language.
    #    Checked BEFORE the SaaS-domain rule so a marketing blast from a tool
    #    vendor (Mailchimp "50% off") is safe-to-ignore, not a systems notice.
    if _is_promotional(em, labels, subject):
        return result("promotions")

    # 4. Social networks (label or known domain) — safe to ignore.
    if "CATEGORY_SOCIAL" in labels or _domain_matches(domain, SOCIAL_DOMAINS):
        return result("social")

    # 5. Operational tools / subscriptions — non-promotional notices worth a look.
    if _domain_matches(domain, OPS_SAAS_DOMAINS):
        return result("saas")

    # 6. Generic bulk/marketing headers with no more specific bucket.
    if is_bulk_mail(em):
        return result("promotions")

    # 7. Gmail "Updates"/"Forums" (transactional/newsletter) with nothing more specific.
    if "CATEGORY_UPDATES" in labels or "CATEGORY_FORUMS" in labels:
        return result("updates")

    # 8. Everything else automated → safe to ignore.
    return result("other")


def ai_classify_email(em: dict, client_ai=None) -> dict:
    """Optional AI refinement of classify_email. When an Anthropic client is
    available, Claude picks the category/vendor from the same fixed vocabulary;
    on missing key, bad output, or any error it returns the exact rules result.
    Never raises. (Not called from the sync hot path — opt-in for callers.)"""
    rules = classify_email(em)
    if client_ai is None:
        return rules
    try:
        from modules.ai.router import _run_tool_loop, _strip_json
        import json

        allowed = "saas | finance | security | promotions | social | updates | other"
        system = (
            "You triage a small cleaning company's inbound automated email. "
            f"Choose exactly one category from: {allowed}. "
            "'systems' categories (saas/finance/security) are notices worth a "
            "glance; the rest are safe to ignore. "
            'Respond with ONLY a JSON object: '
            '{"category": string, "vendor": string}.'
        )
        facts = {
            "from": em.get("from_email"), "from_name": em.get("from_name"),
            "subject": em.get("subject"), "snippet": (em.get("snippet") or "")[:400],
            "gmail_labels": em.get("labels") or [],
        }
        text = _run_tool_loop(client_ai, system, json.dumps(facts, default=str),
                              max_tokens=120, max_iters=1)
        data = json.loads(_strip_json(text))
        cat = (data.get("category") or "").strip().lower()
        if cat not in _CATEGORY_SECTION:
            return rules
        vendor = (data.get("vendor") or "").strip() or rules["vendor"]
        return {
            "category": cat,
            "section": _section_for(cat),
            "vendor": vendor[:60],
            "unsubscribe_url": rules["unsubscribe_url"],
            "classified_by": "ai",
        }
    except Exception:
        return rules


def _parse_dt(value):
    """Email Date header → naive-UTC datetime (matches how the rest of the schema
    stores datetimes). None on unparseable input."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def capture_triage_item(db: Session, org_id: Optional[int], em: dict,
                        source_account_id: Optional[int] = None) -> bool:
    """Upsert one automated email into inbox_triage_items (rules classification).

    Deduped on (org_id, Message-ID): a second sighting refreshes the read flag and
    snippet instead of inserting a duplicate. Adds to the session but does NOT
    commit — the caller (run_inbox_sync) owns the transaction. Returns True when a
    new row was created."""
    message_id = (em.get("message_id") or "").strip()
    if message_id:
        existing = (
            db.query(InboxTriageItem)
            .filter(InboxTriageItem.external_id == message_id,
                    InboxTriageItem.org_id == org_id)
            .first()
        )
        if existing:
            existing.is_read = bool(em.get("is_read", existing.is_read))
            if em.get("snippet"):
                existing.snippet = (em.get("snippet") or "")[:500]
            return False

    c = classify_email(em)
    row = InboxTriageItem(
        org_id=org_id,
        external_id=message_id or None,
        source_account_id=source_account_id,
        from_addr=(em.get("from_email") or "")[:255] or None,
        from_name=(em.get("from_name") or "")[:255] or None,
        subject=(em.get("subject") or "")[:500] or None,
        snippet=(em.get("snippet") or em.get("body") or "")[:500] or None,
        received_at=_parse_dt(em.get("date")),
        category=c["category"],
        section=c["section"],
        vendor=(c["vendor"] or "")[:120] or None,
        unsubscribe_url=(c["unsubscribe_url"] or "")[:500] or None,
        classified_by=c["classified_by"],
        is_read=bool(em.get("is_read", False)),
    )
    db.add(row)
    return True
