from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session, joinedload, selectinload
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, date
import io
import re

from database.db import get_db
from database.models import Client, Property, Job, ICalEvent, Opportunity, Quote, Invoice, Message, Activity, ContactPhone, ContactEmail, Conversation
from utils.phone import digits_only as _digits_only, phone_tail as _phone_tail
from utils.enrichment import enrich_client_data

router = APIRouter()


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

    for cid in candidates:
        placeholder = db.query(Client).filter(Client.id == cid).first()
        if not placeholder or not _is_placeholder_candidate(placeholder):
            continue

        # Re-parent each relationship using the relationship setter
        for conv in list(placeholder.conversations):
            conv.client = real
            report["linked_conversations"] += 1
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

    # 2. Link orphan conversations to this client
    for conv in candidates:
        if conv.client_id is None:
            conv.client_id = client_id
            report["linked_conversations"] += 1
            # Also relink orphan messages in that conversation (no extra queries — already eager-loaded)
            for msg in conv.messages:
                if msg.client_id is None:
                    msg.client_id = client_id
                    report["linked_messages"] += 1

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
            # Move all messages from dup into keeper.
            # Use the relationship (not the FK column) so SQLAlchemy updates
            # both sides of the collection — otherwise the cascade="all,
            # delete-orphan" on Conversation.messages will delete the messages
            # along with `dup` because they still appear in dup.messages.
            for msg in list(dup.messages):
                msg.conversation = keeper
            db.flush()
            # Merge unread counts
            keeper.unread_count = (keeper.unread_count or 0) + (dup.unread_count or 0)
            # Use most recent activity timestamps
            if dup.last_message_at and (not keeper.last_message_at or dup.last_message_at > keeper.last_message_at):
                keeper.last_message_at = dup.last_message_at
            if dup.last_inbound_at and (not keeper.last_inbound_at or dup.last_inbound_at > keeper.last_inbound_at):
                keeper.last_inbound_at = dup.last_inbound_at
            if dup.last_outbound_at and (not keeper.last_outbound_at or dup.last_outbound_at > keeper.last_outbound_at):
                keeper.last_outbound_at = dup.last_outbound_at
            # Keep the open status if any conversation is open
            if dup.status == "open" and keeper.status == "resolved":
                keeper.status = "open"
                keeper.resolved_at = None
            # Merge tags
            if dup.tags:
                keeper.tags = list(set((keeper.tags or []) + dup.tags))
            db.delete(dup)
            report["merged_conversations"] += 1

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
    status: Optional[str] = None
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


class ContactEmailCreate(BaseModel):
    email: str
    is_primary: Optional[bool] = False


class ContactEmailUpdate(BaseModel):
    email: Optional[str] = None
    is_primary: Optional[bool] = None


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
    }


@router.get("")
def get_clients(status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(Client)
    if status:
        q = q.filter(Client.status == status)
    return [client_to_dict(c) for c in q.order_by(Client.created_at.desc()).all()]


@router.post("", status_code=201)
def create_client(data: ClientCreate, db: Session = Depends(get_db)):
    payload = data.model_dump()
    # Enrich with extracted data from email, name, etc.
    payload = enrich_client_data(payload)
    payload["name"] = _derive_name(payload.get("first_name"), payload.get("last_name"), payload.get("name") or "")
    if not payload["name"]:
        raise HTTPException(status_code=422, detail="name or first_name required")
    client = Client(**payload)
    db.add(client)
    db.commit()
    db.refresh(client)
    return client_to_dict(client)


@router.get("/{client_id}")
def get_client(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client_to_dict(client)


@router.get("/{client_id}/profile")
def get_client_profile(client_id: int, db: Session = Depends(get_db)):
    """
    Get client's full profile including properties, upcoming/past visits, and GCal sync status.
    """
    client = db.query(Client).options(
        joinedload(Client.properties).joinedload(Property.ical_events),
        joinedload(Client.jobs)
    ).filter(Client.id == client_id).first()

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

    # Add lifecycle and contact info
    base.update({
        "client_type": client.client_type,
        "lifecycle_stage": client.lifecycle_stage,
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
    quotes_sent = sum(1 for q in client.quotes if q.status in ("sent", "accepted"))
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


@router.patch("/{client_id}")
def update_client(client_id: int, data: ClientUpdate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    updates = data.model_dump(exclude_none=True)
    phone_changed = "phone" in updates and updates["phone"] and updates["phone"] != client.phone
    new_phone = updates.get("phone") if phone_changed else None

    # Enrich with extracted data if email changed
    email_changed = "email" in updates and updates["email"] != client.email
    if email_changed:
        client_data = client_to_dict(client)
        client_data.update(updates)
        enriched = enrich_client_data(client_data)
        # Add enriched data to updates (name, first_name, last_name, source_detail)
        for key in ['name', 'first_name', 'last_name', 'source_detail']:
            if key in enriched and enriched[key] != client_data.get(key):
                updates[key] = enriched[key]

    for field, value in updates.items():
        setattr(client, field, value)
    # Re-derive name if first/last were updated
    if "first_name" in updates or "last_name" in updates:
        derived = _derive_name(client.first_name, client.last_name, client.name)
        if derived:
            client.name = derived

    # If primary phone changed, mirror it in ContactPhone and backfill conversations
    if new_phone:
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
    db.refresh(client)
    return client_to_dict(client)


@router.delete("/{client_id}", status_code=204)
def delete_client(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    db.delete(client)
    db.commit()


@router.get("/{client_id}/phones")
def get_client_phones(client_id: int, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    phones = db.query(ContactPhone).filter(ContactPhone.client_id == client_id).all()
    return [
        {
            "id": p.id,
            "phone": p.phone,
            "is_primary": p.is_primary,
            "phone_type": p.phone_type,
            "source": p.source,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in phones
    ]


@router.post("/{client_id}/phones")
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
    return {
        "id": phone.id,
        "phone": phone.phone,
        "is_primary": phone.is_primary,
        "phone_type": phone.phone_type,
        "source": phone.source,
        "created_at": phone.created_at.isoformat() if phone.created_at else None,
        "linked": link_report,
    }


@router.post("/{client_id}/relink-conversations")
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


@router.patch("/{client_id}/phones/{phone_id}")
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
    return {
        "id": phone.id,
        "phone": phone.phone,
        "is_primary": phone.is_primary,
        "phone_type": phone.phone_type,
        "source": phone.source,
        "created_at": phone.created_at.isoformat() if phone.created_at else None,
    }


@router.delete("/{client_id}/phones/{phone_id}", status_code=204)
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


@router.post("/cleanup")
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


@router.post("/import-xlsx")
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
