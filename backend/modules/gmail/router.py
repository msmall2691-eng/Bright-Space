"""
Gmail sync module (no HTTP surface).

Historically this was mounted at /api/gmail and served the GmailInbox UI
(fetch inbox / open message / create-lead / link-client / send-reply).
The UI was retired when email threading moved into the unified Conversation
list — see the note in pages/Comms.jsx — so those HTTP endpoints have no
callers. What's left is the sync pipeline the scheduler calls on a tick:

  - `run_inbox_sync`         — pull the shared business inbox (IMAP + App
                               Password) and thread new messages into
                               Conversations.
  - `run_account_inbox_sync` — same idea for a per-user connected Google
                               account (Gmail API path).

Both use `evaluate_inbound_email` to decide whether an unknown sender is
a real prospect worth auto-creating a Client for.
"""
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Optional

from database.models import Client, ContactEmail, Activity, Message
from integrations.gmail_inbox import fetch_inbox, _is_automated
from integrations.email_filter import evaluate_inbound_email, should_thread_inbound_email
from services.inbox_triage import capture_triage_item
from utils.activity_logger import log_email
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)


def _match_email_to_client(email_addr: str, db: Session):
    if not email_addr:
        return None
    addr = email_addr.strip().lower()
    ce = db.query(ContactEmail).filter(
        func.lower(ContactEmail.email) == addr
    ).first()
    if ce:
        return ce.client
    return db.query(Client).filter(
        func.lower(Client.email) == addr
    ).first()


def _ensure_contact_email(client_id: int, email: str, source: str, db: Session):
    addr = email.strip().lower()
    existing = db.query(ContactEmail).filter(
        ContactEmail.client_id == client_id,
        func.lower(ContactEmail.email) == addr,
    ).first()
    if not existing:
        has_any = db.query(ContactEmail).filter(
            ContactEmail.client_id == client_id
        ).first()
        ce = ContactEmail(
            client_id=client_id,
            email=addr,
            is_primary=not has_any,
            source=source,
        )
        db.add(ce)
    return existing


def _log_activity(db, **kwargs):
    """Thin compat wrapper — defers to utils.activity_logger.log_activity."""
    from utils.activity_logger import log_activity
    return log_activity(db, **kwargs)


def _parse_email_dt(value: str):
    """Parse an email's ISO date into a naive-UTC datetime.

    The rest of the schema stores naive UTC datetimes (see database.models._utcnow
    + comms._iso_utc, which re-attaches the 'Z' on serialize). Email Date headers
    are usually timezone-aware, so normalize to UTC and drop tzinfo to match.
    Returns None on unparseable input so the caller can fall back to now().
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _thread_inbound_email(db: Session, client_id: int, em: dict,
                          account_id: Optional[int] = None) -> bool:
    """Attach an inbound email to a Conversation (channel='email'), mirroring
    the SMS webhook so emails show up in the unified inbox threaded by client.

    Dedupes on the email Message-ID (external_id). Returns True if a new
    Message was created, False if it was a duplicate. Reuses the comms helpers
    so SLA / unread / last-activity bookkeeping stays identical to SMS.

    account_id stamps which member's connected Google account synced the
    message in (None = the legacy shared business inbox).
    """
    # Lazy import avoids any import-order coupling between the two routers.
    from modules.comms.router import find_or_create_conversation, _apply_inbound

    message_id = (em.get("message_id") or "").strip()
    if message_id:
        existing = db.query(Message).filter(Message.external_id == message_id).first()
        if existing:
            # Backfill: legacy rows were created without a conversation_id.
            # Thread them now so they stop being orphaned in the inbox.
            if existing.conversation_id is None:
                conv = find_or_create_conversation(
                    db, channel="email",
                    client_id=client_id,
                    external_contact=em.get("from_email", ""),
                    subject=em.get("subject", ""),
                )
                existing.conversation_id = conv.id
                if conv.client_id is None and client_id:
                    conv.client_id = client_id
            return False

    from_addr = em.get("from_email", "")
    conv = find_or_create_conversation(
        db, channel="email",
        client_id=client_id,
        external_contact=from_addr,
        subject=em.get("subject", ""),
    )
    if conv.client_id is None and client_id:
        conv.client_id = client_id
    if account_id and conv.synced_by_google_account_id is None:
        conv.synced_by_google_account_id = account_id

    msg = Message(
        client_id=client_id,
        conversation_id=conv.id,
        channel="email",
        direction="inbound",
        from_addr=from_addr,
        to_addr=em.get("to", "") or em.get("to_email", ""),
        subject=em.get("subject", ""),
        body=em.get("body", ""),
        external_id=message_id or None,
        status="received",
        is_internal_note=False,
        synced_by_google_account_id=account_id,
        created_at=_parse_email_dt(em.get("date")) or datetime.now(timezone.utc),
    )
    db.add(msg)
    db.flush()
    _apply_inbound(conv, msg)
    return True


def run_inbox_sync(
    db: Session,
    *,
    max_results: int = 30,
    skip_automated: bool = True,
    auto_enrich: bool = True,
    emails: Optional[list] = None,
    source_account_id: Optional[int] = None,
    org_id: Optional[int] = None,
) -> dict:
    """Match/enrich senders and thread inbound emails into Conversations.
    Shared by the GET /inbox endpoint, the background scheduler, and the
    per-user Gmail-API sync (which passes pre-fetched `emails` plus the
    user_google_accounts id for provenance) so every path behaves identically.

    Emails that don't thread (automated/bulk: no-reply, marketing, SaaS notices)
    are captured into inbox_triage_items for the board's triage sections instead
    of being discarded. `org_id` stamps those rows (the per-account path passes
    the account's org; the shared inbox passes None → legacy NULL-org, tolerated
    by the board's org filter).
    """
    # Cursor: only the shared-inbox IMAP path (emails not pre-supplied by a
    # caller) manages this — the per-account Gmail API path has its own
    # pagination and callers that inject `emails` directly (tests, one-off
    # re-syncs) shouldn't have this run's date silently become "the last
    # time anyone synced anything."
    advance_cursor = emails is None
    try:
        if emails is None:
            from integrations.gmail_inbox import get_last_synced_at
            since = get_last_synced_at()
            emails = fetch_inbox(max_results=max_results, skip_automated=skip_automated, since=since)
    except ConnectionError as e:
        err = str(e)
        if "no_credentials" in err:
            return {
                "emails": [],
                "error": "no_credentials",
                "message": "No email credentials configured. Go to Settings → Email & Integrations to connect Gmail.",
                "summary": {"total": 0, "linked": 0, "unlinked": 0, "unread": 0},
            }
        elif "imap_auth_failed" in err:
            return {
                "emails": [],
                "error": "auth_failed",
                "message": "Gmail authentication failed. Check your App Password in Settings → Email & Integrations.",
                "summary": {"total": 0, "linked": 0, "unlinked": 0, "unread": 0},
            }
        else:
            return {
                "emails": [],
                "error": "connection_error",
                "message": f"Could not connect to Gmail: {err}",
                "summary": {"total": 0, "linked": 0, "unlinked": 0, "unread": 0},
            }

    client_cache = {}
    new_contacts = 0
    skipped_by_filter = 0
    threaded = 0
    triaged = 0

    for em in emails:
        addr = em["from_email"]
        if addr not in client_cache:
            c = _match_email_to_client(addr, db)
            if c:
                _ensure_contact_email(c.id, addr, "gmail_sync", db)
                c.last_contacted_at = datetime.now(timezone.utc)
                c.email_verified = True
            elif auto_enrich and addr:
                # Defer to the spam/intent filter before auto-creating a Client.
                # NOTE: a False here only means "don't auto-create a Client" —
                # it does NOT mean "hide this email" (see should_thread_inbound_email
                # below). Content-based misses (a real prospect who didn't
                # happen to use a cleaning keyword) must still surface somewhere.
                create_lead, reason = evaluate_inbound_email(em)
                if not create_lead:
                    skipped_by_filter += 1
                    # Audit log: every skipped sender is traceable, so "didn't
                    # create a lead" never silently drops a real customer.
                    logger.info("[gmail] skip lead for %s: %s", addr, reason)
                    em["can_convert_to_client"] = True
                    em["lead_skip_reason"] = reason
                    c = None
                else:
                    from_name = em.get("from_name", "").strip() or addr.split("@")[0]
                    parts = from_name.split(" ", 1)
                    c = Client(
                        name=from_name,
                        first_name=parts[0],
                        last_name=parts[1] if len(parts) > 1 else "",
                        email=addr.lower(),
                        status="lead",
                        source="email",
                        # Trace WHY this lead was auto-created (reply vs cleaning intent).
                        source_detail=f"gmail auto-enrich:{reason}",
                        email_verified=True,
                        # BB-MT-01: the per-account path passes its account's org_id
                        # (see run_inbox_sync's docstring) — leaving this off left every
                        # auto-created lead org_id NULL, so the NULL-tolerant _org()
                        # filter surfaced it on EVERY workspace's board/brief, not just
                        # the one whose inbox produced it.
                        org_id=org_id,
                    )
                    db.add(c)
                    db.flush()
                    _ensure_contact_email(c.id, addr, "gmail_sync", db)
                    _log_activity(
                        db,
                        client_id=c.id,
                        activity_type="email_received",
                        summary=f"Auto-created from email: {em.get('subject', '(no subject)')}",
                        extra_data={"from_email": addr, "from_name": from_name},
                    )
                    new_contacts += 1
            else:
                c = None

            client_cache[addr] = (
                {"id": c.id, "name": c.name, "status": c.status,
                 "client_type": getattr(c, "client_type", None)} if c else None
            )

        em["client"] = client_cache[addr]
        em["is_known_contact"] = client_cache[addr] is not None
        em.setdefault("can_convert_to_client", False)
        em.setdefault("lead_skip_reason", None)

        # Thread EVERY email into a Conversation (channel='email') so it
        # shows in the unified inbox alongside SMS — known client or not;
        # client-less conversations are a first-class shape here (see
        # find_or_create_conversation). Dedupes on Message-ID and reuses the
        # comms SLA/unread bookkeeping. Also backfills conversation_id on any
        # legacy orphaned rows.
        #
        # should_thread_inbound_email is a SEPARATE, narrower gate than the
        # create_lead decision above: it only excludes definitive
        # automated/bulk senders (no-reply addresses, marketing/SaaS
        # domains, newsletter headers), never on content. Audit finding #3:
        # this used to be `if client_id:` — an unknown sender that failed
        # the keyword classifier was skipped here entirely and was only
        # ever a log line in Railway, even when it was a real prospect.
        # A KNOWN contact's email ALWAYS threads — a real customer replying
        # from their normal address must never be filtered out of Comms, even
        # if their mail carries bulk headers (List-Unsubscribe, etc.) that many
        # legitimate small-business/ESP senders add. The bulk/spam gate only
        # applies to UNKNOWN senders, to keep cold marketing blasts out of the
        # inbox. (Fixes "customer emails aren't showing up in Comms".)
        #
        # `not _is_automated(addr)` keeps the per-account path's Comms output
        # identical to before: automated senders (no-reply@, @github.com, etc.)
        # used to be dropped at the fetch boundary (skip_automated) and never
        # reached Comms. Now they flow through for triage capture, so exclude
        # them from threading here — they land in the else-branch (triage)
        # instead, exactly matching their old "not in Comms" outcome.
        if em.get("is_known_contact") or (should_thread_inbound_email(em) and not _is_automated(addr)):
            client_id = em["client"]["id"] if em["client"] else None
            # Savepoint per email: one bad message must not poison the whole
            # sync transaction — before this, a single IntegrityError aborted
            # every email in the batch AND the failed message was never
            # recorded, so the tick retried (and re-failed) it forever.
            try:
                with db.begin_nested():
                    created = _thread_inbound_email(db, client_id, em, account_id=source_account_id)
            except Exception as e:
                logger.warning(f"[gmail] threading failed for message "
                               f"{em.get('message_id') or '(no id)'} from {em.get('from_email')}: {e}")
                created = False
            em["activity_logged"] = created
            if created:
                threaded += 1
                # Mirror to the activity timeline (best-effort).
                try:
                    log_email(
                        db,
                        "received",
                        client_id=client_id,
                        subject=em.get("subject"),
                        from_email=em.get("from_email"),
                    )
                except Exception as e:
                    logger.warning(f"[gmail] activity log failed (non-fatal): {e}")
        else:
            em["activity_logged"] = False
            # Not threaded → a definitive automated/bulk sender (no-reply,
            # marketing, SaaS/billing notice). Capture it for the board's triage
            # sections (Systems & Subscriptions / Safe to Ignore) instead of
            # dropping it on the floor. Savepoint + best-effort: a bad triage row
            # must never poison the threading transaction (same guard as above).
            try:
                with db.begin_nested():
                    if capture_triage_item(db, org_id, em, source_account_id=source_account_id):
                        triaged += 1
            except Exception as e:
                logger.warning(f"[gmail] triage capture failed for "
                               f"{em.get('from_email') or '(no sender)'}: {e}")

    # Always commit: threading creates Conversations/Messages even when no new
    # Client was enriched, so the prior `new_contacts or auto_enrich` guard
    # would have silently dropped threaded emails on a rollback-free path.
    commit_ok = True
    try:
        db.commit()
    except Exception as e:
        logger.error(f"[gmail] inbox sync commit failed: {e}")
        db.rollback()
        commit_ok = False

    # Advance the cursor only after a successful commit of THIS run's own
    # fetch — a failed commit must not move the watermark forward, or the
    # next tick would skip re-scanning (and re-threading) today's messages.
    if advance_cursor and commit_ok:
        from integrations.gmail_inbox import set_last_synced_at
        set_last_synced_at(datetime.now(timezone.utc).date().isoformat())

    total = len(emails)
    linked = sum(1 for e in emails if e["is_known_contact"])

    return {
        "emails": emails,
        "summary": {
            "total": total,
            "threaded": threaded,
            "triaged": triaged,
            "linked": linked,
            "unlinked": total - linked,
            "unread": sum(1 for e in emails if not e.get("is_read")),
            "new_contacts_created": new_contacts,
            "skipped_by_filter": skipped_by_filter,
        },
    }


def run_account_inbox_sync(db: Session, account, *, max_results: int = 30) -> dict:
    """Sync ONE member's connected Gmail (Gmail API, their own OAuth grant)
    into the unified inbox. Messages stamp the account for provenance;
    Message-ID dedupe means overlap with the shared IMAP inbox is harmless.

    INCREMENTAL when the account has a stored Gmail historyId cursor: only
    messages added to INBOX since the last sync are fetched (cheap, and with no
    fixed message cap so bursts between polls aren't missed). The first sync —
    or one whose cursor has aged out of Gmail's ~1-week history window — falls
    back to a full scan and (re-)seeds the cursor. Uses the existing
    gmail.readonly scope; no new consent."""
    from integrations.google_accounts import AccountCredentialsError, account_credentials, mark_sync
    from integrations.gmail_api import (
        fetch_inbox_for_account, fetch_inbox_incremental, current_history_id, HistoryExpired,
    )
    try:
        creds = account_credentials(db, account)
        cursor = getattr(account, "gmail_history_id", None)
        new_history_id = None
        # skip_automated=False: automated/bulk mail is no longer discarded at the
        # fetch boundary — it flows through so run_inbox_sync can capture it for
        # the board's triage sections (human mail still threads exactly as before).
        if cursor:
            try:
                inc = fetch_inbox_incremental(creds, cursor, skip_automated=False)
                emails = inc["messages"]
                new_history_id = inc["new_history_id"]
            except HistoryExpired:
                # Cursor too old — full re-scan and re-seed from the current id.
                logger.info(f"[gmail] history cursor expired for {account.email}; full re-sync")
                emails = fetch_inbox_for_account(creds, max_results=max_results, skip_automated=False)
                new_history_id = current_history_id(creds)
        else:
            # First sync: full scan, then seed the cursor from the current id so
            # subsequent syncs go incremental.
            emails = fetch_inbox_for_account(creds, max_results=max_results, skip_automated=False)
            new_history_id = current_history_id(creds)
    except AccountCredentialsError as e:
        # account_credentials already marked the row expired with the reason.
        logger.info(f"[gmail] account sync skipped: {e}")
        return {"error": "reconnect_required", "summary": {"total": 0, "threaded": 0}}
    except Exception as e:
        logger.warning(f"[gmail] account sync failed for {account.email}: {e}")
        mark_sync(db, account, error=str(e))
        return {"error": str(e), "summary": {"total": 0, "threaded": 0}}
    result = run_inbox_sync(db, emails=emails, source_account_id=account.id,
                            org_id=getattr(account, "org_id", None))
    # Advance the cursor only after a successful threading pass, so a failure
    # mid-sync re-reads the same window next time rather than skipping messages.
    if new_history_id:
        account.gmail_history_id = new_history_id
    mark_sync(db, account, error=None)
    return result


