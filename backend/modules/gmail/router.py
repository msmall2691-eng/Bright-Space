"""
Gmail Inbox API Router
Fetches inbox, matches senders to clients, creates leads from unknown contacts.
Uses ContactEmail table for multi-email matching and enrichment.

CHANGE (2026-04-18): Gmail auto-enrich no longer creates a Client record for
every unknown sender. It now delegates the decision to
integrations.email_filter.should_create_client_from_email(), which blocks
no-reply / marketing senders and only creates clients for senders whose
message looks like an actual cleaning-service inquiry.
"""
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Optional
from database.db import get_db
from modules.auth.router import require_role
from database.models import Client, ContactEmail, Activity, Message
from integrations.gmail_inbox import fetch_inbox, fetch_email_by_id, send_reply
from integrations.email_filter import should_create_client_from_email
from utils.activity_logger import log_email
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)
router = APIRouter()


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


def _thread_inbound_email(db: Session, client_id: int, em: dict) -> bool:
    """Attach an inbound email to a Conversation (channel='email'), mirroring
    the SMS webhook so emails show up in the unified inbox threaded by client.

    Dedupes on the email Message-ID (external_id). Returns True if a new
    Message was created, False if it was a duplicate. Reuses the comms helpers
    so SLA / unread / last-activity bookkeeping stays identical to SMS.
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
) -> dict:
    """Fetch the Gmail inbox, match/enrich senders, and thread inbound emails
    into Conversations. Shared by the GET /inbox endpoint and the background
    scheduler so on-demand and automatic syncs behave identically.
    """
    try:
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
                if not should_create_client_from_email(em):
                    skipped_by_filter += 1
                    client_cache[addr] = None
                    em["client"] = None
                    em["is_known_contact"] = False
                    # Still tag the email so the UI can offer "Convert to client"
                    em["can_convert_to_client"] = True
                    continue

                from_name = em.get("from_name", "").strip() or addr.split("@")[0]
                parts = from_name.split(" ", 1)
                c = Client(
                    name=from_name,
                    first_name=parts[0],
                    last_name=parts[1] if len(parts) > 1 else "",
                    email=addr.lower(),
                    status="lead",
                    lifecycle_stage="new",
                    source="email",
                    source_detail="gmail auto-enrich",
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
                    created = _thread_inbound_email(db, client_id, em)
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


@router.get("/inbox")
def gmail_inbox(
    max_results: int = Query(30, ge=1, le=100),
    skip_automated: bool = Query(True),
    auto_enrich: bool = Query(True),
    db: Session = Depends(get_db),
):
    """Fetch + thread the Gmail inbox on demand. Thin wrapper over the shared
    run_inbox_sync so manual refreshes and the background scheduler agree."""
    return run_inbox_sync(
        db,
        max_results=max_results,
        skip_automated=skip_automated,
        auto_enrich=auto_enrich,
    )


@router.get("/message/{email_id}")
def gmail_message(email_id: str, db: Session = Depends(get_db)):
    em = fetch_email_by_id(email_id)
    if not em:
        raise HTTPException(404, "Email not found")
    c = _match_email_to_client(em["from_email"], db)
    em["client"] = {"id": c.id, "name": c.name, "status": c.status} if c else None
    em["is_known_contact"] = c is not None
    return em


@router.post("/create-lead", dependencies=[Depends(require_role("admin", "manager"))])
def create_lead_from_email(
    from_name: str = Query(...),
    from_email: str = Query(...),
    db: Session = Depends(get_db),
):
    existing = _match_email_to_client(from_email, db)
    if existing:
        return {"status": "exists", "client": {"id": existing.id, "name": existing.name}}

    parts = from_name.strip().split(" ", 1)
    new_client = Client(
        name=from_name.strip() or from_email,
        first_name=parts[0] if parts else from_name,
        last_name=parts[1] if len(parts) > 1 else "",
        email=from_email.lower(),
        status="lead",
        lifecycle_stage="new",
        source="email",
        source_detail="gmail manual create",
        email_verified=True,
    )
    db.add(new_client)
    db.flush()

    _ensure_contact_email(new_client.id, from_email, "gmail_sync", db)
    _log_activity(
        db,
        client_id=new_client.id,
        activity_type="email_received",
        summary=f"Lead created from Gmail: {from_name}",
        extra_data={"from_email": from_email},
    )
    db.commit()
    db.refresh(new_client)

    logger.info(f"Lead created from email: {from_name} <{from_email}> -> #{new_client.id}")
    return {"status": "created", "client": {"id": new_client.id, "name": new_client.name}}


@router.post("/link-client", dependencies=[Depends(require_role("admin", "manager"))])
def link_email_to_client(
    from_email: str = Query(...),
    client_id: int = Query(...),
    db: Session = Depends(get_db),
):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(404, "Client not found")
    client.email = from_email.lower()
    _ensure_contact_email(client.id, from_email, "gmail_link", db)
    db.commit()
    return {"status": "linked", "client": {"id": client.id, "name": client.name}}


def _get_app_setting(db: Session, key: str):
    from database.models import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else None


class EmailReplyRequest(BaseModel):
    to_email: str
    subject: str
    body: str
    in_reply_to_message_id: Optional[str] = None

@router.post("/send-reply", dependencies=[Depends(require_role("admin", "manager"))])
def send_email_reply(
    data: EmailReplyRequest,
    db: Session = Depends(get_db),
):
    from_email = _get_app_setting(db, "from_email")
    if not from_email:
        raise HTTPException(400, "from_email not configured in settings")

    try:
        result = send_reply(
            to_email=data.to_email,
            from_email=from_email,
            subject=data.subject,
            body=data.body,
            in_reply_to_message_id=data.in_reply_to_message_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error(f"Unexpected error sending reply: {e}")
        raise HTTPException(500, "Failed to send email reply")

    client = _match_email_to_client(data.to_email, db)
    if client:
        client.last_contacted_at = datetime.now(timezone.utc)

        # Thread the outbound reply into the same email Conversation so it
        # appears in the unified inbox. (Previously this referenced undefined
        # `to_email`/`subject`/`body` locals and crashed with NameError on
        # every reply to a known client.)
        from modules.comms.router import find_or_create_conversation, _apply_outbound
        conv = find_or_create_conversation(
            db, channel="email",
            client_id=client.id,
            external_contact=data.to_email,
            subject=data.subject,
        )
        if conv.client_id is None:
            conv.client_id = client.id

        message = Message(
            client_id=client.id,
            conversation_id=conv.id,
            channel="email",
            direction="outbound",
            from_addr=from_email,
            to_addr=data.to_email,
            subject=data.subject,
            body=data.body,
            status="sent",
        )
        db.add(message)
        db.flush()
        _apply_outbound(conv, message)

        log_email(
            db,
            "sent",
            client_id=client.id,
            subject=data.subject,
            from_email=from_email,
            to_email=data.to_email,
            message_id=message.id,
        )

    db.commit()
    return {"status": "sent", "message": result}
