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

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from database.db import get_db
from modules.auth.router import (require_role, current_org_id,  # noqa: F401
                                 current_org_id_without_rls_guc, _default_org_id)
from database.models import Message, Conversation, Client, LeadIntake, ContactPhone
from services.sms_send import send_and_log
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

# The channels we can actually send OUT on. Stated once here because two places
# depend on it and they used to disagree by omission: send_reply raised
# "Channel X not sendable" from the tail of an if/elif, and nothing else knew
# the rule at all.
#
# It matters more since threads became person-keyed (alembic 131). A thread's
# `channel` is now its DEFAULT REPLY CHANNEL rather than its identity, and
# _apply_inbound keeps it pointed at however the customer last reached us — so
# without this guard, one voicemail would set conv.channel = "voice" and every
# reply on that thread would 400 until someone edited the database. Voice is
# receive-only: a transcript arrives, the reply goes back by text or email.
SENDABLE_CHANNELS = ("sms", "email")

# Phase 4 — operator notification: when an inbound SMS arrives, forward a
# copy to this number so on-call staff get the message even when the
# BrightBase tab/laptop is closed. Unset (default) disables forwarding.
FORWARD_INBOUND_SMS_TO = os.getenv("FORWARD_INBOUND_SMS_TO") or None

# ---------------------------------------------------------------------------
# Voice config (BB-VOICE-01)
#
# The number's Voice webhook pointed at /api/twilio/voice for months — a route
# that has never existed in this app. Twilio got a 401 from the auth
# middleware, had no TwiML to run, and dropped the call: every inbound call in
# the Twilio log between 2026-04-29 and 2026-09-14 shows 0 sec with error
# 11200. Nobody could reach the business by phone. These endpoints are the
# route that URL should have been pointing at all along.
#
# Ring-through target defaults to the SMS forward number so voice and SMS reach
# the same on-call phone without a second setting to keep in sync. Unset (both
# unset) means callers go straight to voicemail rather than hearing nothing.
VOICE_RING_SECONDS = int(os.getenv("VOICE_RING_SECONDS", "20"))

# Twilio's built-in transcription only covers recordings up to 2 minutes, so
# the cap is 120 by default — a longer max would silently produce voicemails
# that never get a transcript, which is the whole point of this feature.
VOICE_MAX_RECORDING_SECONDS = int(os.getenv("VOICE_MAX_RECORDING_SECONDS", "120"))

VOICE_GREETING = os.getenv("VOICE_GREETING") or (
    "Thanks for calling. We can't pick up right now. Please leave your name, "
    "your number, and what you need after the tone, and we'll call you back."
)

# Optional Twilio <Say> voice (e.g. "Polly.Joanna"). Left unset so Twilio uses
# its default — naming a voice the account can't synthesize is a TwiML error,
# and a TwiML error here drops the call, which is the failure this whole
# module exists to fix.
VOICE_TTS_VOICE = os.getenv("VOICE_TTS_VOICE") or None


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
    # @mentions: user ids the composer tagged in this note. The office writes an
    # internal note like "@Sarah can you cover this?"; each tagged teammate
    # (office, crew, or sub) is notified through their normal channel (push,
    # SMS fallback) and can mute the "mentions" category. The note itself stays
    # internal — the customer never sees it.
    mentions: Optional[List[int]] = None


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
    org_id: Optional[int] = None,
) -> Conversation:
    """
    Find this person's conversation, or create one.

    THREAD IDENTITY IS THE PERSON, NOT THE PERSON-AND-CHANNEL (Tier 4a,
    alembic 131). A known client has ONE thread: if they texted last week and
    email today, both land in it, and the office reads one conversation
    instead of half of one in each of two. `channel` is a property of each
    MESSAGE (messages.channel, already written on every row); on the thread it
    now means only "the channel to reply on by default".

    An UNLINKED contact is still channel-scoped, deliberately. A phone number
    and an email address are two different `external_contact` values with no
    way to know they are the same human, so unifying them is not something
    this function can do honestly — it would just be guessing. Linking the
    contact to a client is what unifies them, and _link_and_merge_conversations
    (modules/clients/router.py) already does that merge.

    Prefers the active (non-resolved) thread, and for a known client reuses a
    RESOLVED one rather than opening a second. That was originally forced by
    uq_conversations_client_channel — inserting a sibling was a guaranteed
    IntegrityError, which poisoned the whole Gmail sync transaction every tick
    once a client's only conversation was resolved (the June 10 incident).
    Alembic 131 drops that index, so the constraint no longer compels it; the
    behaviour stays because it was always the right answer. A customer
    replying to a closed thread should re-open it, which _apply_inbound does,
    not start a parallel one. The June 10 guard in
    tests/test_conversation_get_or_create.py still holds it.

    The insert still runs in a savepoint. Without the unique index an
    IntegrityError is far less likely, but the savepoint costs nothing and a
    lost race with a concurrent writer (e.g. the SMS webhook) still degrades
    to returning the surviving row rather than aborting the caller's
    transaction.

    org_id (BB-MT-01): stamped on a newly-created Conversation only — this was
    never set anywhere in the codebase, so every conversation's org_id was
    NULL and surfaced on every workspace via the NULL-tolerant _org() filter.
    Pass the caller's org_id (or the anchor client's) when known; a caller
    with no resolvable org (e.g. the shared legacy Gmail inbox) may omit it.
    """
    external_contact = _normalize_contact(external_contact)
    if client_id:
        # Person-keyed. No channel filter: this is the whole change.
        q = db.query(Conversation).filter(Conversation.client_id == client_id)
    elif external_contact:
        # Still channel-scoped — see the docstring.
        q = db.query(Conversation).filter(
            Conversation.external_contact == external_contact,
            Conversation.channel == channel,
        )
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
                org_id=org_id,
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
    # Point the thread's default reply channel at however the customer last
    # reached us, so answering a text does not email them (threads hold mixed
    # channels now — alembic 131). Only ever a channel we can send on: a
    # voicemail must not leave the thread unanswerable, since send_reply 400s
    # on anything outside SENDABLE_CHANNELS. A voice-only thread keeps
    # whatever channel it was created with, which is what the operator sees
    # and can still reply on.
    if msg.channel in SENDABLE_CHANNELS:
        conv.channel = msg.channel
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
#
# BB-SEC-22 (MT-2) — every endpoint below is org-scoped. Read this before
# adding another one; the gap it closes was not visible by inspection.
#
# What it was: all thirteen authenticated routes here resolved their row with
# `db.query(Conversation).filter(Conversation.id == conv_id)` and no org
# filter, carrying only `require_role("admin", "manager")`. Two of them
# (`/conversations`, `/conversations/summary`) queried the table globally.
#
# Why RLS did not catch it: `conversations` IS in TENANT_TABLES, but the MT-3
# policy reads the `app.current_org_id` GUC, and that GUC is set ONLY by the
# `current_org_id` dependency (modules/auth/router.py). None of these routes
# depended on it, so the GUC was unset — and the policy's USING clause ends in
# `OR current_setting('app.current_org_id', true) IS NULL`, i.e. it fails OPEN.
# A role check plus an RLS-registered table read as two yeses in review while
# the actual isolation was zero.
#
# What it allowed: any authenticated admin/manager in ANY workspace could read
# another workspace's entire thread by id, and POST a reply on it — `send_reply`
# resolves `to_addr` server-side from that org's client, so the SMS or email
# reached their customer, billed to this account's Twilio. It could also
# reassign, re-tag, resolve and mark-read their threads, link one to a client,
# enumerate every workspace's staff via `/assignees`, and read global unread
# counts.
#
# The rule: the org filter belongs IN the query, never in an `if` after it — a
# row that isn't the caller's must never load, and "not found" and "not yours"
# must both be 404 so the response cannot be used to probe which ids exist.
# Strict `== org_id` is correct for `conversations`/`messages`/`clients`/
# `contact_phones`, `users` and `crew_messages` — ALL of them NULL-tolerant, via
# the `_org()` helper below. Covered by tests/test_tenancy_scope_comms.py.
#
# BB-SEC-24 — why NULL-tolerant, and why this is not slack.
#
# The first cut of BB-SEC-22 used a strict `org_id == org_id` on conversations,
# messages, clients and contact_phones, reasoning that migration 027's backfill
# (`UPDATE {table} SET org_id = 1 WHERE org_id IS NULL`) meant no NULL-org rows
# could exist. That reasoning was wrong, and it shipped. A census against
# PRODUCTION Postgres — the one database/rls.py says had never been run — found:
#
#     conversations        85 NULL of    126 rows   (67%)
#     messages            517 NULL of  1,304 rows   (40%)
#     activities          648 NULL of  1,006 rows
#     integration_events  1,540 NULL of 1,585 rows
#     schedule_events    11,205 NULL of 11,448 rows
#
# So 027's backfill did not hold for rows created after it: some write path
# leaves org_id NULL (see BB-SEC-24 follow-up — the inserts are not all in app
# code we can grep). The strict filter therefore hid two thirds of the office
# inbox the moment it deployed.
#
# A NULL org_id means "the default workspace", exactly as modules/ai/router.py's
# `_org()` docstring and database/rls.py both state. Matching it is the SAME
# semantics every other module uses (`or_(X.org_id == oid, X.org_id.is_(None))`
# at 20+ sites in scheduling/, crew/, payroll/, dispatch/) — this module was the
# odd one out, not the strict one.
#
# Do NOT re-tighten this to `== org_id` until a migration has actually
# backfilled these tables AND a fresh census returns zero. Tightening it is a
# data-hiding outage, not a hardening.
# ---------------------------------------------------------------------------


_DEFAULT_ORG_CACHE: Optional[int] = None


def _default_org(db) -> Optional[int]:
    """The single v1 workspace id. Cached: it is one stable row."""
    global _DEFAULT_ORG_CACHE
    if _DEFAULT_ORG_CACHE is None:
        _DEFAULT_ORG_CACHE = _default_org_id(db)
    return _DEFAULT_ORG_CACHE


def _org(model, org_id, db):
    """MT-2 tenant scope for `model`.

    A legacy NULL org_id means "the DEFAULT workspace" — not "every
    workspace". So the NULL arm is admitted ONLY when the caller IS the default
    workspace; any other tenant gets strict equality and can never see an
    orphan row. (Codex review on #1083 caught the first cut of this, which
    admitted NULL for everyone and would have been a real leak the moment a
    second workspace existed.)

    One helper rather than twenty inline predicates, so the invariant and its
    reason live in exactly one place.
    """
    if org_id is not None and org_id == _default_org(db):
        return or_(model.org_id == org_id, model.org_id.is_(None))
    return model.org_id == org_id


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
    org_id: int = Depends(current_org_id_without_rls_guc),
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
    ).filter(_org(Conversation, org_id, db))  # BB-SEC-22 / BB-SEC-24
    if status:
        query = query.filter(Conversation.status == status)
    if assignee == "unassigned":
        query = query.filter(Conversation.assignee.is_(None))
    elif assignee:
        query = query.filter(Conversation.assignee == assignee)
    if channel:
        # "Threads CONTAINING a message on this channel", not "threads whose
        # channel is this". Since alembic 131 a thread holds every channel the
        # person used, and `Conversation.channel` means only "reply here by
        # default" — so the old equality filter would have quietly broken the
        # inbox's own tabs: a voicemail now joins the person's existing SMS
        # thread, whose channel stays "sms", and the Voicemail tab would have
        # matched nothing at all.
        #
        # EXISTS rather than a join, so a thread with twenty emails appears
        # once. Backed by ix_messages_conversation_id_channel (alembic 131);
        # unindexed this would scan `messages` once per conversation row.
        query = query.filter(Conversation.messages.any(Message.channel == channel))
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
def conversations_summary(db: Session = Depends(get_db),
                          org_id: int = Depends(current_org_id_without_rls_guc)):
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

    for c in db.query(Conversation).filter(_org(Conversation, org_id, db)).all():  # BB-SEC-22 / BB-SEC-24
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
    # BB-SEC-22: was a global count — this badge reported every workspace's
    # unread crew messages. The NULL arm matches the thread list this badge
    # points at (modules/crew/router.py office_crew_threads), so the count and
    # the list can't disagree.
    crew_q = db.query(CrewMessage).filter(CrewMessage.sender == "cleaner",
                                          CrewMessage.read_at.is_(None),
                                          _org(CrewMessage, org_id, db))
    total["crew_unread_messages"] = crew_q.count()
    total["crew_unread_threads"] = (
        crew_q.with_entities(func.count(func.distinct(CrewMessage.user_id))).scalar() or 0)
    return total


@router.get("/conversations/{conv_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_conversation(conv_id: int, db: Session = Depends(get_db),
                     org_id: int = Depends(current_org_id_without_rls_guc)):
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
    if not conv:
        raise HTTPException(404, "Conversation not found")
    return {
        **conv_to_dict(conv),
        "messages": [msg_to_dict(m) for m in conv.messages],
    }


@router.post("/conversations/{conv_id}/messages", dependencies=[Depends(require_role("admin", "manager"))])
def send_reply(conv_id: int, data: SendReplyRequest, db: Session = Depends(get_db),
               org_id: int = Depends(current_org_id_without_rls_guc)):
    """Send an outbound message on this conversation via its channel."""
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
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
            result = send_and_log(to=to_addr, body=data.body, action="comms",
                                  entity_type="conversation", entity_id=conv.id,
                                  org_id=getattr(conv, "org_id", None))
            from_addr = os.getenv("TWILIO_PHONE_NUMBER", "")
            status = result.get("status", "sent")
            external_id = result.get("sid")
        elif conv.channel == "email":
            subject = data.subject or conv.subject or "Re: your message"
            _send_email(to=to_addr, subject=subject, html_body=data.body, text_body=data.body)
            from_addr = os.getenv("SMTP_FROM", os.getenv("SMTP_USER", ""))
        else:
            # SENDABLE_CHANNELS is the single statement of this rule;
            # _apply_inbound reads it too so a thread can never be parked on a
            # receive-only channel in the first place.
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
        org_id=conv.org_id,  # BB-MT-01: inherit the conversation's org
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
def add_internal_note(conv_id: int, data: InternalNoteRequest, db: Session = Depends(get_db),
                      org_id: int = Depends(current_org_id_without_rls_guc)):
    """Attach an internal-only note to this conversation."""
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
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
        org_id=conv.org_id,  # BB-MT-01: inherit the conversation's org
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # @mentions: notify each tagged teammate (best-effort, never blocks the note).
    # push first, SMS fallback, honouring the "mentions" mute — same one-person
    # policy the crew marketplace uses. Only real, active, non-client users; the
    # author is skipped so you don't ping yourself. The note body stays internal;
    # the notification carries just the author + a short excerpt for context.
    mention_ids = [int(m) for m in (data.mentions or []) if m is not None]
    if mention_ids:
        try:
            from database.models import User
            from services.crew_notify import notify_user_or_sms
            targets = (db.query(User)
                       .filter(User.id.in_(mention_ids),
                               User.role != "client",
                               User.status != "disabled")
                       .all())
            author_name = "A teammate"
            if data.author:
                if str(data.author).isdigit():
                    au = db.query(User).filter(User.id == int(data.author)).first()
                    if au:
                        author_name = au.full_name or au.email or author_name
                else:
                    author_name = str(data.author)  # already a display name / username
            client = db.query(Client).filter(Client.id == conv.client_id).first() if conv.client_id else None
            who = (client.name.split()[0] if client and client.name else None)
            excerpt = (data.body or "").strip().replace("\n", " ")
            if len(excerpt) > 120:
                excerpt = excerpt[:117] + "…"
            title = f"{author_name} mentioned you"
            body = f"{author_name}{f' · {who}' if who else ''}: {excerpt}"
            url = f"/comms?conversation={conv.id}"
            for u in targets:
                if data.author and str(u.id) == str(data.author):
                    continue  # don't notify yourself
                try:
                    notify_user_or_sms(u.id, title, body, category="mentions",
                                       url=url, tag=f"mention:{msg.id}")
                except Exception:
                    logger.warning("[comms] mention notify failed for user %s", u.id, exc_info=True)
        except Exception:
            logger.warning("[comms] mention notify block failed", exc_info=True)

    return msg_to_dict(msg)


@router.post("/conversations/{conv_id}/assign", dependencies=[Depends(require_role("admin", "manager"))])
def assign_conversation(conv_id: int, data: AssignRequest, db: Session = Depends(get_db),
                       org_id: int = Depends(current_org_id_without_rls_guc)):
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.assignee_user_id is not None:
        # Real user assignment (preferred). Resolve the user, set the FK, and
        # derive the display label from their name so `assignee` stays populated
        # for old readers and list rendering.
        from database.models import User
        # BB-SEC-22: `users` is deliberately NOT an RLS tenant table (see the
        # long note in database/rls.py), so this filter is the ONLY thing
        # stopping a conversation being assigned to a user in another
        # workspace. The NULL arm is required, not slack: `users` was excluded
        # from migration 027's org_id backfill and from 049's (which never ran
        # against production), so NULL-org staff rows are live and mean "the
        # default workspace". Strict equality here would 404 on assigning a
        # legacy admin — the same regression rls.py's note describes for
        # rosters, payroll lookups and dispatch.
        user = (db.query(User)
                .filter(User.id == data.assignee_user_id,
                        _org(User, org_id, db))
                .first())
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
def list_assignees(db: Session = Depends(get_db),
                   org_id: int = Depends(current_org_id_without_rls_guc)):
    """Staff who can own a conversation — powers the inbox assignee picker.
    Returns [{id, name, email}] of active, non-client users. Manager-accessible
    (the admin-only /auth/users list is for the Users admin screen)."""
    from database.models import User
    # BB-SEC-22: was unscoped — the picker listed every workspace's staff by
    # name, email and role. NULL-org arm per rls.py: `users` has no RLS policy
    # and no completed org_id backfill, so legacy staff must stay pickable.
    rows = (db.query(User)
            .filter(User.role != "client", User.status != "disabled",
                    _org(User, org_id, db))
            .all())
    out = [{"id": u.id, "name": u.full_name or u.email, "email": u.email, "role": u.role} for u in rows]
    out.sort(key=lambda r: (r["name"] or "").lower())
    return out


@router.post("/conversations/{conv_id}/link-client", dependencies=[Depends(require_role("admin", "manager"))])
def link_conversation_client(conv_id: int, data: LinkClientRequest,
                            db: Session = Depends(get_db),
                            org_id: int = Depends(current_org_id_without_rls_guc)):
    """Attach (or detach) a conversation to a client — the Twenty-style
    "link to contact" merge the inbox was missing. Unknown-sender threads come in
    with client_id NULL (kept, not dropped, by design) and stay unlinked until
    someone identifies who it is; this is that action.

    Cascades to the conversation's messages so the client's unified comms view
    (`GET /client/{id}`, which unions by client_id) picks the whole thread up —
    otherwise linking the header alone would leave the messages orphaned.
    Passing client_id=null unlinks. Returns the updated conversation."""
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if data.client_id is not None:
        # BB-SEC-22: scope the TARGET too — an unscoped lookup here would let a
        # thread be linked to another workspace's client, leaking that client's
        # name into this org's inbox and dragging the thread into their
        # `GET /client/{id}` view.
        client = (db.query(Client)
                  .filter(Client.id == data.client_id, _org(Client, org_id, db))
                  .first())
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
def set_status(conv_id: int, data: StatusRequest, db: Session = Depends(get_db),
               org_id: int = Depends(current_org_id_without_rls_guc)):
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
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
def set_priority(conv_id: int, data: PriorityRequest, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id_without_rls_guc)):
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
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
def set_tags(conv_id: int, data: TagsRequest, db: Session = Depends(get_db),
             org_id: int = Depends(current_org_id_without_rls_guc)):
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
    if not conv:
        raise HTTPException(404, "Conversation not found")
    conv.tags = data.tags
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.post("/conversations/{conv_id}/read", dependencies=[Depends(require_role("admin", "manager"))])
def mark_read(conv_id: int, db: Session = Depends(get_db),
              org_id: int = Depends(current_org_id_without_rls_guc)):
    conv = (db.query(Conversation)
            .filter(Conversation.id == conv_id,
                    _org(Conversation, org_id, db))
            .first())
    if not conv:
        raise HTTPException(404, "Conversation not found")
    conv.unread_count = 0
    db.commit()
    db.refresh(conv)
    return conv_to_dict(conv)


@router.get("/client/{client_id}", dependencies=[Depends(require_role("admin", "manager"))])
def client_comms(client_id: int, db: Session = Depends(get_db),
                 org_id: int = Depends(current_org_id_without_rls_guc)):
    """Unified, contact-linked communications for one client (Twenty-style).

    Returns every email + SMS message linked to the client by client_id OR by a
    matching contact (their email, or any of their phone numbers normalized to
    E.164) — so messages that were never explicitly tied to the client_id still
    surface, the same way calendar events link by email. The frontend splits the
    flat ``messages`` list by channel for the SMS and Email tabs."""
    client = (db.query(Client)
              .filter(Client.id == client_id, _org(Client, org_id, db))  # BB-SEC-22 / BB-SEC-24
              .first())
    if not client:
        raise HTTPException(404, "Client not found")

    # Build the set of contact identifiers this client owns.
    contacts: set[str] = set()
    if client.email:
        contacts.add(client.email.strip().lower())
    phones = [client.phone] if client.phone else []
    for cp in (db.query(ContactPhone)
               .filter(ContactPhone.client_id == client_id,
                       _org(ContactPhone, org_id, db)).all()):  # BB-SEC-22 / BB-SEC-24
        if cp.phone:
            phones.append(cp.phone)
    for p in phones:
        n = _normalize_contact(p)
        if n:
            contacts.add(n.lower())

    # BB-SEC-22: the contact-match arm below is a string comparison on
    # external_contact, so without an org filter a shared phone number or email
    # would union in ANOTHER workspace's conversations.
    conds = [Conversation.client_id == client_id]
    if contacts:
        conds.append(func.lower(Conversation.external_contact).in_(list(contacts)))
    convs = (
        db.query(Conversation)
        .filter(_org(Conversation, org_id, db), or_(*conds))
        .order_by(Conversation.last_message_at.desc().nulls_last())
        .all()
    )

    messages: list[dict] = []
    # Per-CHANNEL thread counts. `voice` was missing, so a client whose only
    # contact was an inbound call counted as zero of everything while their
    # messages were still returned in the flat list below (BB-VOICE-01 writes
    # channel="voice" from the Twilio voice webhook). Counted generically now,
    # so the next channel that gets added cannot repeat this.
    by_channel: dict[str, int] = {}
    for c in convs:
        for m in c.messages:
            if m.is_internal_note:
                continue
            messages.append(msg_to_dict(m))
        if c.channel:
            by_channel[c.channel] = by_channel.get(c.channel, 0) + 1
    messages.sort(key=lambda m: m.get("created_at") or "")

    return {
        "messages": messages,
        # NOTE the asymmetry, which predates this change and is kept for
        # compatibility: the per-channel entries count CONVERSATIONS while
        # `total` counts MESSAGES, so `total` is not the sum of the others.
        "counts": {
            "sms": by_channel.get("sms", 0),
            "email": by_channel.get("email", 0),
            "voice": by_channel.get("voice", 0),
            "total": len(messages),
        },
        "client_email": client.email,
        "client_phone": client.phone,
    }


@router.post("/sms", response_model=Union[MessageRead, SMSPersistenceError], dependencies=[Depends(require_role("admin", "manager"))])
def send_sms_message(data: SMSRequest, db: Session = Depends(get_db),
                     org_id: int = Depends(current_org_id_without_rls_guc)):
    """Send an SMS via Twilio — attaches to a conversation automatically.
    If no client_id provided, tries to match the destination phone to an existing client.
    """
    # Normalize phone to E.164 format for consistent storage
    to_normalized = _normalize_contact(data.to)

    try:
        result = send_and_log(to=to_normalized, body=data.body, action="comms",
                              org_id=org_id)
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
            org_id=org_id,
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
            org_id=org_id,  # BB-MT-01
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
                       current_user=Depends(require_role("admin", "manager")),
                       org_id: int = Depends(current_org_id_without_rls_guc)):
    """Send an email — through the sender's connected Gmail when available (real
    Sent + threads back), else SMTP. Attaches to a conversation automatically."""
    conv = find_or_create_conversation(
        db, channel="email",
        client_id=data.client_id,
        external_contact=data.to,
        subject=data.subject,
        org_id=org_id,
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
        org_id=org_id,  # BB-MT-01
        external_id=external_id,
    )
    db.add(msg)
    db.flush()
    _apply_outbound(conv, msg)
    db.commit()
    db.refresh(msg)
    return msg_to_dict(msg)


def _twilio_request_url(request: Request) -> str:
    """The public URL Twilio actually signed.

    Twilio signs the full URL it POSTed to. Behind Railway's proxy
    request.url can show the internal scheme/host, so prefer the
    X-Forwarded-* headers when present or the signature never matches.
    """
    fwd_proto = request.headers.get("X-Forwarded-Proto")
    fwd_host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host")
    if fwd_proto and fwd_host:
        url = f"{fwd_proto}://{fwd_host}{request.url.path}"
        if request.url.query:
            url = f"{url}?{request.url.query}"
        return url
    return str(request.url)


def _verify_twilio_signature(request: Request, params: dict, *, what: str = "webhook") -> None:
    """BB-SEC-06: fail-CLOSED X-Twilio-Signature check. Raises 403, or returns.

    Shared by the SMS webhook and every voice endpoint. Without this anyone
    can POST a forged payload with an arbitrary From/Body and inject records
    under a real client's number — which also triggers the operator forward,
    turning Twilio into a free open relay against the on-call line.

    Fails CLOSED when TWILIO_AUTH_TOKEN is unset (July-2026 audit finding).
    That token is already required for outbound SMS — every quote, job
    reminder and owner alert needs it — so if it is unset in production there
    is no legitimate inbound traffic to serve anyway.
    """
    auth_token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
    if not auth_token:
        logger.error(
            f"[twilio] rejecting {what} — TWILIO_AUTH_TOKEN not set, cannot "
            f"validate signature. Set TWILIO_AUTH_TOKEN to accept inbound traffic."
        )
        raise HTTPException(status_code=403, detail="Twilio webhook not configured")

    from twilio.request_validator import RequestValidator
    validator = RequestValidator(auth_token)
    signature = request.headers.get("X-Twilio-Signature", "")
    if not validator.validate(_twilio_request_url(request), params, signature):
        logger.warning(
            f"[twilio] rejected {what} with bad signature from "
            f"{request.client.host if request.client else 'unknown'}"
        )
        raise HTTPException(status_code=403, detail="Invalid Twilio signature")


@router.post("/twilio/webhook")  # PUBLIC: Twilio posts here; signature is validated inside the handler (BB-SEC-06)
async def twilio_inbound(request: Request, db: Session = Depends(get_db)):
    """Receive inbound SMS from Twilio webhook. Groups into a conversation."""
    form = await request.form()

    params = {k: v for k, v in form.items()}
    _verify_twilio_signature(request, params, what="SMS webhook")

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
                org_id=client.org_id,  # BB-MT-01: inherit the matched client's org
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
        # BB-MT-01 left org_id unset here: one shared TWILIO_PHONE_NUMBER for
        # the whole deployment, no to_number → org mapping, so an inbound SMS
        # from an unrecognized number has no DERIVABLE org.
        #
        # BB-SEC-24 supersedes that conclusion, not its reasoning. There is
        # still no derivable org — but "unset" is not neutral any more. RLS is
        # FORCEd and its policy is `org_id = <guc> OR <guc> IS NULL`, so once
        # any route sets the GUC a NULL-org row matches neither arm and
        # Postgres hides it. Leaving a new lead NULL therefore files it where
        # nobody can see it, and these rows are exactly the new business:
        # 85 of 126 production conversations were NULL for this reason.
        #
        # NULL already MEANT the default workspace (database/rls.py,
        # modules/ai/router.py `_org()`), so stamping it is making the existing
        # semantics explicit rather than guessing. If a second workspace ever
        # gets its own inbound number, resolve the org from to_number here.
        client = Client(
            org_id=_default_org_id(db),  # BB-SEC-24
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
        org_id=client.org_id,
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
        org_id=client.org_id,  # BB-MT-01
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
        send_and_log(to=target_normalized, body=forward_body, action="comms_forward")
        logger.info(f"[twilio] Forwarded inbound SMS from {from_number} to {target_normalized}")
    except Exception as e:
        # Don't surface to caller — failed forward shouldn't make Twilio retry.
        logger.warning(f"[twilio] Forward to {target_normalized} failed: {e}")


# ---------------------------------------------------------------------------
# Voice — inbound calls and voicemail (BB-VOICE-01)
#
# PUBLIC routes: Twilio posts here with no API key, so every handler verifies
# X-Twilio-Signature itself via _verify_twilio_signature (fail-closed). The
# /api/comms/twilio/voice prefix is allowlisted in auth.py.
#
# Call flow:
#   POST /twilio/voice          → <Dial> the on-call phone for VOICE_RING_SECONDS
#   POST /twilio/voice/after-dial   → answered? hang up. missed? greet + <Record>
#   POST /twilio/voice/after-record → recording finished normally
#   POST /twilio/voice/recording    → recording status callback (fires even when
#                                     the caller hangs up mid-message)
#   POST /twilio/voice/transcription → Twilio's transcript, minutes later
#
# Every one of those writes the SAME Message row, keyed on CallSid, so a call
# is one inbox entry that fills in as Twilio learns more about it — not four.
# ---------------------------------------------------------------------------

_VOICE_BASE = "/api/comms/twilio/voice"


def _voice_forward_target() -> Optional[str]:
    """Number to ring before voicemail. Falls back to the SMS forward number.

    Read per-request rather than at import so the deploy picks up a Railway
    env change on restart without this module caring which var was set.
    """
    return (os.getenv("VOICE_FORWARD_TO") or os.getenv("FORWARD_INBOUND_SMS_TO") or "").strip() or None


def _twiml(vr) -> Response:
    return Response(content=str(vr), media_type="text/xml")


def _say(vr, text: str):
    """<Say> with the configured voice, or Twilio's default when unset."""
    if VOICE_TTS_VOICE:
        vr.say(text, voice=VOICE_TTS_VOICE)
    else:
        vr.say(text)


def _voicemail_prompt(vr):
    """Greeting + <Record> with transcription, appended to a VoiceResponse."""
    _say(vr, VOICE_GREETING)
    vr.record(
        max_length=VOICE_MAX_RECORDING_SECONDS,
        timeout=5,
        play_beep=True,
        finish_on_key="#",
        transcribe=True,
        transcribe_callback=f"{_VOICE_BASE}/transcription",
        action=f"{_VOICE_BASE}/after-record",
        method="POST",
        recording_status_callback=f"{_VOICE_BASE}/recording",
        recording_status_callback_method="POST",
    )
    # Only reached when the caller stayed silent through the whole timeout.
    _say(vr, "We didn't catch a message. Goodbye.")
    vr.hangup()


def _fmt_duration(seconds) -> str:
    try:
        s = int(seconds or 0)
    except (TypeError, ValueError):
        s = 0
    return f"{s // 60}:{s % 60:02d}"


def _voice_log(
    db: Session,
    *,
    call_sid: str,
    from_number: str,
    to_number: str,
    body: str,
    subject: Optional[str] = None,
) -> Optional[Message]:
    """Create-or-update the single Message row for one inbound call.

    Keyed on CallSid, so after-dial / after-record / recording / transcription
    all converge on one inbox entry. Only the first write bumps unread and the
    SLA clock — a transcript landing two minutes later is new information
    about a call already in the inbox, not a second call.

    Returns the Message, or None if the payload had no CallSid to key on.
    """
    if not call_sid:
        logger.warning("[twilio-voice] payload with no CallSid; not logging")
        return None

    from_normalized = _normalize_contact(from_number) or from_number
    existing = db.query(Message).filter(Message.external_id == call_sid).first()
    if existing:
        existing.body = body
        if subject:
            existing.subject = subject
        db.commit()
        return existing

    client = _match_client_by_phone(db, from_normalized)
    if client:
        logger.info(f"[twilio-voice] Matched call {call_sid} → client #{client.id} ({client.name})")
    else:
        logger.info(f"[twilio-voice] Call {call_sid} from unknown number {from_normalized}")
        # BB-SEC-24: stamp the default workspace, same reasoning as inbound SMS
        # above. There is still no org derivable from a shared business number,
        # but leaving it NULL hides the lead once RLS has a GUC to compare
        # against, and NULL already meant "the default workspace".
        client = Client(
            org_id=_default_org_id(db),  # BB-SEC-24
            name=from_normalized,
            phone=from_normalized,
            status="lead",
            source="phone",
        )
        db.add(client)
        db.flush()

    conv = find_or_create_conversation(
        db, channel="voice",
        client_id=client.id,
        external_contact=from_normalized,
        org_id=client.org_id,
    )
    msg = Message(
        client_id=client.id,
        conversation_id=conv.id,
        channel="voice",
        direction="inbound",
        from_addr=from_normalized,
        to_addr=_normalize_contact(to_number),
        subject=subject,
        body=body,
        status="received",
        external_id=call_sid,
        org_id=client.org_id,  # BB-MT-01
    )
    db.add(msg)
    db.flush()
    _apply_inbound(conv, msg)
    db.commit()

    try:
        from services.push_service import notify_staff
        who = (client.name if client else None) or from_normalized or "Missed call"
        notify_staff(
            db,
            f"📞 {who}",
            body[:140] or "Missed call",
            url="/messages",
            tag=f"conv-{conv.id}",
            org_id=getattr(conv, "org_id", None),
            category="messages",
        )
    except Exception:
        pass

    return msg


def _forward_voicemail_sms(*, from_number: str, client_name: Optional[str], text: str) -> None:
    """Text the on-call phone a copy of the voicemail transcript.

    The point of the whole feature: the transcript arrives where she already
    looks, instead of behind a voicemail box nobody checks. Best-effort —
    a failed send must never make Twilio retry the callback.
    """
    target = _voice_forward_target()
    if not target:
        return
    target_normalized = _normalize_contact(target)
    # Loop prevention, same as the SMS forward: never text the on-call line
    # about its own call.
    if from_number and from_number == target_normalized:
        return

    label = client_name or from_number or "unknown"
    snippet = (text or "").strip()
    if len(snippet) > 1200:
        snippet = snippet[:1200] + "…"
    try:
        send_and_log(to=target_normalized, body=f"Voicemail from {label}:\n{snippet}", action="comms_forward")
        logger.info(f"[twilio-voice] Forwarded voicemail from {from_number} to {target_normalized}")
    except Exception as e:
        logger.warning(f"[twilio-voice] Voicemail forward to {target_normalized} failed: {e}")


@router.post("/twilio/voice")  # PUBLIC: signature validated inside the handler (BB-SEC-06)
async def twilio_voice(request: Request, db: Session = Depends(get_db)):
    """Answer an inbound call: ring the on-call phone, else take a message."""
    form = await request.form()
    params = {k: v for k, v in form.items()}
    _verify_twilio_signature(request, params, what="voice webhook")

    from twilio.twiml.voice_response import VoiceResponse, Dial

    from_number = form.get("From", "")
    to_number = form.get("To", "")
    call_sid = form.get("CallSid", "")
    logger.info(f"[twilio-voice] Inbound call {call_sid} from {from_number} to {to_number}")

    vr = VoiceResponse()
    target = _voice_forward_target()

    if not target:
        # Straight-to-voicemail mode. Nothing rings, so after-dial never runs
        # and this is the only chance to log the call before the caller may
        # hang up without recording.
        logger.info("[twilio-voice] No forward target configured — going straight to voicemail")
        _voice_log(
            db,
            call_sid=call_sid,
            from_number=from_number,
            to_number=to_number,
            body="Incoming call — no message left.",
            subject="Missed call",
        )
        _voicemail_prompt(vr)
        return _twiml(vr)

    # callerId must be a number this account owns or has verified — the
    # caller's own number is neither, so use the business line. The caller's
    # number is in the inbox entry and the voicemail text either way.
    caller_id = _normalize_contact(os.getenv("TWILIO_PHONE_NUMBER", "")) or None
    dial = Dial(
        timeout=VOICE_RING_SECONDS,
        action=f"{_VOICE_BASE}/after-dial",
        method="POST",
        caller_id=caller_id,
    )
    dial.number(_normalize_contact(target))
    vr.append(dial)
    # No TwiML after <Dial>: an `action` URL means Twilio continues there and
    # never falls through to the verbs below it.
    return _twiml(vr)


@router.post("/twilio/voice/after-dial")  # PUBLIC: signature validated inside the handler
async def twilio_voice_after_dial(request: Request, db: Session = Depends(get_db)):
    """The ring-through ended. Answered → hang up. Missed → take a message."""
    form = await request.form()
    params = {k: v for k, v in form.items()}
    _verify_twilio_signature(request, params, what="voice after-dial")

    from twilio.twiml.voice_response import VoiceResponse

    status = (form.get("DialCallStatus") or "").lower()
    call_sid = form.get("CallSid", "")
    vr = VoiceResponse()

    if status == "completed":
        # She picked up and the call has ended. Nothing to log — she was there.
        logger.info(f"[twilio-voice] Call {call_sid} answered; no voicemail needed")
        vr.hangup()
        return _twiml(vr)

    logger.info(f"[twilio-voice] Call {call_sid} not answered (DialCallStatus={status!r}); taking a message")
    _voice_log(
        db,
        call_sid=call_sid,
        from_number=form.get("From", ""),
        to_number=form.get("To", ""),
        body="Missed call — caller hung up without leaving a message.",
        subject="Missed call",
    )
    _voicemail_prompt(vr)
    return _twiml(vr)


def _record_finished(db: Session, form) -> None:
    """Shared by after-record and the recording status callback.

    Both can fire for one voicemail (and only one fires when the caller hangs
    up mid-message), so this is idempotent by way of _voice_log's CallSid key.
    """
    call_sid = form.get("CallSid", "")
    duration = form.get("RecordingDuration")
    url = form.get("RecordingUrl") or ""

    # A 0-second or absent recording is a hang-up, not a voicemail. Leave the
    # "missed call" entry from after-dial exactly as it is.
    try:
        secs = int(duration or 0)
    except (TypeError, ValueError):
        secs = 0
    if secs < 1 or not url:
        logger.info(f"[twilio-voice] Call {call_sid} left no usable recording (dur={duration!r})")
        return

    body = "Voicemail received — transcript pending."
    if url:
        body += f"\n\nRecording: {url}.mp3"
    _voice_log(
        db,
        call_sid=call_sid,
        from_number=form.get("From", ""),
        to_number=form.get("To", ""),
        body=body,
        subject=f"Voicemail ({_fmt_duration(secs)})",
    )


@router.post("/twilio/voice/after-record")  # PUBLIC: signature validated inside the handler
async def twilio_voice_after_record(request: Request, db: Session = Depends(get_db)):
    """Recording finished normally (# pressed, silence, or max length)."""
    form = await request.form()
    params = {k: v for k, v in form.items()}
    _verify_twilio_signature(request, params, what="voice after-record")

    from twilio.twiml.voice_response import VoiceResponse

    _record_finished(db, form)
    vr = VoiceResponse()
    _say(vr, "Thanks. We'll get back to you soon. Goodbye.")
    vr.hangup()
    return _twiml(vr)


@router.post("/twilio/voice/recording")  # PUBLIC: signature validated inside the handler
async def twilio_voice_recording(request: Request, db: Session = Depends(get_db)):
    """Recording status callback — fires even when the caller hangs up mid-message.

    That hang-up case is the common one for a real voicemail (people rarely
    press #), and <Record action=...> does NOT fire on hangup. Without this
    callback those voicemails would record and never reach the inbox.
    """
    form = await request.form()
    params = {k: v for k, v in form.items()}
    _verify_twilio_signature(request, params, what="voice recording callback")

    if (form.get("RecordingStatus") or "completed").lower() == "completed":
        _record_finished(db, form)
    return Response(status_code=204)


@router.post("/twilio/voice/transcription")  # PUBLIC: signature validated inside the handler
async def twilio_voice_transcription(request: Request, db: Session = Depends(get_db)):
    """Twilio's transcript, which lands a minute or two after the recording."""
    form = await request.form()
    params = {k: v for k, v in form.items()}
    _verify_twilio_signature(request, params, what="voice transcription callback")

    call_sid = form.get("CallSid", "")
    status = (form.get("TranscriptionStatus") or "").lower()
    text = (form.get("TranscriptionText") or "").strip()
    url = form.get("RecordingUrl") or ""

    msg = db.query(Message).filter(Message.external_id == call_sid).first()

    if status != "completed" or not text:
        logger.info(f"[twilio-voice] Transcription for {call_sid} unusable (status={status!r})")
        if msg and "transcript pending" in (msg.body or "").lower():
            msg.body = (msg.body or "").replace(
                "Voicemail received — transcript pending.",
                "Voicemail received — Twilio couldn't transcribe it. Listen to the recording.",
            )
            db.commit()
        return Response(status_code=204)

    body = text
    if url:
        body += f"\n\nRecording: {url}.mp3"

    msg = _voice_log(
        db,
        call_sid=call_sid,
        from_number=form.get("From", ""),
        to_number=form.get("To", ""),
        body=body,
        subject=msg.subject if msg and msg.subject else "Voicemail",
    )

    client_name = None
    if msg and msg.client_id:
        c = db.query(Client).filter(Client.id == msg.client_id).first()
        # A placeholder lead is named after its own phone number — repeating
        # that in the alert tells her nothing she can't already see.
        if c and c.name and c.name != (msg.from_addr or ""):
            client_name = c.name

    _forward_voicemail_sms(
        from_number=_normalize_contact(form.get("From", "")) or "",
        client_name=client_name,
        text=text,
    )
    return Response(status_code=204)
