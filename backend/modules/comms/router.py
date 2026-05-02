"""
Comms router — omnichannel inbox (Phase 1).

Every message is grouped into a Conversation with status, assignment, SLA,
priority, tags, and unread tracking. Channels supported: sms, email.
Chat/WhatsApp stubs are ready to plug in.

Legacy endpoints (/messages, /sms, /email) are preserved for backward
compatibility — they now auto-attach to a Conversation behind the scenes.
"""
from datetime import datetime, timedelta
from typing import List, Optional
import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.orm import Session, joinedload

from database.db import get_db
from database.models import Message, Conversation, Client, LeadIntake, ContactPhone
from integrations.twilio_client import send_sms
from integrations.email import send_email as _send_email
from utils.phone import digits_only as _digits_only, phone_tail as _phone_tail

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Default First Response Time target (minutes) per priority.
# Overridable via env: SLA_FRT_NORMAL=120 etc.
SLA_FRT_MINUTES = {
    "urgent": int(os.getenv("SLA_FRT_URGENT", "15")),
    "high":   int(os.getenv("SLA_FRT_HIGH",   "60")),
    "normal": int(os.getenv("SLA_FRT_NORMAL", "120")),   # 2 hours
    "low":    int(os.getenv("SLA_FRT_LOW",    "480")),   # 8 hours
}

DEFAULT_ASSIGNEE = os.getenv("DEFAULT_CONVERSATION_ASSIGNEE") or None


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class SMSRequest(BaseModel):
    to: str
    body: str
    client_id: Optional[int] = None


class EmailRequest(BaseModel):
    to: str
    subject: str
    body: str
    client_id: Optional[int] = None


class SendReplyRequest(BaseModel):
    body: str
    subject: Optional[str] = None
    author: Optional[str] = None


class InternalNoteRequest(BaseModel):
    body: str
    author: Optional[str] = None


class AssignRequest(BaseModel):
    assignee: Optional[str] = None   # null to unassign


class StatusRequest(BaseModel):
    status: str                      # open | pending | snoozed | resolved
    snoozed_until: Optional[datetime] = None


class PriorityRequest(BaseModel):
    priority: str                    # low | normal | high | urgent


class TagsRequest(BaseModel):
    tags: List[str]


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

def _normalize_contact(s: Optional[str]) -> Optional[str]:
    """Normalize phone numbers to E.164 format (+1XXXXXXXXXX).
    Non-phone inputs are lowercased and returned as-is.
    """
    if not s:
        return s
    s = s.strip()
    # Is it phone-ish? Extract digits only (except leading +)
    if re.match(r"^[\+\d\s\(\)\-\.]+$", s):
        digits = re.sub(r"[^\d]", "", s)  # Strip everything except digits
        if not digits:
            return s
        # Normalize to E.164: ensure +1 prefix for US/Canada
        if len(digits) == 10:  # (207) 233-2422 → 2072332422
            digits = "1" + digits
        if len(digits) == 11 and digits[0] == "1":  # Already has country code
            return "+" + digits
        if digits.startswith("1") and len(digits) == 11:
            return "+" + digits
        if len(digits) >= 10:  # Has digits, add + (assume US if no country code)
            return "+" + digits
        return s
    return s.lower()




def _match_client_by_phone(db: Session, phone: str) -> Optional["Client"]:
    """Match a phone number to a Client using indexed phone_tail column.
    O(log n) lookup instead of full-table scans. Handles all formats
    by matching last 10 digits.

    1. Exact match on primary client.phone first (fastest).
    2. Exact match on any ContactPhone.
    3. Indexed tail match across both tables (O(log n)).
    """
    if not phone:
        return None

    # 1. Exact match on primary phone
    client = db.query(Client).filter(Client.phone == phone).first()
    if client:
        return client

    # 2. Exact match on any ContactPhone
    contact_phone = db.query(ContactPhone).filter(ContactPhone.phone == phone).first()
    if contact_phone:
        return contact_phone.client

    # 3. Indexed tail match — no full-table scans
    tail = _phone_tail(phone)
    if not tail:
        return None

    # Check primary client phones via indexed lookup
    client = db.query(Client).filter(Client.phone_tail == tail).first()
    if client:
        return client

    # Check ContactPhone records via indexed lookup, eager-load the client
    contact_phone = (
        db.query(ContactPhone)
          .options(joinedload(ContactPhone.client))
          .filter(ContactPhone.phone_tail == tail)
          .first()
    )
    if contact_phone:
        return contact_phone.client

    return None


def _sla_state(conv: Conversation) -> str:
    """Return one of: none | met | on_track | at_risk | breached."""
    if not conv.sla_deadline:
        return "none"
    # If teammate already responded within deadline, SLA met.
    if conv.first_response_at and conv.first_response_at <= conv.sla_deadline:
        return "met"
    now = datetime.utcnow()
    if now > conv.sla_deadline:
        return "breached"
    if (conv.sla_deadline - now).total_seconds() < 30 * 60:
        return "at_risk"
    return "on_track"


def conv_to_dict(c: Conversation, *, include_client: bool = True) -> dict:
    last = c.messages[-1] if c.messages else None
    preview = None
    if last:
        preview = (last.body or "")[:200]
    out = {
        "id": c.id,
        "client_id": c.client_id,
        "external_contact": c.external_contact,
        "channel": c.channel,
        "subject": c.subject,
        "status": c.status,
        "priority": c.priority,
        "assignee": c.assignee,
        "tags": c.tags or [],
        "unread_count": c.unread_count,
        "last_message_at": c.last_message_at.isoformat() if c.last_message_at else None,
        "last_inbound_at": c.last_inbound_at.isoformat() if c.last_inbound_at else None,
        "last_outbound_at": c.last_outbound_at.isoformat() if c.last_outbound_at else None,
        "first_response_at": c.first_response_at.isoformat() if c.first_response_at else None,
        "sla_response_minutes": c.sla_response_minutes,
        "sla_deadline": c.sla_deadline.isoformat() if c.sla_deadline else None,
        "sla_state": _sla_state(c),
        "snoozed_until": c.snoozed_until.isoformat() if c.snoozed_until else None,
        "resolved_at": c.resolved_at.isoformat() if c.resolved_at else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "preview": preview,
    }
    if include_client and c.client:
        out["client"] = {
            "id": c.client.id,
            "name": c.client.name,
            "email": c.client.email,
            "phone": c.client.phone,
            "status": c.client.status,
        }
    return out


def msg_to_dict(m: Message) -> dict:
    return {
        "id": m.id,
        "conversation_id": m.conversation_id,
        "client_id": m.client_id,
        "channel": m.channel,
        "direction": m.direction,
        "from_addr": m.from_addr,
        "to_addr": m.to_addr,
        "subject": m.subject,
        "body": m.body,
        "status": m.status,
        "is_internal_note": bool(m.is_internal_note),
        "author": m.author,
        "external_id": m.external_id,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


# ---------------------------------------------------------------------------
# Conversation helpers
# ---------------------------------------------------------------------------

def find_or_create_conversation(
    db: Session,
    *,
    channel: str,
    client_id: Optional[int] = None,
    external_contact: Optional[str] = None,
    subject: Optional[str] = None,
) -> Conversation:
    """
    Find the current (non-resolved) conversation for this contact + channel,
    or create a new one. Preference: match by client_id, else by contact.
    """
    external_contact = _normalize_contact(external_contact)
    q = db.query(Conversation).filter(Conversation.channel == channel)
    if client_id:
        q = q.filter(Conversation.client_id == client_id)
    elif external_contact:
        q = q.filter(Conversation.external_contact == external_contact)
    else:
        q = None

    if q is not None:
        conv = (q.filter(Conversation.status != "resolved")
                 .order_by(Conversation.last_message_at.desc()).first())
        if conv:
            return conv

    conv = Conversation(
        client_id=client_id,
        external_contact=external_contact,
        channel=channel,
        subject=subject,
        status="open",
        priority="normal",
        assignee=DEFAULT_ASSIGNEE,
    )
    db.add(conv)
    db.flush()
    return conv


def _apply_inbound(conv: Conversation, msg: Message):
    """Update conversation aggregates + SLA when an inbound message arrives."""
    now = msg.created_at or datetime.utcnow()
    conv.last_message_at = now
    conv.last_inbound_at = now
    conv.unread_count = (conv.unread_count or 0) + 1
    # Re-open if resolved
    if conv.status == "resolved":
        conv.status = "open"
        conv.resolved_at = None
    # Reset first_response tracking and compute a new SLA deadline
    conv.first_response_at = None
    frt = SLA_FRT_MINUTES.get(conv.priority or "normal", 120)
    conv.sla_response_minutes = frt
    conv.sla_deadline = now + timedelta(minutes=frt)


def _apply_outbound(conv: Conversation, msg: Message):
    now = msg.created_at or datetime.utcnow()
    conv.last_message_at = now
    conv.last_outbound_at = now
    # First reply after an inbound? Record it for SLA
    if conv.last_inbound_at and not conv.first_response_at:
        conv.first_response_at = now


# ---------------------------------------------------------------------------
# Diagnostic / health
# ---------------------------------------------------------------------------

@router.get("/_health")
def comms_health(db: Session = Depends(get_db)):
    """
    Cheap schema + connectivity smoke test. Surfaces the actual exception
    instead of a generic 500 so we can diagnose deploy issues in the browser.
    """
    report = {"db": "unknown", "messages_table": None, "conversations_table": None,
              "message_columns": [], "conversation_columns": [], "errors": []}
    try:
        from sqlalchemy import inspect
        insp = inspect(db.get_bind())
        cols_msg = [c["name"] for c in insp.get_columns("messages")] if insp.has_table("messages") else []
        cols_conv = [c["name"] for c in insp.get_columns("conversations")] if insp.has_table("conversations") else []
        report["messages_table"] = insp.has_table("messages")
        report["conversations_table"] = insp.has_table("conversations")
        report["message_columns"] = cols_msg
        report["conversation_columns"] = cols_conv
        report["db"] = db.get_bind().dialect.name
    except Exception as exc:
        report["errors"].append(f"inspect: {exc!r}")

    try:
        cnt = db.query(Message).count()
        report["message_count"] = cnt
    except Exception as exc:
        report["errors"].append(f"select messages: {exc!r}")

    try:
        cnt = db.query(Conversation).count()
        report["conversation_count"] = cnt
    except Exception as exc:
        report["errors"].append(f"select conversations: {exc!r}")

    return report


# ---------------------------------------------------------------------------
# Conversation endpoints
# ---------------------------------------------------------------------------

@router.get("/conversations")
def list_conversations(
    status: Optional[str] = Query(None, description="open|pending|snoozed|resolved"),
    assignee: Optional[str] = None,
    channel: Optional[str] = None,
    unread_only: bool = False,
    q: Optional[str] = None,
    tag: Optional[str] = None,
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
):
    """List conversations with rich filters. Ordered newest-first by activity."""
    query = db.query(Conversation)
    if status:
        query = query.filter(Conversation.status == status)
    if assignee == "unassigned":
        query = query.filter(Conversation.assignee.is_(None))
    elif assignee:
        query = query.filter(Conversation.assignee == assignee)
    if channel:
        query = query.filter(Conversation.channel == channel)
    if unread_only:
        query = query.filter(Conversation.unread_count > 0)
    if q:
        needle = f"%{q.lower()}%"
        query = (query.outerjoin(Client, Conversation.client_id == Client.id)
                      .filter(or_(
                          func.lower(Conversation.subject).like(needle),
                          func.lower(Conversation.external_contact).like(needle),
                          func.lower(Client.name).like(needle),
                          func.lower(Client.email).like(needle),
                          func.lower(Client.phone).like(needle),
                      )))
    convs = (query.order_by(Conversation.last_message_at.desc().nulls_last()
                            if hasattr(Conversation.last_message_at.desc(), "nullslast")
                            else Conversation.last_message_at.desc())
                  .limit(limit).all())
    # Tag filter (JSON contains — easier in Python than cross-dialect SQL)
    if tag:
        convs = [c for c in convs if tag in (c.tags or [])]
    return [conv_to_dict(c) for c in convs]


@router.get("/conversations/summary")
def conversations_summary(db: Session = Depends(get_db)):
    """Quick counts for inbox filter badges."""
    base = db.query(Conversation)
    return {
        "open":       base.filter(Conversation.status == "open").count(),
        "pending":    base.filter(Conversation.status == "pending").count(),
        "snoozed":    base.filter(Conversation.status == "snoozed").count(),
        "resolved":   base.filter(Conversation.status == "resolved").count(),
        "unassigned": base.filter(Conversation.assignee.is_(None),
                                   Conversation.status == "open").count(),
        "unread":     base.filter(Conversation.unread_count > 0).count(),
    }


@router.get("/conversations/{conv_id}")
def get_conversation(conv_id: int, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    return {
        **conv_to_dict(conv),
        "messages": [msg_to_dict(m) for m in conv.messages],
    }


@router.post("/conversations/{conv_id}/messages")
def send_reply(conv_id: int, data: SendReplyRequest, db: Session = Depends(get_db)):
    """Send an outbound message on this conversation via its channel."""
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")

    to_addr = (conv.client.phone if conv.channel == "sms" and conv.client else None) \
              or (conv.client.email if conv.channel == "email" and conv.client else None) \
              or conv.external_contact
    if not to_addr:
        raise HTTPException(400, "No destination address for this conversation")

    from_addr = ""
    status = "sent"
    external_id = None

    try:
        if conv.channel == "sms":
            result = send_sms(to=to_addr, body=data.body)
            from_addr = os.getenv("TWILIO_PHONE_NUMBER", "")
            status = result.get("status", "sent")
            external_id = result.get("sid")
        elif conv.channel == "email":
            subject = data.subject or conv.subject or "Re: your message"
            _send_email(to=to_addr, subject=subject, html_body=data.body, text_body=data.body)
            from_addr = os.getenv("SMTP_FROM", os.getenv("SMTP_USER", ""))
        else:
            raise HTTPException(400, f"Channel {conv.channel} not sendable")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, f"Configuration error: {e}")
    except RuntimeError as e:
        raise HTTPException(502, f"Service error: {e}")
    except Exception as e:
        logger.error(f"[comms] Failed to send {conv.channel} message: {e}")
        raise HTTPException(502, f"Send failed: {e}")

    msg = Message(
        client_id=conv.client_id,
        conversation_id=conv.id,
        channel=conv.channel,
        direction="outbound",
        from_addr=from_addr,
        to_addr=to_addr,
        subject=data.subject or conv.subject,
        body=data.body,
        status=status,
        external_id=external_id,
        author=data.author,
        is_internal_note=False,
    )
    db.add(msg)
    db.flush()
    _apply_outbound(conv, msg)
    # Sending a reply marks inbound as read.
    conv.unread_count = 0
    db.commit()
    db.refresh(msg)
    db.refresh(conv)
    return msg_to_dict(msg)


@router.post("/conversations/{conv_id}/notes")
def add_internal_note(conv_id: int, data: InternalNoteRequest, db: Session = Depends(get_db)):
    """Attach an internal-only note to this conversation."""
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    msg = Message(
        client_id=conv.client_id,
        conversation_id=conv.id,
        channel=conv.channel,
        direction="note",
        body=data.body,
        status="sent",
        author=data.author,
        is_internal_note=True,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg_to_dict(msg)


@router.post("/conversations/{conv_id}/assign")
def assign_conversation(conv_id: int, data: AssignRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    conv.assignee = data.assignee or None
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/status")
def set_status(conv_id: int, data: StatusRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.status not in ("open", "pending", "snoozed", "resolved"):
        raise HTTPException(400, "Invalid status")
    conv.status = data.status
    if data.status == "resolved":
        conv.resolved_at = datetime.utcnow()
    elif data.status == "snoozed":
        conv.snoozed_until = data.snoozed_until
    elif data.status == "open":
        conv.resolved_at = None
        conv.snoozed_until = None
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/priority")
def set_priority(conv_id: int, data: PriorityRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.priority not in ("low", "normal", "high", "urgent"):
        raise HTTPException(400, "Invalid priority")
    conv.priority = data.priority
    # Recompute SLA deadline relative to the unresponded inbound
    if conv.last_inbound_at and not conv.first_response_at:
        frt = SLA_FRT_MINUTES.get(data.priority, 120)
        conv.sla_response_minutes = frt
        conv.sla_deadline = conv.last_inbound_at + timedelta(minutes=frt)
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/tags")
def set_tags(conv_id: int, data: TagsRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    conv.tags = data.tags
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/read")
def mark_read(conv_id: int, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    conv.unread_count = 0
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


# ---------------------------------------------------------------------------
# Legacy endpoints (backward-compatible)
# ---------------------------------------------------------------------------

@router.get("/messages")
def get_messages(
    client_id: Optional[int] = None,
    channel: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Flat message feed — kept for backward compat with older UI code."""
    q = db.query(Message)
    if client_id:
        q = q.filter(Message.client_id == client_id)
    if channel:
        q = q.filter(Message.channel == channel)
    return [msg_to_dict(m) for m in q.order_by(Message.created_at.desc()).limit(200).all()]


@router.post("/sms")
def send_sms_message(data: SMSRequest, db: Session = Depends(get_db)):
    """Send an SMS via Twilio — attaches to a conversation automatically.
    If no client_id provided, tries to match the destination phone to an existing client.
    """
    # Normalize phone to E.164 format for consistent storage
    to_normalized = _normalize_contact(data.to)

    try:
        result = send_sms(to=to_normalized, body=data.body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Configuration error: {e}")
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"Twilio error: {e}")
    except Exception as e:
        logger.error(f"[comms] Failed to send SMS: {e}")
        raise HTTPException(status_code=502, detail=f"SMS error: {e}")

    client_id = data.client_id
    if not client_id:
        matched = _match_client_by_phone(db, to_normalized)
        if matched:
            client_id = matched.id

    conv = find_or_create_conversation(
        db, channel="sms",
        client_id=client_id,
        external_contact=to_normalized,
    )
    # Ensure the conv is linked if we newly matched a client
    if client_id and not conv.client_id:
        conv.client_id = client_id

    msg = Message(
        client_id=client_id,
        conversation_id=conv.id,
        channel="sms",
        direction="outbound",
        from_addr=_normalize_contact(os.getenv("TWILIO_PHONE_NUMBER", "")),
        to_addr=to_normalized,
        body=data.body,
        status=result.get("status", "sent"),
        external_id=result.get("sid"),
    )
    db.add(msg)
    db.flush()
    _apply_outbound(conv, msg)
    db.commit()
    db.refresh(msg)
    return msg_to_dict(msg)


@router.post("/email")
def send_email_message(data: EmailRequest, db: Session = Depends(get_db)):
    """Send an email via SMTP — attaches to a conversation automatically."""
    try:
        _send_email(to=data.to, subject=data.subject, html_body=data.body, text_body=data.body)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Email error: {e}")

    conv = find_or_create_conversation(
        db, channel="email",
        client_id=data.client_id,
        external_contact=data.to,
        subject=data.subject,
    )
    msg = Message(
        client_id=data.client_id,
        conversation_id=conv.id,
        channel="email",
        direction="outbound",
        from_addr=os.getenv("SMTP_FROM", os.getenv("SMTP_USER", "")),
        to_addr=data.to,
        subject=data.subject,
        body=data.body,
        status="sent",
    )
    db.add(msg)
    db.flush()
    _apply_outbound(conv, msg)
    db.commit()
    db.refresh(msg)
    return msg_to_dict(msg)


@router.post("/twilio/webhook")
async def twilio_inbound(request: Request, db: Session = Depends(get_db)):
    """Receive inbound SMS from Twilio webhook. Groups into a conversation."""
    form = await request.form()
    from_number = form.get("From", "")
    to_number = form.get("To", "")
    body = form.get("Body", "")
    sid = form.get("MessageSid") or form.get("SmsSid")

    logger.info(f"[twilio] Inbound SMS from {from_number} to {to_number}: {body[:50]}...")

    # Dedup — if we've seen this SID before, ignore
    if sid:
        existing = db.query(Message).filter(Message.external_id == sid).first()
        if existing:
            return Response(
                content="<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>",
                media_type="text/xml",
            )

    # Normalize phone to E.164 for consistent lookups and storage
    from_number_normalized = _normalize_contact(from_number)

    # Match to a client by phone number (fuzzy — handles format mismatches)
    client = _match_client_by_phone(db, from_number_normalized)
    if client:
        logger.info(f"[twilio] Matched inbound {from_number} → client #{client.id} ({client.name})")
        # Update primary phone to E.164 format if needed
        if client.phone != from_number_normalized:
            logger.info(f"[twilio] Updating client phone: {client.phone!r} → {from_number_normalized!r}")
            client.phone = from_number_normalized
        # Add or update contact phone if not already present
        existing_contact = db.query(ContactPhone).filter(
            ContactPhone.client_id == client.id,
            ContactPhone.phone == from_number_normalized
        ).first()
        if not existing_contact:
            new_contact = ContactPhone(
                client_id=client.id,
                phone=from_number_normalized,
                phone_type="mobile",
                source="twilio",
            )
            db.add(new_contact)
            logger.info(f"[twilio] Added contact phone {from_number_normalized} for client #{client.id}")
    else:
        logger.info(f"[twilio] New contact from {from_number_normalized}")
        client = Client(
            name=from_number_normalized,
            phone=from_number_normalized,
            status="lead",
            source="sms",
        )
        db.add(client)
        db.flush()

    conv = find_or_create_conversation(
        db, channel="sms",
        client_id=client.id,
        external_contact=from_number_normalized,
    )
    msg = Message(
        client_id=client.id,
        conversation_id=conv.id,
        channel="sms",
        direction="inbound",
        from_addr=from_number_normalized,
        to_addr=_normalize_contact(to_number),
        body=body,
        status="received",
        external_id=sid,
    )
    db.add(msg)
    db.flush()
    _apply_inbound(conv, msg)
    db.commit()

    return Response(
        content="<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>",
        media_type="text/xml",
    )
