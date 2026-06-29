from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy import or_
from pydantic import BaseModel
from typing import Literal, Optional, List
from datetime import datetime, date
import io
import re
import logging

logger = logging.getLogger(__name__)

from database.db import get_db
from database.models import Client, Property, Job, ICalEvent, Opportunity, Quote, Invoice, Message, Activity, ContactPhone, ContactEmail, Conversation, User, RecurringSchedule, LeadIntake
from utils.phone import digits_only as _digits_only, phone_tail as _phone_tail
from utils.contacts import normalize_phone
from utils.enrichment import enrich_client_data
from modules.auth.router import get_current_user, require_role, current_org_id

router = APIRouter()

_STATE_CODE_RE = re.compile(r'^[A-Za-z]{2}$')


def _normalize_client_fields(data: dict, existing_city: Optional[str] = None) -> dict:
    """Server-side normalization applied on every client entry path (create,
    update, import) so the data is clean no matter how it got in:

      - trim whitespace on all string values
      - phone -> E.164 (+1XXXXXXXXXX)
      - 2-letter state codes -> uppercase (state, billing_state)
      - strip a trailing city that an import appended onto the street address,
        e.g. street "116 E Shore Beach Road Naples" + city "Naples" -> street
        "116 E Shore Beach Road". Only runs when the city is known and the
        street actually ends with it, so a correctly-set city is never lost and
        a legitimate street is never truncated.

    Mutates and returns `data` in place.
    """
    for k, v in list(data.items()):
        if isinstance(v, str):
            data[k] = v.strip()

    if data.get("phone"):
        data["phone"] = normalize_phone(data["phone"])

    for sk in ("state", "billing_state"):
        v = data.get(sk)
        if v and _STATE_CODE_RE.match(v):
            data[sk] = v.upper()

    city = data.get("city") or existing_city
    addr = data.get("address")
    if city and addr:
        # Strip the city when it trails the street (optionally after a comma).
        stripped = re.sub(r'[,\s]+' + re.escape(city) + r'\s*$', '', addr, flags=re.IGNORECASE)
        stripped = stripped.strip().rstrip(',').strip()
        if stripped and stripped != addr:
            data["address"] = stripped

    return data


def _derive_name(first: Optional[str], last: Optional[str], fallback: str) -> str:
    """Return 'First Last' when both parts are set, else fallback to existing name."""
    parts = " ".join(p for p in [first, last] if p and p.strip())
    return parts if parts else fallback


# A client "name" that looks like a bare phone number — used to detect
# placeholder clients auto-created by the Twilio inbound webhook when a
# message arrives from an unknown number.
_PLACEHOLDER_NAME_PATTERN = re.compile(r"^\+?[\d\s().\-]+$")


def _is_placeholder_candidate(client: Client) -> bool:
    """Heuristic: this Client row was auto-created from an inbound SMS and
    was never promoted to a real contact, so it's safe to absorb into a real
    client when the same phone gets attached to that real client.

    ALL of these must be true for a client to qualify:
      - status == "lead"            (never promoted past lead)
      - source == "sms"             (came from the Twilio auto-create path)
      - email is empty              (never filled in)
      - billing_address is empty
      - `name` either is empty or looks like a phone number
      - no real business data attached:
          quotes, invoices, jobs, properties, opportunities,
          recurring_schedules, contact_emails
    """
    if client.status != "lead":
        return False
    if (client.source or "").strip().lower() != "sms":
        return False
    if client.email and client.email.strip():
        return False
    if client.billing_address and client.billing_address.strip():
        return False
    name = (client.name or "").strip()
    if name and not _PLACEHOLDER_NAME_PATTERN.match(name):
        return False
    if client.quotes: return False
    if client.invoices: return False
    if client.jobs: return False
    if client.properties: return False
    if client.opportunities: return False
    if client.recurring_schedules: return False
    if client.contact_emails: return False
    return True


def _fold_conv_into(db: Session, source: "Conversation", keeper: "Conversation", report: dict) -> None:
    """Move every message off `source` into `keeper`, merge metadata, delete
    source. Used both for absorbing placeholder-client conversations and for
    de-duplicating multiple SMS conversations against the (client_id, channel)
    unique index. Must use the relationship setter (not the FK column) so
    SQLAlchemy updates both sides — otherwise the cascade="all, delete-orphan"
    on Conversation.messages will delete the messages along with `source`."""
    for msg in list(source.messages):
        msg.conversation = keeper
        if msg.client_id is None and keeper.client_id is not None:
            msg.client_id = keeper.client_id
            report["linked_messages"] = report.get("linked_messages", 0) + 1
    db.flush()
    keeper.unread_count = (keeper.unread_count or 0) + (source.unread_count or 0)
    if source.last_message_at and (not keeper.last_message_at or source.last_message_at > keeper.last_message_at):
        keeper.last_message_at = source.last_message_at
    if source.last_inbound_at and (not keeper.last_inbound_at or source.last_inbound_at > keeper.last_inbound_at):
        keeper.last_inbound_at = source.last_inbound_at
    if source.last_outbound_at and (not keeper.last_outbound_at or source.last_outbound_at > keeper.last_outbound_at):
        keeper.last_outbound_at = source.last_outbound_at
    if source.status == "open" and keeper.status == "resolved":
        keeper.status = "open"
        keeper.resolved_at = None
    if source.tags:
        keeper.tags = list(set((keeper.tags or []) + source.tags))
    db.delete(source)
    report["merged_conversations"] = report.get("merged_conversations", 0) + 1


def _attach_conv_to_client(
    db: Session,
    conv: "Conversation",
    client: "Client",
    existing_keeper_by_channel: dict,
    report: dict,
) -> "Conversation":
    """Attach `conv` to `client`, respecting the partial unique index on
    (client_id, channel). If the client already has a conversation for the
    same channel (tracked via the caller-supplied dict), fold `conv`'s
    messages into that keeper and delete `conv` instead of triggering the
    UNIQUE violation we used to hit before this guard.

    IMPORTANT: takes a `Client` object (not an id) and uses the
    relationship setter `conv.client = client` rather than
    `conv.client_id = client.id`. Because Client.conversations and
    Client.messages are configured with cascade="all, delete-orphan",
    a bare FK reassignment leaves the source-side collection stale —
    the conv stays in placeholder.conversations until delete time, and
    the cascade then deletes the just-moved conv (and its messages).
    The relationship setter updates both sides of the collection so the
    cascade can't reach the moved rows.

    Returns whichever conversation now represents the client's thread for
    that channel (caller may want to keep using it as the keeper for
    subsequent folds in the same pass)."""
    keeper = existing_keeper_by_channel.get(conv.channel)
    if keeper is None or keeper.id == conv.id:
        # First conv we see for this channel — safe to re-parent.
        conv.client = client
        report["linked_conversations"] = report.get("linked_conversations", 0) + 1
        for msg in conv.messages:
            if msg.client_id is None:
                msg.client = client
                report["linked_messages"] = report.get("linked_messages", 0) + 1
        existing_keeper_by_channel[conv.channel] = conv
        return conv
    # A keeper already exists for this (client_id, channel) — fold this one in.
    _fold_conv_into(db, conv, keeper, report)
    return keeper


def _absorb_placeholder_clients(
    db: Session, real_client_id: int, phone: str, report: dict
) -> None:
    """Find placeholder Client rows matching this phone's last-10 tail and
    merge them INTO real_client_id. Placeholder is defined by
    _is_placeholder_candidate — we refuse to absorb anything that has actual
    business data on it.

    For each placeholder we absorb we:
      - re-parent its conversations, messages, lead_intakes, contact_phones
        (deduped), activities, and any opportunities
      - delete the placeholder Client row

    Mutates `report` in place with absorbed_clients count.
    """
    report.setdefault("absorbed_clients", 0)
    tail = _phone_tail(phone)
    if not tail:
        return

    # Find candidate placeholder clients by phone tail using indexed queries (O(log n))
    candidates: set[int] = set()
    # Indexed query on Client
    for c in db.query(Client).filter(
        Client.id != real_client_id,
        Client.phone_tail == tail,
    ).all():
        candidates.add(c.id)
    # Indexed query on ContactPhone
    for cp in db.query(ContactPhone).filter(
        ContactPhone.client_id != real_client_id,
        ContactPhone.phone_tail == tail,
    ).all():
        candidates.add(cp.client_id)

    # Fetch the real client object once
    real = db.query(Client).filter(Client.id == real_client_id).first()
    if real is None:
        return

    # Track the real client's existing conversations per channel so
    # re-parenting an absorbed placeholder's conversation doesn't trip the
    # (client_id, channel) unique index (Bug C — #81 follow-up).
    keepers_by_channel: dict = {
        c.channel: c for c in db.query(Conversation).filter(
            Conversation.client_id == real_client_id
        ).all()
    }

    for cid in candidates:
        placeholder = db.query(Client).filter(Client.id == cid).first()
        if not placeholder or not _is_placeholder_candidate(placeholder):
            continue

        # Re-parent each relationship using the relationship setter
        for conv in list(placeholder.conversations):
            _attach_conv_to_client(db, conv, real, keepers_by_channel, report)
        for msg in list(placeholder.messages):
            msg.client = real
            report["linked_messages"] += 1
        for intake in list(placeholder.lead_intakes):
            intake.client = real
        for act in list(placeholder.activities):
            act.client = real
        for opp in list(placeholder.opportunities):
            opp.client = real

        # Contact phones: dedup by literal phone string
        existing = {
            cp.phone for cp in db.query(ContactPhone).filter(
                ContactPhone.client_id == real_client_id
            ).all()
        }
        for cp in list(placeholder.contact_phones):
            if cp.phone in existing:
                db.delete(cp)
            else:
                cp.client = real
                existing.add(cp.phone)

        db.flush()
        db.delete(placeholder)
        report["absorbed_clients"] += 1


def _link_and_merge_conversations(db: Session, client_id: int, phone: str) -> dict:
    """
    When a phone number is added to a client:
    0. Absorb any SMS-auto-created placeholder clients for this phone.
    1. Find orphan conversations (client_id is null) with matching external_contact.
    2. Link them + their messages to this client.
    3. Merge duplicate conversations (same client + same channel) into one thread.
    Returns a report of what was done.
    """
    tail = _phone_tail(phone)
    report = {
        "linked_conversations": 0,
        "linked_messages": 0,
        "merged_conversations": 0,
        "absorbed_clients": 0,
    }
    if not tail:
        return report

    # 0. Absorb any SMS-auto-created placeholder clients for this phone into
    # the real client. Their conversations/messages/intakes get re-parented.
    _absorb_placeholder_clients(db, client_id, phone, report)

    # 1. Find all conversations (orphan OR linked to other clients) with matching external_contact tail
    #    Eager-load messages to avoid N+1 queries
    all_convs = (
        db.query(Conversation)
          .options(selectinload(Conversation.messages))
          .filter(Conversation.channel == "sms")
          .all()
    )
    candidates = [c for c in all_convs if _phone_tail(c.external_contact) == tail]

    # 2. Link orphan conversations to this client. Route through
    # _attach_conv_to_client so the (client_id, channel) unique index can't
    # blow up when the client already has a conversation on the same channel
    # — in that case we fold instead of re-parent (Bug C — #81 follow-up).
    # Fetch the Client object so we can use the relationship setter
    # (avoids the cascade-delete-orphan trap; see _attach_conv_to_client).
    client_obj = db.query(Client).filter(Client.id == client_id).first()
    if client_obj is None:
        return report
    keepers_by_channel: dict = {
        c.channel: c for c in db.query(Conversation).filter(
            Conversation.client_id == client_id
        ).all()
    }
    for conv in candidates:
        if conv.client_id is None:
            _attach_conv_to_client(db, conv, client_obj, keepers_by_channel, report)

    # 3. Also relink orphan messages that match this phone but not tied to any conversation yet
    all_msgs = db.query(Message).filter(
        Message.channel == "sms",
        Message.client_id.is_(None)
    ).all()
    for msg in all_msgs:
        msg_phone = msg.from_addr if msg.direction == "inbound" else msg.to_addr
        if _phone_tail(msg_phone) == tail:
            msg.client_id = client_id
            report["linked_messages"] += 1

    # 4. Merge multiple SMS conversations for this client into one (by channel)
    #    Eager-load messages to avoid N+1 when moving messages between conversations
    db.flush()
    client_convs = (
        db.query(Conversation)
          .options(selectinload(Conversation.messages))
          .filter(
              Conversation.client_id == client_id,
              Conversation.channel == "sms"
          )
          .order_by(Conversation.created_at.asc())
          .all()
    )

    if len(client_convs) > 1:
        keeper = client_convs[0]
        for dup in client_convs[1:]:
            _fold_conv_into(db, dup, keeper, report)

    return report


class ClientCreate(BaseModel):
    name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    billing_address: Optional[str] = None
    billing_city: Optional[str] = None
    billing_state: Optional[str] = None
    billing_zip: Optional[str] = None
    status: Optional[str] = "lead"
    notes: Optional[str] = None
    source: Optional[str] = None
    custom_fields: Optional[dict] = {}


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    billing_address: Optional[str] = None
    billing_city: Optional[str] = None
    billing_state: Optional[str] = None
    billing_zip: Optional[str] = None
    status: Optional[Literal["lead", "active", "inactive"]] = None
    notes: Optional[str] = None
    source: Optional[str] = None
    custom_fields: Optional[dict] = None


class ContactPhoneCreate(BaseModel):
    phone: str
    is_primary: Optional[bool] = False
    phone_type: Optional[str] = None


class ContactPhoneUpdate(BaseModel):
    phone: Optional[str] = None
    is_primary: Optional[bool] = None
    phone_type: Optional[str] = None


class ContactPhoneRead(BaseModel):
    id: int
    phone: str
    is_primary: bool
    phone_type: Optional[str] = None
    source: Optional[str] = None
    created_at: Optional[str] = None


class ContactPhoneCreateResponse(ContactPhoneRead):
    linked: dict


def _phone_to_dict(phone: ContactPhone) -> dict:
    return {
        "id": phone.id,
        "phone": phone.phone,
        "is_primary": phone.is_primary,
        "phone_type": phone.phone_type,
        "source": phone.source,
        "created_at": phone.created_at.isoformat() if phone.created_at else None,
    }


class ContactEmailCreate(BaseModel):
    email: str
    is_primary: Optional[bool] = False


class ContactEmailUpdate(BaseModel):
    email: Optional[str] = None
    is_primary: Optional[bool] = None


def _derive_property_type(client: Client) -> str:
    """Compute a client's effective property type from its properties.

    Replaces the dropped ``Client.client_type`` column. Single property type
    (or all properties share one) → that type. Multiple distinct types →
    ``"mixed"``. No properties yet → ``"residential"`` (matches the historic
    UI default).
    """
    types = {p.property_type for p in (client.properties or []) if p.property_type}
    if not types:
        return "residential"
    if len(types) == 1:
        return next(iter(types))
    return "mixed"


def client_to_dict(c: Client) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "first_name": c.first_name or "",
        "last_name": c.last_name or "",
        "email": c.email,
        "phone": c.phone,
        "address": c.address,
        "city": c.city,
        "state": c.state,
        "zip_code": c.zip_code,
        "billing_address": c.billing_address or "",
        "billing_city": c.billing_city or "",
        "billing_state": c.billing_state or "",
        "billing_zip": c.billing_zip or "",
        "status": c.status,
        "notes": c.notes,
        "source": c.source,
        "custom_fields": c.custom_fields or {},
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": getattr(c, "updated_at", None).isoformat() if getattr(c, "updated_at", None) else None,
        "created_by": getattr(c, "created_by", None),
        "updated_by": getattr(c, "updated_by", None),
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_clients(
    status: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    # MT-2: scope to the caller's workspace. Tolerate legacy NULL rows (none
    # after MT-1's backfill, but defensive) so nothing silently disappears.
    q = db.query(Client).filter(or_(Client.org_id == org_id, Client.org_id.is_(None)))
    if status:
        q = q.filter(Client.status == status)
    # Typeahead support: case-insensitive match on name / email / phone so the
    # job scheduler can search instead of preloading every client.
    if search and search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(or_(Client.name.ilike(like), Client.email.ilike(like), Client.phone.ilike(like)))
    return [client_to_dict(c) for c in q.order_by(Client.created_at.desc()).offset(offset).limit(limit).all()]


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_client(data: ClientCreate, db: Session = Depends(get_db),
                  current_user: User = Depends(get_current_user),
                  org_id: int = Depends(current_org_id)):
    payload = data.model_dump()
    _normalize_client_fields(payload)
    # Enrich with extracted data from email, name, etc.
    payload = enrich_client_data(payload)
    payload["name"] = _derive_name(payload.get("first_name"), payload.get("last_name"), payload.get("name") or "")
    if not payload["name"]:
        raise HTTPException(status_code=422, detail="name or first_name required")
    client = Client(**payload)
    client.org_id = org_id  # MT-2: stamp the caller's workspace
    # Audit actor: who created this record (Twenty's ActorMetadata).
    client.created_by = client.updated_by = getattr(current_user, "id", None)
    db.add(client)
    db.commit()
    db.refresh(client)
    return client_to_dict(client)


@router.get("/check-duplicate", dependencies=[Depends(require_role("admin", "manager"))])
def check_duplicate(
    name: Optional[str] = None,
    phone: Optional[str] = None,
    email: Optional[str] = None,
    exclude_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """Find existing clients that look like duplicates of the given details —
    same phone (by last-10 tail), same email (case-insensitive), or same name.
    Used by the new-client form to warn (non-blocking) before creating a dup.

    NB: declared before GET /{client_id} so the literal path isn't swallowed by
    the int path-param route."""
    q = db.query(Client)
    if exclude_id:
        q = q.filter(Client.id != exclude_id)

    matches: dict[int, Client] = {}
    tail = _phone_tail(normalize_phone(phone)) if phone else None
    if tail:
        for c in q.filter(Client.phone_tail == tail).all():
            matches[c.id] = c
        # Also match secondary numbers stored as ContactPhone rows — the UI
        # supports multiple phones per client, so a new client carrying an
        # existing client's non-primary number should still warn (Codex review).
        secondary_ids = {cp.client_id for cp in db.query(ContactPhone).filter(ContactPhone.phone_tail == tail).all()}
        secondary_ids -= set(matches)
        if exclude_id:
            secondary_ids.discard(exclude_id)
        if secondary_ids:
            for c in db.query(Client).filter(Client.id.in_(secondary_ids)).all():
                matches[c.id] = c
    if email:
        em = email.strip().lower()
        if em:
            from sqlalchemy import func as _func
            for c in q.filter(_func.lower(Client.email) == em).all():
                matches[c.id] = c
    if name:
        nm = name.strip().lower()
        if nm:
            from sqlalchemy import func as _func
            for c in q.filter(_func.lower(Client.name) == nm).all():
                matches[c.id] = c

    return {"duplicates": [client_to_dict(c) for c in matches.values()]}


@router.get("/health", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def crm_health(
    sample: int = Query(10, ge=0, le=100),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """Read-only CRM health snapshot. Classifies every client in the workspace
    into one primary bucket so you can SEE the breakdown — "how many of these 47
    leads are real?" — BEFORE running any cleanup or merge. Mutates nothing.

    Buckets are mutually exclusive (priority order below) so counts sum to total:
      test           — name matches an obvious test/junk pattern
      spam_marketing — email is a no-reply / marketing / cold-outreach sender
                        (same rule that now blocks inbound auto-create)
      duplicate      — shares a normalized email or phone with another client
      incomplete     — no reachable email/phone, or an SMS phone-number placeholder
                        standing in for a real name
      real           — everything else (contactable, named, unique)

    `by_source` / `by_status` are independent tallies (each sums to total).

    NB: declared before GET /{client_id} so the literal path isn't swallowed by
    the int path-param route."""
    from collections import defaultdict
    from integrations.email_filter import is_spam_sender

    clients = db.query(Client).filter(
        or_(Client.org_id == org_id, Client.org_id.is_(None))
    ).all()

    # Duplicate membership: any client sharing a normalized email or phone tail
    # with at least one other client in the workspace.
    by_email: dict[str, list[int]] = defaultdict(list)
    by_tail: dict[str, list[int]] = defaultdict(list)
    for c in clients:
        if c.email and c.email.strip():
            by_email[c.email.strip().lower()].append(c.id)
        if c.phone_tail:
            by_tail[c.phone_tail].append(c.id)
    dup_ids: set[int] = set()
    for ids in by_email.values():
        if len(ids) > 1:
            dup_ids.update(ids)
    for ids in by_tail.values():
        if len(ids) > 1:
            dup_ids.update(ids)

    TEST_PATTERNS = {"test", "asdf", "sample", "demo", "xxx"}

    def _is_placeholder_name(c: Client) -> bool:
        n = (c.name or "").strip()
        digits = n.replace("-", "").replace("(", "").replace(")", "").replace(" ", "")
        return bool(n) and (n.startswith("+") or digits.isdigit())

    buckets: dict[str, list[Client]] = {
        k: [] for k in ("test", "spam_marketing", "duplicate", "incomplete", "real")
    }
    by_source: dict[str, int] = defaultdict(int)
    by_status: dict[str, int] = defaultdict(int)

    for c in clients:
        by_source[c.source or "unknown"] += 1
        by_status[c.status or "unknown"] += 1

        name_l = (c.name or "").lower()
        has_contact = bool((c.email and c.email.strip()) or c.phone_tail)
        if name_l and any(t in name_l for t in TEST_PATTERNS):
            cat = "test"
        elif c.email and is_spam_sender(c.email):
            cat = "spam_marketing"
        elif c.id in dup_ids:
            cat = "duplicate"
        elif not has_contact or _is_placeholder_name(c):
            cat = "incomplete"
        else:
            cat = "real"
        buckets[cat].append(c)

    def _summarize(items: list[Client]) -> dict:
        return {
            "count": len(items),
            "sample": [
                {"id": c.id, "name": c.name, "email": c.email, "phone": c.phone,
                 "source": c.source, "status": c.status}
                for c in items[:sample]
            ],
        }

    return {
        "total": len(clients),
        "buckets": {k: _summarize(v) for k, v in buckets.items()},
        "by_source": dict(sorted(by_source.items(), key=lambda kv: -kv[1])),
        "by_status": dict(sorted(by_status.items(), key=lambda kv: -kv[1])),
    }


@router.get("/{client_id}", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_client(client_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    # MT-2: a client in another workspace reads as 404 (not visible cross-tenant).
    client = db.query(Client).filter(
        Client.id == client_id,
        or_(Client.org_id == org_id, Client.org_id.is_(None)),
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client_to_dict(client)


@router.get("/{client_id}/profile")
def get_client_profile(client_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """
    Get client's full profile including properties, upcoming/past visits, and GCal sync status.
    """
    client = db.query(Client).options(
        joinedload(Client.properties).joinedload(Property.property_icals),
        joinedload(Client.properties).joinedload(Property.ical_events),
        joinedload(Client.jobs)
    ).filter(
        Client.id == client_id,
        or_(Client.org_id == org_id, Client.org_id.is_(None)),  # MT-2 tenant scope
    ).first()

    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    # Build base client dict
    profile = client_to_dict(client)

    # Add properties
    properties_data = []
    for prop in client.properties:
        properties_data.append({
            "id": prop.id,
            "name": prop.name,
            "address": prop.address,
            "ical_url": prop.ical_url,
            "type": prop.property_type,
        })
    profile["properties"] = properties_data

    # Split jobs into upcoming and past
    today = date.today().isoformat()
    upcoming_jobs = []
    past_jobs = []

    for job in client.jobs:
        # Skip cancelled jobs in upcoming
        if job.scheduled_date and job.scheduled_date >= today and job.status != "cancelled":
            upcoming_jobs.append(job)
        elif job.scheduled_date and job.scheduled_date < today:
            past_jobs.append(job)

    # Sort upcoming ascending, past descending
    upcoming_jobs.sort(key=lambda j: (j.scheduled_date, j.start_time or ""))
    past_jobs.sort(key=lambda j: (j.scheduled_date, j.start_time or ""), reverse=True)

    # Build visit data
    def visit_to_dict(j: Job) -> dict:
        property_name = ""
        if j.property:
            property_name = j.property.name
        return {
            "id": j.id,
            "title": j.title,
            "scheduled_date": j.scheduled_date,
            "start_time": j.start_time,
            "end_time": j.end_time,
            "status": j.status,
            "job_type": j.job_type or "residential",
            "property_name": property_name,
            "gcal_event_id": j.gcal_event_id,
            "calendar_invite_sent": j.calendar_invite_sent,
            "address": j.address,
        }

    profile["upcoming_visits"] = [visit_to_dict(j) for j in upcoming_jobs]
    profile["past_visits"] = [visit_to_dict(j) for j in past_jobs]

    # Calculate visit stats
    total_jobs = len(client.jobs)
    completed_jobs = sum(1 for j in client.jobs if j.status == "completed")
    upcoming_count = len(upcoming_jobs)
    cancelled_count = sum(1 for j in client.jobs if j.status == "cancelled")
    gcal_synced = sum(1 for j in client.jobs if j.gcal_event_id)
    invites_sent = sum(1 for j in client.jobs if j.calendar_invite_sent)

    profile["visit_stats"] = {
        "total": total_jobs,
        "completed": completed_jobs,
        "upcoming": upcoming_count,
        "cancelled": cancelled_count,
        "gcal_synced": gcal_synced,
        "invites_sent": invites_sent,
    }

    return profile


@router.get("/{client_id}/crm-summary")
def get_client_crm_summary(client_id: int, db: Session = Depends(get_db)):
    """
    Get complete CRM view of client with all relationships:
    opportunities, quotes, invoices, messages, activities, and contacts.
    """
    client = db.query(Client).options(
        joinedload(Client.opportunities),
        joinedload(Client.quotes),
        joinedload(Client.invoices),
        joinedload(Client.messages),
        joinedload(Client.activities),
        joinedload(Client.contact_emails),
        joinedload(Client.contact_phones),
        joinedload(Client.jobs),
    ).filter(Client.id == client_id).first()

    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    base = client_to_dict(client)

    # Add lifecycle and contact info. lifecycle_stage is derived from the
    # client's opportunities — Opportunity.stage is the single source of truth
    # for pipeline state. Any won opportunity → "customer"; any opportunity at
    # all → "opportunity"; otherwise the client is still a fresh lead.
    has_won = any((o.stage or "").lower() == "won" for o in client.opportunities)
    if has_won:
        derived_lifecycle = "customer"
    elif client.opportunities:
        derived_lifecycle = "opportunity"
    else:
        derived_lifecycle = "new"
    base.update({
        "client_type": _derive_property_type(client),
        "lifecycle_stage": derived_lifecycle,
        "source_detail": client.source_detail,
        "email_verified": client.email_verified,
        "last_contacted_at": client.last_contacted_at.isoformat() if client.last_contacted_at else None,
    })

    # Pipeline summary
    opps_by_stage = {}
    total_pipeline = 0.0
    for opp in client.opportunities:
        stage = opp.stage or "new"
        if stage not in opps_by_stage:
            opps_by_stage[stage] = {"count": 0, "value": 0.0}
        opps_by_stage[stage]["count"] += 1
        opps_by_stage[stage]["value"] += opp.amount or 0.0
        total_pipeline += opp.amount or 0.0

    base["pipeline"] = {
        "by_stage": opps_by_stage,
        "total_value": total_pipeline,
        "opportunities_count": len(client.opportunities),
    }

    # Financial summary
    quotes_sent = sum(1 for q in client.quotes if q.status in ("sent", "viewed", "accepted"))
    quotes_accepted = sum(1 for q in client.quotes if q.status == "accepted")
    invoices_issued = len(client.invoices)
    invoices_paid = sum(1 for i in client.invoices if i.status == "paid")
    total_invoiced = sum(i.total for i in client.invoices)
    total_paid = sum(i.total for i in client.invoices if i.status == "paid")

    base["financial"] = {
        "quotes_sent": quotes_sent,
        "quotes_accepted": quotes_accepted,
        "invoices_issued": invoices_issued,
        "invoices_paid": invoices_paid,
        "total_invoiced": total_invoiced,
        "total_paid": total_paid,
        "outstanding": total_invoiced - total_paid,
    }

    # Messages summary
    emails_sent = sum(1 for m in client.messages if m.channel == "email" and m.direction == "outbound")
    emails_received = sum(1 for m in client.messages if m.channel == "email" and m.direction == "inbound")
    sms_sent = sum(1 for m in client.messages if m.channel == "sms" and m.direction == "outbound")
    sms_received = sum(1 for m in client.messages if m.channel == "sms" and m.direction == "inbound")

    base["communications"] = {
        "emails_sent": emails_sent,
        "emails_received": emails_received,
        "sms_sent": sms_sent,
        "sms_received": sms_received,
        "total_messages": len(client.messages),
    }

    # Contact methods
    base["contact_emails"] = [
        {"email": ce.email, "is_primary": ce.is_primary, "verified": ce.verified_at is not None}
        for ce in client.contact_emails
    ]
    base["contact_phones"] = [
        {"phone": cp.phone, "is_primary": cp.is_primary, "type": cp.phone_type}
        for cp in client.contact_phones
    ]

    # Recent activity timeline
    recent_activities = sorted(client.activities, key=lambda a: a.created_at, reverse=True)[:10]
    base["recent_activity"] = [
        {
            "id": a.id,
            "activity_type": a.activity_type,
            "summary": a.summary,
            "actor": a.actor,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in recent_activities
    ]

    return base


@router.patch("/{client_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_client(client_id: int, data: ClientUpdate, db: Session = Depends(get_db),
                  current_user: User = Depends(get_current_user), org_id: int = Depends(current_org_id)):
    client = db.query(Client).filter(
        Client.id == client_id,
        or_(Client.org_id == org_id, Client.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    updates = data.model_dump(exclude_none=True)
    client.updated_by = getattr(current_user, "id", None)  # audit actor
    _normalize_client_fields(updates, existing_city=client.city)
    phone_changed = "phone" in updates and updates["phone"] and updates["phone"] != client.phone
    new_phone = updates.get("phone") if phone_changed else None

    # Enrich with extracted data if email changed. Best-effort: enrichment is a
    # convenience (suggest name / source from the email domain) and must never
    # block the user's save — a hiccup here used to surface as a 500.
    email_changed = "email" in updates and updates["email"] != client.email
    if email_changed:
        try:
            client_data = client_to_dict(client)
            client_data.update(updates)
            enriched = enrich_client_data(client_data)
            # Add enriched data to updates (name, first_name, last_name, source_detail)
            for key in ['name', 'first_name', 'last_name', 'source_detail']:
                if key in enriched and enriched[key] != client_data.get(key):
                    updates[key] = enriched[key]
        except Exception:
            logger.exception("[update_client %s] email enrichment failed; saving without it", client_id)

    for field, value in updates.items():
        setattr(client, field, value)
    # Re-derive name if first/last were updated
    if "first_name" in updates or "last_name" in updates:
        derived = _derive_name(client.first_name, client.last_name, client.name)
        if derived:
            client.name = derived

    # Persist the field changes FIRST, in their own transaction. The phone /
    # SMS-thread linking below is a side-effect that touches many other tables
    # and has historically been the source of edge-case failures (e.g. the
    # (client_id, channel) unique index during a merge). It must not be able to
    # lose the user's edit — so we commit the core update before attempting it.
    db.commit()
    db.refresh(client)

    # Side-effect: mirror the primary phone into ContactPhone and link/merge any
    # existing SMS threads for this number. Best-effort and fully isolated — if
    # it throws, the save still stands; we log and move on rather than 500.
    if new_phone:
        try:
            # Guard against a stale side-effect. The core update committed in its
            # own transaction above, so a concurrent request could have committed
            # a *different* phone in between. Lock the client row FOR UPDATE and
            # hold it through the promotion + commit, so the canonical-phone check
            # and the is_primary writes are ATOMIC w.r.t. another phone update —
            # otherwise a newer request could promote its phone in the window
            # between our re-read and our writes, leaving a stale number primary
            # (Codex review follow-up). On SQLite with_for_update is a no-op, which
            # is fine since it isn't concurrent.
            # populate_existing() is essential: without it the query returns the
            # already-loaded `client` instance from the session identity map
            # WITHOUT overwriting its attributes, so locked.phone would still hold
            # this request's (possibly stale) value rather than the freshly-locked
            # row's. populate_existing() forces the row's committed values into the
            # instance so the canonical-phone check is real (Codex review).
            locked = (
                db.query(Client).filter(Client.id == client_id)
                .populate_existing().with_for_update().first()
            )
            if locked and locked.phone != new_phone:
                logger.info(
                    "[update_client %s] phone changed before side-effect ran (canonical=%r, expected=%r); skipping primary promotion",
                    client_id, locked.phone, new_phone,
                )
                db.commit()  # release the row lock; nothing to change
            elif locked:
                existing_cp = db.query(ContactPhone).filter(
                    ContactPhone.client_id == client_id,
                    ContactPhone.phone == new_phone
                ).first()
                if not existing_cp:
                    db.query(ContactPhone).filter(ContactPhone.client_id == client_id).update({"is_primary": False})
                    cp = ContactPhone(
                        client_id=client_id,
                        phone=new_phone,
                        is_primary=True,
                        phone_type="mobile",
                        source="manual",
                    )
                    db.add(cp)
                else:
                    db.query(ContactPhone).filter(ContactPhone.client_id == client_id).update({"is_primary": False})
                    existing_cp.is_primary = True
                db.flush()
                _link_and_merge_conversations(db, client_id, new_phone)
                db.commit()
        except Exception:
            logger.exception("[update_client %s] phone link/merge side-effect failed; phone saved, threads not relinked", client_id)
            db.rollback()

    db.refresh(client)
    return client_to_dict(client)


class ClientMergeRequest(BaseModel):
    loser_id: int


@router.post("/{winner_id}/merge", dependencies=[Depends(require_role("admin", "manager"))])
def merge_clients(winner_id: int, body: ClientMergeRequest, db: Session = Depends(get_db)):
    """Collapse a duplicate: merge `loser_id` INTO `winner_id`.

    Re-parents every record the loser owns onto the winner — jobs, invoices,
    properties, recurring schedules, opportunities, lead intakes, activities,
    messages, SMS conversations (folded so the (client_id, channel) unique index
    can't blow up), and contact phones/emails (deduped) — backfills the winner's
    empty contact fields from the loser, then deletes the loser.

    Quotes are intentionally NOT touched: that table's client_id is a UUID column
    (the quoting system is UUID-based and decoupled from the integer Client
    table), so it never references an integer client id.
    """
    loser_id = body.loser_id
    if loser_id == winner_id:
        raise HTTPException(status_code=400, detail="Cannot merge a client into itself")
    winner = db.query(Client).filter(Client.id == winner_id).first()
    loser = db.query(Client).filter(Client.id == loser_id).first()
    if not winner:
        raise HTTPException(status_code=404, detail="Winner client not found")
    if not loser:
        raise HTTPException(status_code=404, detail="Loser client not found")

    report = {"linked_conversations": 0, "linked_messages": 0, "merged_conversations": 0}

    # 1. Backfill the winner's empty contact fields from the loser.
    for f in ("first_name", "last_name", "email", "phone", "phone_tail", "address",
              "city", "state", "zip_code", "billing_address", "billing_city",
              "billing_state", "billing_zip", "notes", "source"):
        if not getattr(winner, f, None) and getattr(loser, f, None):
            setattr(winner, f, getattr(loser, f))
    derived = _derive_name(winner.first_name, winner.last_name, winner.name)
    if derived:
        winner.name = derived

    # 1b. Preserve the loser's CONFLICTING phone/email. The backfill above only
    # fills fields the winner left empty, so when both records have different
    # values the loser's would be lost when it's deleted (create_client stores
    # contact details only on Client, not as ContactPhone/ContactEmail rows, so
    # the relationship-moving loops below can't rescue them). Keep them as the
    # winner's secondary contact rows (Codex review).
    if loser.phone and loser.phone != winner.phone:
        if loser.phone not in {cp.phone for cp in winner.contact_phones}:
            db.add(ContactPhone(
                client_id=winner_id, phone=loser.phone,
                phone_tail=getattr(loser, "phone_tail", None) or _phone_tail(loser.phone),
                is_primary=False, phone_type="mobile", source="merge",
            ))
    if loser.email and (loser.email or "").lower() != (winner.email or "").lower():
        if loser.email.lower() not in {(ce.email or "").lower() for ce in winner.contact_emails}:
            db.add(ContactEmail(
                client_id=winner_id, email=loser.email, is_primary=False, source="merge",
            ))

    # 2. Conversations — fold respecting the (client_id, channel) unique index.
    keepers_by_channel = {
        c.channel: c for c in db.query(Conversation).filter(Conversation.client_id == winner_id).all()
    }
    for conv in list(loser.conversations):
        _attach_conv_to_client(db, conv, winner, keepers_by_channel, report)

    # 3. Messages tied directly to the loser.
    for msg in list(loser.messages):
        msg.client = winner
        report["linked_messages"] += 1

    # 4. Contact phones / emails — move, deduping on the literal value.
    existing_phones = {cp.phone for cp in winner.contact_phones}
    for cp in list(loser.contact_phones):
        if cp.phone in existing_phones:
            db.delete(cp)
        else:
            cp.client = winner
            existing_phones.add(cp.phone)
    existing_emails = {ce.email for ce in winner.contact_emails}
    for ce in list(loser.contact_emails):
        if ce.email in existing_emails:
            db.delete(ce)
        else:
            ce.client = winner
            existing_emails.add(ce.email)

    # 5. A client-user link (rare) — move to the winner if free, else detach so
    #    deleting the loser can't trip the FK / one-user-per-client uniqueness.
    loser_user = db.query(User).filter(User.client_id == loser_id).first()
    if loser_user:
        winner_has_user = db.query(User).filter(User.client_id == winner_id).first() is not None
        loser_user.client_id = None if winner_has_user else winner_id

    db.flush()

    # 6. Bulk re-parent the unconstrained integer-FK tables (direct UPDATE — no
    #    ORM cascade, so the rows move rather than getting delete-orphaned).
    for Model in (Job, Invoice, Property, RecurringSchedule, Opportunity, Activity, LeadIntake):
        db.query(Model).filter(Model.client_id == loser_id).update(
            {Model.client_id: winner_id}, synchronize_session=False
        )

    db.commit()

    # 7. Delete the now-empty loser. Re-fetch fresh first so no stale in-session
    #    collection makes the cascade delete a row we just moved.
    db.expire_all()
    loser = db.query(Client).filter(Client.id == loser_id).first()
    if loser:
        db.delete(loser)
        db.commit()

    winner = db.query(Client).filter(Client.id == winner_id).first()
    return {
        "merged_into": winner_id,
        "deleted_client": loser_id,
        **report,
        "client": client_to_dict(winner),
    }


@router.delete("/{client_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_client(client_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    client = db.query(Client).filter(
        Client.id == client_id,
        or_(Client.org_id == org_id, Client.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    db.delete(client)
    db.commit()


@router.get("/{client_id}/phones", response_model=List[ContactPhoneRead])
def get_client_phones(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    phones = db.query(ContactPhone).filter(ContactPhone.client_id == client_id).all()
    return [_phone_to_dict(p) for p in phones]


@router.post("/{client_id}/phones", response_model=ContactPhoneCreateResponse, dependencies=[Depends(require_role("admin", "manager"))])
def add_client_phone(client_id: int, data: ContactPhoneCreate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    existing = db.query(ContactPhone).filter(
        ContactPhone.client_id == client_id,
        ContactPhone.phone == data.phone
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="Phone already exists")

    phone = ContactPhone(
        client_id=client_id,
        phone=data.phone,
        is_primary=data.is_primary,
        phone_type=data.phone_type,
        source="manual",
    )
    if data.is_primary or not client.phone:
        db.query(ContactPhone).filter(ContactPhone.client_id == client_id).update({"is_primary": False})
        phone.is_primary = True
        client.phone = data.phone
    db.add(phone)
    db.flush()

    # Retroactively link any existing SMS threads for this phone number to this client
    link_report = _link_and_merge_conversations(db, client_id, data.phone)

    db.commit()
    db.refresh(phone)
    return {**_phone_to_dict(phone), "linked": link_report}


@router.post("/{client_id}/relink-conversations", dependencies=[Depends(require_role("admin", "manager"))])
def relink_conversations(client_id: int, db: Session = Depends(get_db)):
    """
    Re-run linking/merging of SMS threads for this client based on all their phone numbers.
    Useful for fixing clients with unlinked SMS threads after adding phone numbers.
    """
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    combined_report = {"linked_conversations": 0, "linked_messages": 0, "merged_conversations": 0}
    phones = [client.phone] if client.phone else []
    phones += [p.phone for p in db.query(ContactPhone).filter(ContactPhone.client_id == client_id).all()]
    phones = [p for p in phones if p]

    for ph in set(phones):
        rep = _link_and_merge_conversations(db, client_id, ph)
        for k in combined_report:
            combined_report[k] += rep[k]

    db.commit()
    return combined_report


class ClientNoteRequest(BaseModel):
    body: str


@router.post("/{client_id}/notes", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def add_client_note(
    client_id: int,
    data: ClientNoteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Jot an internal note on a client. Recorded as a NOTE_ADDED activity so it
    lands in the client's unified timeline — works even when there's no SMS/email
    conversation to hang a note off of (the old /conversations/{id}/notes path
    required one)."""
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    body = (data.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="Note body is required")

    from utils.activity_logger import log_activity
    from database.models import ActivityType
    from modules.activities.router import activity_to_dict

    actor = getattr(current_user, "email", None) or getattr(current_user, "full_name", None) or "staff"
    act = log_activity(
        db, ActivityType.NOTE_ADDED.value,
        client_id=client_id, actor=actor, summary=body,
        extra_data={"note": True}, commit=False,
    )
    if not act:
        raise HTTPException(status_code=500, detail="Could not record note")
    # Commit here (not via the logger's swallowed commit) so a write failure
    # surfaces as a 500 instead of a false "Note added".
    db.commit()
    db.refresh(act)
    return activity_to_dict(act)


@router.patch("/{client_id}/phones/{phone_id}", response_model=ContactPhoneRead, dependencies=[Depends(require_role("admin", "manager"))])
def update_client_phone(client_id: int, phone_id: int, data: ContactPhoneUpdate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    phone = db.query(ContactPhone).filter(
        ContactPhone.id == phone_id,
        ContactPhone.client_id == client_id
    ).first()
    if not phone:
        raise HTTPException(status_code=404, detail="Phone not found")

    if data.phone:
        existing = db.query(ContactPhone).filter(
            ContactPhone.client_id == client_id,
            ContactPhone.phone == data.phone,
            ContactPhone.id != phone_id
        ).first()
        if existing:
            raise HTTPException(status_code=409, detail="Phone already exists")
        phone.phone = data.phone

    if data.is_primary is not None:
        if data.is_primary:
            db.query(ContactPhone).filter(ContactPhone.client_id == client_id).update({"is_primary": False})
            phone.is_primary = True
            client.phone = phone.phone
        else:
            phone.is_primary = False

    if data.phone_type is not None:
        phone.phone_type = data.phone_type

    db.commit()
    db.refresh(phone)
    return _phone_to_dict(phone)


@router.delete("/{client_id}/phones/{phone_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_client_phone(client_id: int, phone_id: int, db: Session = Depends(get_db)):
    phone = db.query(ContactPhone).filter(
        ContactPhone.id == phone_id,
        ContactPhone.client_id == client_id
    ).first()
    if not phone:
        raise HTTPException(status_code=404, detail="Phone not found")
    db.delete(phone)
    db.commit()


def _parse_address(raw: str):
    """Parse 'Street, City, State ZIP' into components. Best-effort."""
    if not raw:
        return {"address": "", "city": "", "state": "", "zip_code": ""}
    raw = raw.strip()
    # Extract zip
    zip_match = re.search(r'\b(\d{5})\b', raw)
    zip_code = zip_match.group(1) if zip_match else ""
    if zip_match:
        raw = raw[:zip_match.start()].strip().rstrip(",").strip()
    # Extract state (2-letter at end or 'Maine'/'ME')
    state_match = re.search(r',?\s*(Maine|ME)\s*$', raw, re.IGNORECASE)
    state = "ME" if state_match else ""
    if state_match:
        raw = raw[:state_match.start()].strip()
    # Remaining: "Street, City" â split on last comma
    parts = [p.strip() for p in raw.rsplit(",", 1)]
    if len(parts) == 2:
        return {"address": parts[0], "city": parts[1], "state": state, "zip_code": zip_code}
    return {"address": parts[0], "city": "", "state": state, "zip_code": zip_code}


@router.post("/cleanup", dependencies=[Depends(require_role("admin", "manager"))])
def cleanup_clients(db: Session = Depends(get_db)):
    """
    Data cleanup endpoint: audit clients, backfill first/last names,
    flag SMS placeholders, and identify test records.
    Does NOT delete anything â returns a report + applies safe fixes.
    """
    clients = db.query(Client).all()
    report = {
        "total": len(clients),
        "names_backfilled": 0,
        "sms_placeholders": [],
        "test_records": [],
        "missing_email": 0,
        "missing_phone": 0,
        "fixes_applied": [],
    }

    TEST_PATTERNS = {"test", "asdf", "sample", "demo", "xxx"}

    for c in clients:
        # 1. Backfill first_name / last_name from name if not set
        if c.name and (not c.first_name and not c.last_name):
            parts = c.name.strip().split()
            if len(parts) >= 2 and not c.name.startswith("+"):
                c.first_name = parts[0]
                c.last_name = " ".join(parts[1:])
                report["names_backfilled"] += 1
                report["fixes_applied"].append(
                    f"Client #{c.id} '{c.name}': set first_name='{c.first_name}', last_name='{c.last_name}'"
                )
            elif len(parts) == 1 and not c.name.startswith("+"):
                c.first_name = parts[0]
                report["names_backfilled"] += 1
                report["fixes_applied"].append(
                    f"Client #{c.id} '{c.name}': set first_name='{c.first_name}'"
                )

        # 2. Flag SMS placeholders (name looks like a phone number)
        if c.name and (c.name.startswith("+") or c.name.replace("-", "").replace("(", "").replace(")", "").replace(" ", "").isdigit()):
            report["sms_placeholders"].append({
                "id": c.id, "name": c.name, "phone": c.phone, "status": c.status
            })

        # 3. Flag test/junk records
        if c.name and any(t in c.name.lower() for t in TEST_PATTERNS):
            report["test_records"].append({
                "id": c.id, "name": c.name, "status": c.status
            })

        # 4. Count missing contact info
        if not c.email:
            report["missing_email"] += 1
        if not c.phone:
            report["missing_phone"] += 1

    db.commit()
    return report


@router.post("/import-xlsx", dependencies=[Depends(require_role("admin", "manager"))])
async def import_clients_xlsx(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import clients from an Excel (.xlsx) file exported from Connecteam or similar."""
    try:
        import openpyxl
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl not installed on server")

    content = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(content))
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return {"added": 0, "skipped": 0, "errors": []}

    headers = [str(h).strip() if h else "" for h in rows[0]]

    # Support both "Client Name" and "name" column headers
    def col(row, *names):
        for n in names:
            if n in headers:
                v = row[headers.index(n)]
                return str(v).strip() if v else ""
        return ""

    SKIP_NAMES = {"storage unit", "miscellaneous", "sandra"}
    existing = {c.name.lower() for c in db.query(Client).all()}

    added, skipped, errors = 0, 0, []
    seen_in_file = set()

    for row in rows[1:]:
        name = col(row, "Client Name", "name")
        if not name or name.lower() in SKIP_NAMES:
            continue
        if name.lower() in seen_in_file:
            continue
        seen_in_file.add(name.lower())

        if name.lower() in existing:
            skipped += 1
            continue

        raw_addr = col(row, "Address", "address")
        parsed = _parse_address(raw_addr)

        try:
            client = Client(
                name=name,
                address=parsed["address"] or None,
                city=parsed["city"] or None,
                state=parsed["state"] or None,
                zip_code=parsed["zip_code"] or None,
                status="active",
                source="xlsx_import",
            )
            db.add(client)
            existing.add(name.lower())
            added += 1
        except Exception as e:
            errors.append({"name": name, "error": str(e)})

    db.commit()
    return {"added": added, "skipped": skipped, "errors": errors}


# ---------------------------------------------------------------------------
# Cleanup: merge placeholder-named Client rows into properly-named clients
# that share the same email. Safe — only merges where the keeper is the one
# with a real name. Default is dry_run=True so you can preview the changes.
# ---------------------------------------------------------------------------

# Re-uses _PLACEHOLDER_NAME_PATTERN-style heuristics. A name is "placeholder"
# if it's empty, "Unknown", "BrightBase Webhook Test", or looks like a phone
# number. Anything else is treated as a real customer name.
import re as _re_dedupe

_DEDUPE_PLACEHOLDER_NAME_RE = _re_dedupe.compile(
    r"^(unknown|brightbase webhook test|webhook test|test client|n/a|\+?[\d\s().\-]+)$",
    _re_dedupe.IGNORECASE,
)


def _dedupe_is_placeholder(name):
    if not name:
        return True
    s = str(name).strip()
    if not s:
        return True
    return bool(_DEDUPE_PLACEHOLDER_NAME_RE.match(s))


@router.post("/cleanup-duplicates-by-email", dependencies=[Depends(require_role("admin"))])
def cleanup_duplicates_by_email(dry_run: bool = True, db: Session = Depends(get_db)):
    """Merge placeholder-named Client rows into properly-named clients that
    share the same (case-insensitive) email. Default dry_run=true returns a
    preview without applying changes.

    Reassigns these to the keeper before deleting the placeholder:
      - leads (LeadIntake.client_id)
      - quotes (Quote.client_id)
      - jobs (Job.client_id)
      - properties (Property.client_id)
      - opportunities (Opportunity.client_id)
      - activities (Activity.client_id)
      - messages (Message.client_id)
    """
    from sqlalchemy import func as _sa_func
    from database.models import LeadIntake as _LI, Quote as _Q, Job as _J, Property as _P, Activity as _A, Message as _M

    try:
        from database.models import Opportunity as _O
    except Exception:
        _O = None

    # Group clients by lowercased email, only emails with > 1 client
    rows = (
        db.query(Client)
        .filter(Client.email.isnot(None), Client.email != "")
        .all()
    )
    by_email = {}
    for c in rows:
        key = (c.email or "").strip().lower()
        if not key:
            continue
        by_email.setdefault(key, []).append(c)

    report = {"dry_run": bool(dry_run), "merges": [], "errors": []}

    for email, group in by_email.items():
        if len(group) < 2:
            continue
        # Pick the keeper: prefer the one with a real (non-placeholder) name.
        real_named = [c for c in group if not _dedupe_is_placeholder(c.name)]
        placeholders = [c for c in group if _dedupe_is_placeholder(c.name)]
        if not real_named:
            # All look like placeholders — skip; safer not to merge.
            continue
        if not placeholders:
            # No placeholders to merge in.
            continue
        # Prefer the one with the most attached records as the keeper
        def _score(c):
            return (
                len(getattr(c, "jobs", []) or []),
                len(getattr(c, "quotes", []) or []),
                len(getattr(c, "invoices", []) or []),
                -c.id,  # tie-break: oldest id wins
            )
        keeper = max(real_named, key=_score)

        for placeholder in placeholders:
            if placeholder.id == keeper.id:
                continue
            merge_detail = {
                "email": email,
                "keeper_id": keeper.id,
                "keeper_name": keeper.name,
                "placeholder_id": placeholder.id,
                "placeholder_name": placeholder.name,
                "reassigned": {},
            }
            try:
                if not dry_run:
                    # Reassign FK rows
                    n_leads = db.query(_LI).filter(_LI.client_id == placeholder.id).update({"client_id": keeper.id})
                    n_quotes = db.query(_Q).filter(_Q.client_id == placeholder.id).update({"client_id": keeper.id})
                    n_jobs = db.query(_J).filter(_J.client_id == placeholder.id).update({"client_id": keeper.id})
                    n_props = db.query(_P).filter(_P.client_id == placeholder.id).update({"client_id": keeper.id})
                    n_acts = db.query(_A).filter(_A.client_id == placeholder.id).update({"client_id": keeper.id})
                    n_msgs = db.query(_M).filter(_M.client_id == placeholder.id).update({"client_id": keeper.id})
                    n_opps = 0
                    if _O is not None:
                        n_opps = db.query(_O).filter(_O.client_id == placeholder.id).update({"client_id": keeper.id})
                    merge_detail["reassigned"] = {
                        "leads": n_leads, "quotes": n_quotes, "jobs": n_jobs,
                        "properties": n_props, "activities": n_acts,
                        "messages": n_msgs, "opportunities": n_opps,
                    }
                    # Backfill keeper contact fields from the placeholder if missing
                    if placeholder.phone and not (keeper.phone and keeper.phone.strip()):
                        keeper.phone = placeholder.phone
                    if placeholder.address and not (keeper.address and keeper.address.strip()):
                        keeper.address = placeholder.address
                    db.flush()
                    db.delete(placeholder)
                else:
                    # Dry-run: just count what WOULD be reassigned
                    merge_detail["reassigned"] = {
                        "leads": db.query(_sa_func.count(_LI.id)).filter(_LI.client_id == placeholder.id).scalar(),
                        "quotes": db.query(_sa_func.count(_Q.id)).filter(_Q.client_id == placeholder.id).scalar(),
                        "jobs": db.query(_sa_func.count(_J.id)).filter(_J.client_id == placeholder.id).scalar(),
                        "properties": db.query(_sa_func.count(_P.id)).filter(_P.client_id == placeholder.id).scalar(),
                        "activities": db.query(_sa_func.count(_A.id)).filter(_A.client_id == placeholder.id).scalar(),
                        "messages": db.query(_sa_func.count(_M.id)).filter(_M.client_id == placeholder.id).scalar(),
                    }
                report["merges"].append(merge_detail)
            except Exception as e:
                report["errors"].append({**merge_detail, "error": str(e)})

    if not dry_run and report["merges"]:
        db.commit()

    report["merged_count"] = len(report["merges"])
    return report
