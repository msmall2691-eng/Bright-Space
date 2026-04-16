"""
Gmail Inbox API Router
Fetches inbox, matches senders to clients, creates leads from unknown contacts.
Uses ContactEmail table for multi-email matching and enrichment.
"""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from database.db import get_db
from database.models import Client, ContactEmail, Activity, Message
from integrations.gmail_inbox import fetch_inbox, fetch_email_by_id, send_reply
from datetime import datetime
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
    db.add(Activity(**kwargs))


@router.get("/inbox")
def gmail_inbox(
    max_results: int = Query(30, ge=1, le=100),
    skip_automated: bool = Query(True),
    auto_enrich: bool = Query(True),
    db: Session = Depends(get_db),
):
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
    for em in emails:
        addr = em["from_email"]
        if addr not in client_cache:
            c = _match_email_to_client(addr, db)
            if c:
                _ensure_contact_email(c.id, addr, "gmail_sync", db)
                c.last_contacted_at = datetime.utcnow()
                c.email_verified = True
            elif auto_enrich and addr:
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

    if new_contacts > 0 or auto_enrich:
        try:
            db.commit()
        except Exception:
            db.rollback()

    total = len(emails)
    linked = sum(1 for e in emails if e["is_known_contact"])

    return {
        "emails": emails,
        "summary": {
            "total": total,
            "linked": linked,
            "unlinked": total - linked,
            "unread": sum(1 for e in emails if not e.get("is_read")),
            "new_contacts_created": new_contacts,
        },
    }


@router.get("/message/{email_id}")
def gmail_message(email_id: str, db: Session = Depends(get_db)):
    em = fetch_email_by_id(email_id)
    if not em:
        raise HTTPException(404, "Email not found")
    c = _match_email_to_client(em["from_email"], db)
    em["client"] = {"id": c.id, "name": c.name, "status": c.status} if c else None
    em["is_known_contact"] = c is not None
    return em


@router.post("/create-lead")
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


@router.post("/link-client")
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


@router.post("/send-reply")
def send_email_reply(
    to_email: str = Query(...),
    subject: str = Query(...),
    body: str = Query(...),
    in_reply_to_message_id: str = Query(None),
    db: Session = Depends(get_db),
):
    from_email = _get_app_setting(db, "from_email")
    if not from_email:
        raise HTTPException(400, "from_email not configured in settings")

    try:
        result = send_reply(
            to_email=to_email,
            from_email=from_email,
            subject=subject,
            body=body,
            in_reply_to_message_id=in_reply_to_message_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error(f"Unexpected error sending reply: {e}")
        raise HTTPException(500, "Failed to send email reply")

    client = _match_email_to_client(to_email, db)
    if client:
        client.last_contacted_at = datetime.utcnow()

        message = Message(
            client_id=client.id,
            channel="email",
            direction="outbound",
            from_addr=from_email,
            to_addr=to_email,
            subject=subject,
            body=body,
            status="sent",
        )
        db.add(message)
        db.flush()

        _log_activity(
            db,
            client_id=client.id,
            activity_type="email_sent",
            summary=f"Reply sent to {to_email}",
            extra_data={"to_email": to_email, "subject": subject},
        )

    db.commit()
    return {"status": "sent", "message": result}
