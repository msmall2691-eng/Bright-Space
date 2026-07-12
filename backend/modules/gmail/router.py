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
from integrations.gmail_inbox import fetch_inbox
from integrations.email_filter import evaluate_inbound_email
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
) -> dict:
    """Match/enrich senders and thread inbound emails into Conversations.
    Shared by the GET /inbox endpoint, the background scheduler, and the
    per-user Gmail-API sync (which passes pre-fetched `emails` plus the
    user_google_accounts id for provenance) so every path behaves identically.
    """
    try:
        if emails is None:
            emails = fetch_inbox(max_results=max_results, skip_automated=skip_automated)
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
                create_lead, reason = evaluate_inbound_email(em)
                if not create_lead:
                    skipped_by_filter += 1
                    # Audit log: every skipped sender is traceable, so "didn't
                    # create a lead" never silently drops a real customer.
                    logger.info("[gmail] skip lead for %s: %s", addr, reason)
                    client_cache[addr] = None
                    em["client"] = None
                    em["is_known_contact"] = False
                    # Still tag the email so the UI can offer "Convert to client"
                    em["can_convert_to_client"] = True
                    em["lead_skip_reason"] = reason
                    continue

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

            client_cache[addr] = (
                {"id": c.id, "name": c.name, "status": c.status,
                 "client_type": getattr(c, "client_type", None)} if c else None
            )

        em["client"] = client_cache[addr]
        em["is_known_contact"] = client_cache[addr] is not None

        # Thread the email into a Conversation (channel='email') so it shows
        # in the unified inbox alongside SMS. Dedupes on Message-ID and reuses
        # the comms SLA/unread bookkeeping. Also backfills conversation_id on
        # any legacy orphaned rows. Only known clients get threaded — unknown
        # senders surface via the "Convert to client" affordance first.
        client_id = em["client"]["id"] if em["client"] else None
        if client_id:
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

    # Always commit: threading creates Conversations/Messages even when no new
    # Client was enriched, so the prior `new_contacts or auto_enrich` guard
    # would have silently dropped threaded emails on a rollback-free path.
    try:
        db.commit()
    except Exception as e:
        logger.error(f"[gmail] inbox sync commit failed: {e}")
        db.rollback()

    total = len(emails)
    linked = sum(1 for e in emails if e["is_known_contact"])

    return {
        "emails": emails,
        "summary": {
            "total": total,
            "threaded": threaded,
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
    Message-ID dedupe means overlap with the shared IMAP inbox is harmless."""
    from integrations.google_accounts import AccountCredentialsError, account_credentials, mark_sync
    from integrations.gmail_api import fetch_inbox_for_account
    try:
        creds = account_credentials(db, account)
        emails = fetch_inbox_for_account(creds, max_results=max_results)
    except AccountCredentialsError as e:
        # account_credentials already marked the row expired with the reason.
        logger.info(f"[gmail] account sync skipped: {e}")
        return {"error": "reconnect_required", "summary": {"total": 0, "threaded": 0}}
    except Exception as e:
        logger.warning(f"[gmail] account sync failed for {account.email}: {e}")
        mark_sync(db, account, error=str(e))
        return {"error": str(e), "summary": {"total": 0, "threaded": 0}}
    result = run_inbox_sync(db, emails=emails, source_account_id=account.id)
    mark_sync(db, account, error=None)
    return result


