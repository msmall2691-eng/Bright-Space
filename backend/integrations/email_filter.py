"""
Filter that decides whether an inbound email should auto-create a Client row.

The default Gmail ingestion flow in modules/gmail/router.py currently creates
a Client for every unknown sender, which has filled BrightBase with ~40
marketing/no-reply addresses (Indeed, Attio, Octoparse, LeaseVille, Replit,
etc.). This module provides should_create_client_from_email() which returns
False for that kind of address and True only when the email looks like it
came from a real prospect.

Usage in gmail/router.py:

    from integrations.email_filter import should_create_client_from_email

    ...
    elif auto_enrich and addr:
        if not should_create_client_from_email(em):
            # Leave as an unlinked inbox item; user can convert manually.
            continue
        # existing Client(...) creation follows here
"""

import re
from typing import Optional


# Domains we never want to auto-create a client for.
# (Matched as a substring against the lowercased email/domain.)
SPAM_DOMAINS = {
    "indeed.com",
    "indeedemail.com",
    "mail.attio.com",
    "mail.replit.com",
    "replit.com",
    "tooljet.com",
    "octoparse.com",
    "leaseville.com",
    "rocket.new",
    "notion.so",
    "linear.app",
    "lever.co",
    "greenhouse.io",
    "mail.airtable.com",
    "sendgrid.net",
    "amazonses.com",
    "mailgun.org",
    "hubspot.com",
    "customer.io",
    "constantcontact.com",
    "mailchimp.com",
    "stripe.com",
    "intuit.com",
    "github.com",
    "gitlab.com",
    "atlassian.net",
    # Marketing/SaaS senders found polluting the live CRM (June audit).
    "pinterest.com",
    "figma.com",
    "turno.com",
    "turnoverbnb.com",
    "textmagic.com",
    "n8n.io",
    "substack.com",
    "klaviyomail.com",
    "sendinblue.com",
    "courts.maine.gov",
    # Cold B2B outreach domains seen in the live data.
    "debtrenegotiatehub.com",
    "outboundherosolution.com",
    "trymailergrowth.pro",
    "terraboostpartnership.com",
    "maidsos.com",
}

# Local-parts that indicate a no-reply / transactional sender.
SPAM_LOCAL_PART_PATTERNS = [
    re.compile(r"^no[-_.]?reply", re.IGNORECASE),
    re.compile(r"^do[-_.]?not[-_.]?reply", re.IGNORECASE),
    re.compile(r"^notifications?", re.IGNORECASE),
    re.compile(r"^alerts?", re.IGNORECASE),
    re.compile(r"^team@mail\.", re.IGNORECASE),
    re.compile(r"^hello@mail\.", re.IGNORECASE),
    re.compile(r"^contact@mail\.", re.IGNORECASE),
    re.compile(r"^support@mail\.", re.IGNORECASE),
    re.compile(r"^marketing@", re.IGNORECASE),
    re.compile(r"^newsletter@", re.IGNORECASE),
    re.compile(r"^updates@", re.IGNORECASE),
    re.compile(r"^info@mail\.", re.IGNORECASE),
]

# Keywords that indicate the email is about actual cleaning work.
# If the subject or the first ~500 chars of the body contains any of these,
# we treat the sender as a real prospect even if their domain is unknown.
CUSTOMER_KEYWORDS = [
    # Only truly cleaning-domain terms. Generic words like "service",
    # "schedule", "office", "home", "appointment" caused too many false
    # positives — every SaaS marketing email matched them. Real
    # customer inquiries will mention one of these specific words.
    "cleaning", "clean", "cleaner", "maid", "housekeeper",
    "deep clean", "deep cleaning",
    "airbnb", "vrbo", "str", "short term rental", "short-term rental",
    "vacation rental", "turnover", "turn over",
    "move in", "move out", "move-in", "move-out",
]

# Sales/marketing phrases that mark cold outreach. Deliberately unambiguous so a
# real customer ("I need my house cleaned") never trips them — these are the
# language of B2B pitches, not service requests.
COLD_OUTREACH_PHRASES = [
    "book a demo", "schedule a demo", "free trial", "increase your leads",
    "more leads", "grow your revenue", "grow your business", "boost your sales",
    "we help businesses like yours", "businesses like yours",
    "limited time offer", "partnership opportunity", "lead generation",
    "increase your revenue", "scale your business",
]

# Domains the business operates under — replies to threads we started.
TRUSTED_REPLY_DOMAINS = {
    "maineclean.co",
    "themaineclean.co",
    "themainecleaning.co",
}


def _split_addr(email_addr: str) -> tuple[str, str]:
    """Return (local_part, domain), both lowercased. Empty strings if malformed."""
    if not email_addr or "@" not in email_addr:
        return ("", "")
    local, _, domain = email_addr.strip().lower().partition("@")
    return (local, domain)


def is_spam_sender(email_addr: str) -> bool:
    """True if the sender looks like a no-reply / marketing / automated address."""
    local, domain = _split_addr(email_addr)
    if not domain:
        return True

    # Domain-level block
    for spam in SPAM_DOMAINS:
        if domain == spam or domain.endswith("." + spam):
            return True

    # Local-part patterns (noreply@, notifications@, etc.)
    for pattern in SPAM_LOCAL_PART_PATTERNS:
        if pattern.search(local):
            return True

    # Subdomain-style senders like team@mail.somecompany.com
    if domain.startswith("mail."):
        return True

    return False


def looks_like_cleaning_inquiry(subject: Optional[str], body: Optional[str]) -> bool:
    """True if subject or body mentions anything related to cleaning services."""
    haystack = f"{subject or ''}\n{body or ''}"[:2000].lower()
    return any(keyword in haystack for keyword in CUSTOMER_KEYWORDS)


def looks_like_cold_outreach(subject: Optional[str], body: Optional[str]) -> bool:
    """True if the email reads like a B2B sales pitch rather than a service request."""
    haystack = f"{subject or ''}\n{body or ''}"[:2000].lower()
    return any(phrase in haystack for phrase in COLD_OUTREACH_PHRASES)


def is_bulk_mail(email: dict) -> bool:
    """True if standard mail headers mark this as bulk/marketing/automated.

    These are definitive machine-set markers (newsletters, ESP blasts, auto
    responders) — present on Pinterest digests, Figma updates, etc. — and are
    far more reliable than maintaining an exhaustive domain block list."""
    if (email.get("list_unsubscribe") or "").strip():
        return True
    if (email.get("precedence") or "").strip().lower() in ("bulk", "list", "junk"):
        return True
    if (email.get("feedback_id") or "").strip():
        return True
    auto = (email.get("auto_submitted") or "").strip().lower()
    if auto and auto != "no":
        return True
    return False


def is_reply_to_our_thread(email: dict) -> bool:
    """
    True if this email appears to be a reply to a message we sent out.
    Heuristics:
      - subject starts with Re: / RE: / Fwd:
      - the to-field (if available) contains one of our domains
      - the email has an In-Reply-To or References header matching our domain
    """
    subject = (email.get("subject") or "").strip().lower()
    if subject.startswith("re:") or subject.startswith("fwd:") or subject.startswith("fw:"):
        return True

    to_addr = (email.get("to_email") or "").lower()
    for d in TRUSTED_REPLY_DOMAINS:
        if d in to_addr:
            return True

    in_reply_to = (email.get("in_reply_to") or "").lower()
    references = (email.get("references") or "").lower()
    for d in TRUSTED_REPLY_DOMAINS:
        if d in in_reply_to or d in references:
            return True

    return False


def evaluate_inbound_email(email: dict) -> tuple[bool, str]:
    """Decide whether an inbound email should auto-create a Client, with a reason.

    Returns (create, reason). The reason is for the rejected-email audit log, so
    "we stopped creating a lead" is always traceable and never means "we silently
    lost a real customer".

    Order matters and is biased toward NOT losing real customers:
      1. reply to our own thread        → create (existing relationship)
      2. blocked / no-reply sender      → skip
      3. bulk/marketing mail headers    → skip
      4. genuine cleaning intent        → create (positive intent wins)
      5. cold-outreach sales language   → skip
      6. anything else                  → skip (inbox-only; promotable by hand)
    """
    addr = (email.get("from_email") or "").strip()
    if not addr:
        return (False, "no_sender")

    if is_reply_to_our_thread(email):
        return (True, "reply_to_thread")

    if is_spam_sender(addr):
        return (False, "blocked_sender")

    if is_bulk_mail(email):
        return (False, "bulk_mail")

    body = email.get("body") or email.get("snippet")
    if looks_like_cleaning_inquiry(email.get("subject"), body):
        return (True, "cleaning_inquiry")

    if looks_like_cold_outreach(email.get("subject"), body):
        return (False, "cold_outreach")

    # Default: don't auto-create. The email still appears in the inbox and the
    # user can manually convert the sender to a client from the UI.
    return (False, "no_cleaning_intent")


def should_create_client_from_email(email: dict) -> bool:
    """Boolean wrapper around evaluate_inbound_email (backwards-compatible)."""
    create, _reason = evaluate_inbound_email(email)
    return create
