"""
Comms router — omnichannel inbox (Phase 1).

Every message is grouped into a Conversation with status, assignment, SLA,
priority, tags, and unread tracking. Channels supported: sms, email.
Chat/WhatsApp stubs are ready to plug in.

Legacy endpoints (/messages, /sms, /email) are preserved for backward
compatibility — they now auto-attach to a Conversation behind the scenes.
"""
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Union
import logging
import os
import re

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from database.db import get_db
from modules.auth.router import require_role
from database.models import Message, Conversation, Client, LeadIntake, ContactPhone
from integrations.twilio_client import send_sms
from integrations.email import send_email as _send_email
from utils.phone import digits_only as _digits_only, phone_tail as _phone_tail
from utils.dates import add_business_minutes

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Default First Response Time target, in BUSINESS minutes (the clock only runs
# during business hours — see utils.dates.add_business_minutes), per priority.
# Defaults target "same business day" for a normal message so an inbox for a
# 1–2 person office isn't a permanent wall of red. Overridable via env
# (SLA_FRT_NORMAL=480 etc.) and business hours via BUSINESS_OPEN_HOUR /
# BUSINESS_CLOSE_HOUR / BUSINESS_DAYS.
SLA_FRT_MINUTES = {
    "urgent": int(os.getenv("SLA_FRT_URGENT", "30")),    # ~½ business hour
    "high":   int(os.getenv("SLA_FRT_HIGH",   "120")),   # 2 business hours
    "normal": int(os.getenv("SLA_FRT_NORMAL", "480")),   # ~a business day
    "low":    int(os.getenv("SLA_FRT_LOW",    "960")),   # ~2 business days
}

DEFAULT_ASSIGNEE = os.getenv("DEFAULT_CONVERSATION_ASSIGNEE") or None

# Phase 4 — operator notification: when an inbound SMS arrives, forward a
# copy to this number so on-call staff get the message even when the
# BrightBase tab/laptop is closed. Unset (default) disables forwarding.
FORWARD_INBOUND_SMS_TO = os.getenv("FORWARD_INBOUND_SMS_TO") or None


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
    # Phase F: prefer a real user id. `assignee` (string) is still accepted for
    # back-compat / display; passing assignee_user_id sets both (the display
    # label is derived from the user). All-null unassigns.
    assignee: Optional[str] = None
    assignee_user_id: Optional[int] = None


class LinkClientRequest(BaseModel):
    """Link an unknown-sender conversation to a client (Twenty-style "merge into
    contact"). null client_id UNLINKS — detaches the thread from its client
    without deleting it."""
    client_id: Optional[int] = None


class MessageRead(BaseModel):
    """Mirrors the dict returned by ``msg_to_dict``."""
    id: int
    conversation_id: Optional[int] = None
    client_id: Optional[int] = None
    channel: str
    direction: str
    from_addr: Optional[str] = None
    to_addr: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    status: Optional[str] = None
    is_internal_note: bool = False
    author: Optional[str] = None
    external_id: Optional[str] = None
    created_at: Optional[str] = None


class SMSPersistenceError(BaseModel):
    """Returned when Twilio accepted the SMS but the local DB write failed.
    The FE should surface this distinct shape instead of treating it as a
    normal Message row."""
    success: bool = False
    persistence_error: str
    twilio_sid: Optional[str] = None
    status: Optional[str] = None
    to: str
    body: str


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


def _as_utc(dt):
    """Coerce a datetime to tz-aware UTC. Stored datetimes are naive UTC
    (see _utcnow), but some drivers/inputs may carry tzinfo. Normalizing here
    avoids 'can't compare offset-naive and offset-aware datetimes' TypeErrors
    in the SLA comparisons below."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _sla_state(conv: Conversation) -> str:
    """Return one of: none | met | on_track | at_risk | breached.

    The deadline is recomputed on the fly from the last inbound + the current
    BUSINESS-hours FRT policy, so tightening/loosening the SLA (or the switch to
    business-hours counting) takes effect immediately on existing conversations
    — not only on newly-arriving messages. Falls back to the stored deadline
    when there's no inbound timestamp to anchor to.
    """
    inbound = _as_utc(conv.last_inbound_at)
    if inbound is not None:
        frt = SLA_FRT_MINUTES.get(conv.priority or "normal", 480)
        deadline = _as_utc(add_business_minutes(inbound, frt))
    else:
        deadline = _as_utc(conv.sla_deadline)
    if not deadline:
        return "none"
    # If teammate already responded within deadline, SLA met.
    first_response = _as_utc(conv.first_response_at)
    if first_response and first_response <= deadline:
        return "met"
    now = datetime.now(timezone.utc)
    if now > deadline:
        return "breached"
    if (deadline - now).total_seconds() < 30 * 60:
        return "at_risk"
    return "on_track"


def _iso_utc(dt) -> Optional[str]:
    """Serialize a naive UTC datetime with an explicit ``Z`` suffix.

    Model rows are written via ``datetime.now(timezone.utc)``, so the stored value
    is the correct UTC instant but the datetime object carries no
    tzinfo. Calling ``.isoformat()`` on it produces e.g.
    ``"2026-05-14T15:30:45.123456"`` — a string with no timezone marker.
    Browsers' ``new Date(iso)`` then interpret that as **local time**, not
    UTC, so SMS timestamps render 4–5 hours off (the user's reported bug).

    Returning ``...Z`` makes the FE parse it as UTC and apply the
    operator's local-zone conversion correctly. Returns None for None
    inputs so the caller's conditional can stay identical.
    """
    if dt is None:
        return None
    return dt.isoformat() + "Z"


_UNSET = object()


def conv_to_dict(c: Conversation, *, include_client: bool = True, preview=_UNSET) -> dict:
    # `preview` can be passed in precomputed (list endpoint batches it — see
    # _last_message_previews) so we DON'T touch c.messages, which for a big
    # conversation is a large lazy/eager load. When omitted (single-conversation
    # callers), fall back to reading the last message off the relationship.
    if preview is _UNSET:
        last = c.messages[-1] if c.messages else None
        preview = (last.body or "")[:200] if last else None
    out = {
        "id": c.id,
        "client_id": c.client_id,
        "external_contact": c.external_contact,
        "channel": c.channel,
        "subject": c.subject,
        "status": c.status,
        "priority": c.priority,
        "assignee": c.assignee,
        "assignee_user_id": c.assignee_user_id,
        "tags": c.tags or [],
        "unread_count": c.unread_count,
        "last_message_at": _iso_utc(c.last_message_at),
        "last_inbound_at": _iso_utc(c.last_inbound_at),
        "last_outbound_at": _iso_utc(c.last_outbound_at),
        "first_response_at": _iso_utc(c.first_response_at),
        "sla_response_minutes": c.sla_response_minutes,
        "sla_deadline": _iso_utc(c.sla_deadline),
        "sla_state": _sla_state(c),
        "snoozed_until": _iso_utc(c.snoozed_until),
        "resolved_at": _iso_utc(c.resolved_at),
        "created_at": _iso_utc(c.created_at),
        "preview": preview,
    }
    if include_client and c.client:
        out["client"] = {
            "id": c.client.id,
            "name": c.client.name,
            "email": c.client.email,
            "phone": c.client.phone,
            "status": c.client.status,
            # Customer-360 context panel reads these to show the mailing
            # address (with a map link) and a "customer since" line while the
            # operator is mid-conversation. Cheap to include — no extra query.
            "address": c.client.address,
            "city": c.client.city,
            "state": c.client.state,
            "zip_code": c.client.zip_code,
            "created_at": _iso_utc(c.client.created_at),
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
        "created_at": _iso_utc(m.created_at),
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
    Find the conversation for this contact + channel, or create a new one.
    Preference: match by client_id, else by contact.

    Prefers the active (non-resolved) thread — but for a known client a
    RESOLVED conversation is reused, never duplicated:
    uq_conversations_client_channel allows exactly ONE row per
    (client_id, channel), so inserting a sibling is a guaranteed
    IntegrityError. (That poisoned the whole Gmail sync transaction every
    tick once a client's only conversation was resolved — the June 10
    incident.) Callers re-open a resolved thread on the next inbound via
    _apply_inbound. The insert runs in a savepoint so a lost race with a
    concurrent writer (e.g. the SMS webhook) degrades to returning the
    surviving row instead of aborting the caller's transaction.
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
        if client_id:
            conv = q.order_by(Conversation.last_message_at.desc()).first()
            if conv:
                return conv

    try:
        with db.begin_nested():
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
        return conv
    except IntegrityError:
        if q is None:
            raise
        conv = q.order_by(Conversation.last_message_at.desc()).first()
        if conv is None:
            raise
        return conv


def _apply_inbound(conv: Conversation, msg: Message):
    """Update conversation aggregates + SLA when an inbound message arrives."""
    now = msg.created_at or datetime.now(timezone.utc)
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
    conv.sla_deadline = add_business_minutes(now, frt)


def _apply_outbound(conv: Conversation, msg: Message):
    now = msg.created_at or datetime.now(timezone.utc)
    conv.last_message_at = now
    conv.last_outbound_at = now
    # First reply after an inbound? Record it for SLA
    if conv.last_inbound_at and not conv.first_response_at:
        conv.first_response_at = now


# ---------------------------------------------------------------------------
# Conversation endpoints
# ---------------------------------------------------------------------------

@router.get("/conversations", dependencies=[Depends(require_role("admin", "manager"))])
def list_conversations(
    status: Optional[str] = Query(None, description="open|pending|snoozed|resolved"),
    assignee: Optional[str] = None,
    channel: Optional[str] = None,
    unread_only: bool = False,
    sla_state: Optional[str] = Query(None, description="none|met|on_track|at_risk|breached"),
    q: Optional[str] = None,
    tag: Optional[str] = None,
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
):
    """List conversations with rich filters. Ordered newest-first by activity."""
    # Eager-load the client (many-to-one) in one batched query. We deliberately
    # do NOT selectinload(Conversation.messages): that pulled EVERY message of
    # every conversation across the wire just to build a one-line preview — for
    # an inbox with long threads that's the bulk of the page's load time. The
    # preview is fetched separately as just the last message per conversation
    # (see _last_message_previews) — one small query instead of thousands of rows.
    query = db.query(Conversation).options(
        selectinload(Conversation.client),
    )
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
    query = query.order_by(Conversation.last_message_at.desc().nulls_last()
                           if hasattr(Conversation.last_message_at.desc(), "nullslast")
                           else Conversation.last_message_at.desc())
    # `tag` and `sla_state` are derived/JSON fields filtered in Python (easier
    # than cross-dialect SQL). They must be applied BEFORE truncating to
    # `limit`, otherwise a matching row past the first `limit` ordered rows
    # would be dropped — e.g. the Overdue chip returning empty while
    # /conversations/summary still reports breached items. When such a filter
    # is active we stream the full ordered set and slice after filtering;
    # otherwise we keep the cheap DB-side LIMIT.
    if tag or sla_state:
        convs = query.all()
        if tag:
            convs = [c for c in convs if tag in (c.tags or [])]
        if sla_state:
            convs = [c for c in convs if _sla_state(c) == sla_state]
        convs = convs[:limit]
    else:
        convs = query.limit(limit).all()
    previews = _last_message_previews(db, [c.id for c in convs])
    return [conv_to_dict(c, preview=previews.get(c.id)) for c in convs]


def _last_message_previews(db: Session, conv_ids: list[int]) -> dict:
    """Return {conversation_id: preview_text} — just the newest message body of
    each conversation, truncated. One grouped query + one fetch, instead of
    loading every message of every conversation. Uses MAX(id) as "newest":
    message ids are monotonic with insert order, so for a live inbox that's the
    same row as the latest created_at, without the tie-handling a created_at
    grouping needs."""
    if not conv_ids:
        return {}
    # Newest message id per conversation (bounded by the page limit, ≤500 rows).
    max_ids = [mid for (mid,) in
               db.query(func.max(Message.id))
                 .filter(Message.conversation_id.in_(conv_ids))
                 .group_by(Message.conversation_id).all()]
    if not max_ids:
        return {}
    rows = (db.query(Message.conversation_id, Message.body)
              .filter(Message.id.in_(max_ids)).all())
    return {cid: (body or "")[:200] for cid, body in rows}


@router.get("/conversations/summary", dependencies=[Depends(require_role("admin", "manager"))])
def conversations_summary(db: Session = Depends(get_db)):
    """Quick counts for inbox filter badges.

    Returns global totals (back-compat for the unread chime poller) PLUS a
    ``by_channel`` breakdown so the inbox can show per-channel counts and keep
    the folder/chip badges in sync with whichever channel tab is selected.
    Computed in one pass over the (small) conversation set — derived fields
    like ``breached`` aren't columns, so a single Python scan is simplest and
    avoids a fan-out of COUNT queries.
    """
    def _blank():
        return {"open": 0, "pending": 0, "snoozed": 0, "resolved": 0,
                "unassigned": 0, "unread": 0, "breached": 0, "unread_messages": 0}

    total = _blank()
    by_channel: dict[str, dict] = {}

    for c in db.query(Conversation).all():
        ch = c.channel or "other"
        for b in (total, by_channel.setdefault(ch, _blank())):
            if c.status in ("open", "pending", "snoozed", "resolved"):
                b[c.status] += 1
            if c.status == "open" and c.assignee is None:
                b["unassigned"] += 1
            if (c.unread_count or 0) > 0:
                b["unread"] += 1
            b["unread_messages"] += int(c.unread_count or 0)
            if c.status == "open" and _sla_state(c) == "breached":
                b["breached"] += 1

    total["by_channel"] = by_channel

    # Crew chat rides the same poller: unread cleaner→office messages (read
    # when the office opens the thread via GET /api/crew/messages/{user_id}).
    # Two scalar queries against the tiny crew_messages table — keeps the
    # sidebar/bottom-nav Messages badge honest about BOTH inboxes without a
    # second poll loop.
    from database.models import CrewMessage
    crew_q = db.query(CrewMessage).filter(CrewMessage.sender == "cleaner",
                                          CrewMessage.read_at.is_(None))
    total["crew_unread_messages"] = crew_q.count()
    total["crew_unread_threads"] = (
        crew_q.with_entities(func.count(func.distinct(CrewMessage.user_id))).scalar() or 0)
    return total


@router.get("/conversations/{conv_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_conversation(conv_id: int, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    return {
        **conv_to_dict(conv),
        "messages": [msg_to_dict(m) for m in conv.messages],
    }


@router.post("/conversations/{conv_id}/messages", dependencies=[Depends(require_role("admin", "manager"))])
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


@router.post("/conversations/{conv_id}/notes", dependencies=[Depends(require_role("admin", "manager"))])
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


@router.post("/conversations/{conv_id}/assign", dependencies=[Depends(require_role("admin", "manager"))])
def assign_conversation(conv_id: int, data: AssignRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.assignee_user_id is not None:
        # Real user assignment (preferred). Resolve the user, set the FK, and
        # derive the display label from their name so `assignee` stays populated
        # for old readers and list rendering.
        from database.models import User
        user = db.query(User).filter(User.id == data.assignee_user_id).first()
        if not user:
            raise HTTPException(404, "User not found")
        conv.assignee_user_id = user.id
        conv.assignee = user.full_name or user.email
    elif data.assignee:
        # Legacy string-only assignment (no id known) — kept for back-compat.
        conv.assignee = data.assignee
        conv.assignee_user_id = None
    else:
        # Unassign.
        conv.assignee = None
        conv.assignee_user_id = None
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.get("/assignees", dependencies=[Depends(require_role("admin", "manager"))])
def list_assignees(db: Session = Depends(get_db)):
    """Staff who can own a conversation — powers the inbox assignee picker.
    Returns [{id, name, email}] of active, non-client users. Manager-accessible
    (the admin-only /auth/users list is for the Users admin screen)."""
    from database.models import User
    rows = (db.query(User)
            .filter(User.role != "client", User.status != "disabled")
            .all())
    out = [{"id": u.id, "name": u.full_name or u.email, "email": u.email} for u in rows]
    out.sort(key=lambda r: (r["name"] or "").lower())
    return out


@router.post("/conversations/{conv_id}/link-client", dependencies=[Depends(require_role("admin", "manager"))])
def link_conversation_client(conv_id: int, data: LinkClientRequest, db: Session = Depends(get_db)):
    """Attach (or detach) a conversation to a client — the Twenty-style
    "link to contact" merge the inbox was missing. Unknown-sender threads come in
    with client_id NULL (kept, not dropped, by design) and stay unlinked until
    someone identifies who it is; this is that action.

    Cascades to the conversation's messages so the client's unified comms view
    (`GET /client/{id}`, which unions by client_id) picks the whole thread up —
    otherwise linking the header alone would leave the messages orphaned.
    Passing client_id=null unlinks. Returns the updated conversation."""
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.client_id is not None:
        client = db.query(Client).filter(Client.id == data.client_id).first()
        if not client:
            raise HTTPException(404, "Client not found")
    prev_client_id = conv.client_id
    conv.client_id = data.client_id
    # Cascade to messages so the whole thread moves with the header. Only touch
    # messages that were unlinked or tied to the conversation's PREVIOUS client —
    # a message explicitly linked to some other client keeps its own link.
    for m in (conv.messages or []):
        if m.client_id in (None, prev_client_id):
            m.client_id = data.client_id
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/status", dependencies=[Depends(require_role("admin", "manager"))])
def set_status(conv_id: int, data: StatusRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.status not in ("open", "pending", "snoozed", "resolved"):
        raise HTTPException(400, "Invalid status")
    conv.status = data.status
    if data.status == "resolved":
        conv.resolved_at = datetime.now(timezone.utc)
    elif data.status == "snoozed":
        conv.snoozed_until = data.snoozed_until
    elif data.status == "open":
        conv.resolved_at = None
        conv.snoozed_until = None
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/priority", dependencies=[Depends(require_role("admin", "manager"))])
def set_priority(conv_id: int, data: PriorityRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.priority not in ("low", "normal", "high", "urgent"):
        raise HTTPException(400, "Invalid priority")
    conv.priority = data.priority
    # Recompute SLA deadline relative to the unresponded inbound
    if conv.last_inbound_at and not conv.first_response_at:
        frt = SLA_FRT_MINUTES.get(data.priority, 480)
        conv.sla_response_minutes = frt
        conv.sla_deadline = add_business_minutes(conv.last_inbound_at, frt)
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/tags", dependencies=[Depends(require_role("admin", "manager"))])
def set_tags(conv_id: int, data: TagsRequest, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    conv.tags = data.tags
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/read", dependencies=[Depends(require_role("admin", "manager"))])
def mark_read(conv_id: int, db: Session = Depends(get_db)):
    conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    conv.unread_count = 0
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.get("/client/{client_id}", dependencies=[Depends(require_role("admin", "manager"))])
def client_comms(client_id: int, db: Session = Depends(get_db)):
    """Unified, contact-linked communications for one client (Twenty-style).

    Returns every email + SMS message linked to the client by client_id OR by a
    matching contact (their email, or any of their phone numbers normalized to
    E.164) — so messages that were never explicitly tied to the client_id still
    surface, the same way calendar events link by email. The frontend splits the
    flat ``messages`` list by channel for the SMS and Email tabs."""
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(404, "Client not found")

    # Build the set of contact identifiers this client owns.
    contacts: set[str] = set()
    if client.email:
        contacts.add(client.email.strip().lower())
    phones = [client.phone] if client.phone else []
    for cp in db.query(ContactPhone).filter(ContactPhone.client_id == client_id).all():
        if cp.phone:
            phones.append(cp.phone)
    for p in phones:
        n = _normalize_contact(p)
        if n:
            contacts.add(n.lower())

    conds = [Conversation.client_id == client_id]
    if contacts:
        conds.append(func.lower(Conversation.external_contact).in_(list(contacts)))
    convs = (
        db.query(Conversation)
        .filter(or_(*conds))
        .order_by(Conversation.last_message_at.desc().nulls_last())
        .all()
    )

    messages: list[dict] = []
    sms_count = email_count = 0
    for c in convs:
        for m in c.messages:
            if m.is_internal_note:
                continue
            messages.append(msg_to_dict(m))
        if c.channel == "sms":
            sms_count += 1
        elif c.channel == "email":
            email_count += 1
    messages.sort(key=lambda m: m.get("created_at") or "")

    return {
        "messages": messages,
        "counts": {"sms": sms_count, "email": email_count, "total": len(messages)},
        "client_email": client.email,
        "client_phone": client.phone,
    }


@router.post("/sms", response_model=Union[MessageRead, SMSPersistenceError], dependencies=[Depends(require_role("admin", "manager"))])
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

    # Twilio accepted the message — from here on, persistence failures must
    # NOT make the caller think the SMS wasn't sent. Roll back the DB session
    # on error and return a synthesized success payload instead of a 500.
    try:
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
    except Exception as e:
        logger.exception(f"[comms] SMS sent (sid={result.get('sid')}) but persistence failed: {e}")
        try:
            db.rollback()
        except Exception:
            pass
        # Twilio accepted the message but we failed to record it locally.
        # Surface a distinct envelope so the FE can flag the partial-success
        # state instead of treating it as a normal Message row.
        return {
            "success": False,
            "persistence_error": str(e),
            "twilio_sid": result.get("sid"),
            "status": result.get("status", "sent"),
            "to": to_normalized,
            "body": data.body,
        }


def _last_inbound_message_id(db: Session, conv_id: int) -> Optional[str]:
    """The RFC Message-ID of the most recent inbound email in a conversation
    (stored on Message.external_id by the Gmail/IMAP ingest). Used as In-Reply-To
    so a send-through-Gmail reply threads into the existing Gmail conversation."""
    m = (db.query(Message)
         .filter(Message.conversation_id == conv_id, Message.channel == "email",
                 Message.direction == "inbound", Message.external_id.isnot(None))
         .order_by(Message.id.desc()).first())
    return m.external_id if m else None


def _send_email_via_gmail_or_smtp(db: Session, user, *, to, subject, body, conv):
    """Prefer sending THROUGH the sender's connected Gmail (so it lands in their
    Sent and threads back into the Gmail conversation via In-Reply-To); fall back
    to SMTP when they have no send-capable Google account or the API call fails.

    Returns (from_addr, external_id): the address it went out as and the RFC
    Message-ID to record (None for SMTP). Raises only when BOTH paths fail."""
    account = None
    if user is not None:
        from database.models import UserGoogleAccount
        account = (db.query(UserGoogleAccount)
                   .filter(UserGoogleAccount.user_id == user.id,
                           UserGoogleAccount.status == "connected")
                   .first())
    if account is not None and "gmail.send" in " ".join(account.scopes or []):
        try:
            from integrations.google_accounts import account_credentials
            from integrations import gmail_api
            in_reply_to = _last_inbound_message_id(db, conv.id) if conv else None
            res = gmail_api.send_message(
                account_credentials(db, account),
                to=to, subject=subject, html_body=body,
                from_addr=account.email, in_reply_to=in_reply_to,
            )
            return account.email, res.get("message_id")
        except Exception as e:
            logger.warning("[comms] Gmail send failed for %s, falling back to SMTP: %s",
                           getattr(account, "email", "?"), e)
    # SMTP fallback (also the path when no Google account is connected).
    _send_email(to=to, subject=subject, html_body=body, text_body=body)
    return os.getenv("SMTP_FROM", os.getenv("SMTP_USER", "")), None


@router.post("/email", response_model=MessageRead)
def send_email_message(data: EmailRequest, db: Session = Depends(get_db),
                       current_user=Depends(require_role("admin", "manager"))):
    """Send an email — through the sender's connected Gmail when available (real
    Sent + threads back), else SMTP. Attaches to a conversation automatically."""
    conv = find_or_create_conversation(
        db, channel="email",
        client_id=data.client_id,
        external_contact=data.to,
        subject=data.subject,
    )
    try:
        from_addr, external_id = _send_email_via_gmail_or_smtp(
            db, current_user, to=data.to, subject=data.subject, body=data.body, conv=conv)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Email error: {e}")

    msg = Message(
        client_id=data.client_id,
        conversation_id=conv.id,
        channel="email",
        direction="outbound",
        from_addr=from_addr,
        to_addr=data.to,
        subject=data.subject,
        body=data.body,
        status="sent",
        external_id=external_id,
    )
    db.add(msg)
    db.flush()
    _apply_outbound(conv, msg)
    db.commit()
    db.refresh(msg)
    return msg_to_dict(msg)


@router.post("/twilio/webhook")  # PUBLIC: Twilio posts here; signature is validated inside the handler (BB-SEC-06)
async def twilio_inbound(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Receive inbound SMS from Twilio webhook. Groups into a conversation."""
    form = await request.form()

    # BB-SEC-06: validate X-Twilio-Signature. Without this anyone can POST a
    # forged payload to /api/comms/twilio/webhook with arbitrary From/Body
    # and inject SMS records, optionally with a real client's phone — which
    # also triggers FORWARD_INBOUND_SMS_TO outbound SMS, turning Twilio
    # into a free open relay against the on-call line.
    auth_token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
    if not auth_token:
        # Fail CLOSED, not open (July-2026 audit finding). TWILIO_AUTH_TOKEN
        # is already required for outbound SMS (integrations/twilio_client.py)
        # — every quote/job-reminder/owner-alert send needs it — so if it's
        # unset in production, outbound SMS is already broken and this
        # webhook has no legitimate traffic to serve anyway. The old
        # behavior (log a warning, accept the request) let anyone POST a
        # forged payload with an arbitrary From/Body, inject SMS records
        # under a real client's number, and trigger FORWARD_INBOUND_SMS_TO
        # — turning Twilio into a free open relay against the on-call line.
        logger.error(
            "[twilio] rejecting webhook — TWILIO_AUTH_TOKEN not set, cannot "
            "validate signature. Set TWILIO_AUTH_TOKEN to accept inbound SMS."
        )
        raise HTTPException(status_code=403, detail="SMS webhook not configured")

    from twilio.request_validator import RequestValidator
    validator = RequestValidator(auth_token)
    signature = request.headers.get("X-Twilio-Signature", "")
    # Twilio signs the full public URL it POSTed to. Behind Railway's
    # proxy, request.url may show the internal scheme/host; prefer the
    # X-Forwarded-* headers when present so the signed string matches
    # what Twilio actually used.
    fwd_proto = request.headers.get("X-Forwarded-Proto")
    fwd_host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host")
    if fwd_proto and fwd_host:
        url = f"{fwd_proto}://{fwd_host}{request.url.path}"
        if request.url.query:
            url = f"{url}?{request.url.query}"
    else:
        url = str(request.url)
    params = {k: v for k, v in form.items()}
    if not validator.validate(url, params, signature):
        logger.warning(
            f"[twilio] rejected webhook with bad signature from {request.client.host if request.client else 'unknown'}"
        )
        raise HTTPException(status_code=403, detail="Invalid Twilio signature")

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
            # Phase 5 — thread per client. The first inbound from a new
            # number that turns out to belong to an existing client may
            # have created a placeholder Client + Conversation while the
            # match was still uncertain. Now that we've linked the phone,
            # absorb that placeholder + merge any duplicate threads so
            # the operator sees one inbox row per client, not per number.
            from modules.clients.router import _link_and_merge_conversations
            try:
                report = _link_and_merge_conversations(db, client.id, from_number_normalized)
                if any(report.values()):
                    logger.info(f"[twilio] Auto-merged threads for client #{client.id}: {report}")
            except Exception as e:
                logger.warning(f"[twilio] Auto-merge failed (non-fatal): {e}")
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

    # Web-push the staff about the new inbound message (best-effort, no-op
    # unless VAPID is configured). Deep-links to the Messages inbox; tagged per
    # conversation so a burst from one sender collapses to a single alert.
    try:
        from services.push_service import notify_staff
        who = (client.name if client else None) or from_number_normalized or "New message"
        snippet = (body or "").strip()
        if len(snippet) > 140:
            snippet = snippet[:140] + "…"
        notify_staff(
            db,
            f"💬 {who}",
            snippet or "New message",
            url="/messages",
            tag=f"conv-{conv.id}",
            org_id=getattr(conv, "org_id", None),
            category="messages",
        )
    except Exception:
        pass

    # Phase 4 — operator forward. After persisting, fan out a copy to the
    # configured personal number so on-call staff get the message even when
    # BrightBase isn't open. Failures here MUST NOT break the webhook reply
    # (Twilio retries on non-2xx, which would re-trigger a duplicate
    # inbound and we already deduped above).
    _forward_inbound_sms_if_configured(
        from_number=from_number_normalized,
        client_name=client.name if client else None,
        body=body,
    )

    # Mirror a copy into the Twenty CRM inbox. Queued rather than awaited so a
    # slow or unreachable CRM can neither delay this webhook's reply nor make
    # Twilio retry (a retry would arrive as a duplicate inbound).
    background_tasks.add_task(_mirror_inbound_sms_to_twenty, dict(params))

    return Response(
        content="<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>",
        media_type="text/xml",
    )


def _forward_inbound_sms_if_configured(*, from_number: str, client_name: Optional[str], body: str) -> None:
    """Forward a copy of an inbound SMS to FORWARD_INBOUND_SMS_TO."""
    target = FORWARD_INBOUND_SMS_TO
    if not target:
        return

    target_normalized = _normalize_contact(target)
    # Loop prevention: never forward a message that originated from the
    # forwarding number itself (e.g. on-call staff replying via SMS gateway).
    if from_number and from_number == target_normalized:
        logger.info("[twilio] Skipping forward: inbound is from the forward target")
        return

    label = client_name or from_number or "unknown"
    snippet = (body or "").strip()
    if len(snippet) > 1200:
        snippet = snippet[:1200] + "…"
    forward_body = f"BrightBase SMS from {label}:\n{snippet}"

    try:
        send_sms(to=target_normalized, body=forward_body)
        logger.info(f"[twilio] Forwarded inbound SMS from {from_number} to {target_normalized}")
    except Exception as e:
        # Don't surface to caller — failed forward shouldn't make Twilio retry.
        logger.warning(f"[twilio] Forward to {target_normalized} failed: {e}")


def _mirror_inbound_sms_to_twenty(params: dict) -> None:
    """Push a copy of an inbound SMS to the Twenty CRM.

    Twilio posts an inbound message to exactly one URL, and that URL is this
    handler. So rather than repointing Twilio - which would take inbound SMS
    away from BrightBase entirely - we forward a copy onward.

    The forwarded request cannot carry a usable X-Twilio-Signature: Twilio
    signed the URL it actually called, which is ours, not Twenty's. It is
    authenticated with a shared secret instead, which is sound because the real
    signature was already verified above before anything was persisted.

    The original Twilio parameters are passed through untouched so the CRM
    dedupes on the same MessageSid we do.

    Inert unless both TWENTY_SMS_WEBHOOK_URL and TWENTY_SMS_WEBHOOK_SECRET are
    set. Never raises - it runs after the response has gone out.
    """
    url = os.getenv("TWENTY_SMS_WEBHOOK_URL", "").strip()
    secret = os.getenv("TWENTY_SMS_WEBHOOK_SECRET", "").strip()

    if not url or not secret:
        return

    try:
        import httpx

        resp = httpx.post(
            url,
            json=params,
            headers={"x-webhook-secret": secret},
            timeout=10.0,
        )
        if resp.status_code >= 400:
            logger.warning(
                f"[twenty] mirror rejected inbound SMS "
                f"({resp.status_code}): {resp.text[:200]}"
            )
        else:
            logger.info(
                f"[twenty] mirrored inbound SMS {params.get('MessageSid') or '?'}"
            )
    except Exception as e:
        # A failed mirror must never surface to Twilio.
        logger.warning(f"[twenty] mirror of inbound SMS failed: {e}")
