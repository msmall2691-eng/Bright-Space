from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta, timezone
import logging
import re

from database.db import get_db
from modules.auth.router import require_role
from database.models import LeadIntake, Client, Opportunity, Activity
from utils.contacts import find_client_by_contact, normalize_phone
from ratelimit import limiter

router = APIRouter()
logger = logging.getLogger(__name__)


# Names we treat as placeholders that should be overwritten when a real
# website lead lands on the same client record. Without this, every fresh
# lead whose email matches a generic test/import client keeps that client's
# old name in the Quoting dropdown.
_PLACEHOLDER_NAMES = (
    "brightbase webhook test",
    "test client",
    "unknown",
    "(unknown)",
    "n/a",
    "",
)


def _looks_placeholder_name(name: Optional[str]) -> bool:
    if not name:
        return True
    n = name.strip().lower()
    if n in _PLACEHOLDER_NAMES:
        return True
    # All-digits / phone-only "names" (e.g. "+12075551234")
    if re.fullmatch(r"\+?\d[\d\s().-]{5,}", n):
        return True
    return False


class IntakeSubmit(BaseModel):
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = "ME"
    zip_code: Optional[str] = None
    service_type: Optional[str] = "residential"
    bedrooms: Optional[int] = None
    square_footage: Optional[int] = None
    message: Optional[str] = None
    preferred_date: Optional[str] = None
    source: Optional[str] = "website"


class IntakeUpdate(BaseModel):
    status: Optional[str] = None
    client_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    priority: Optional[str] = None
    assigned_to: Optional[str] = None
    internal_notes: Optional[str] = None
    custom_fields: Optional[dict] = None
    followed_up_at: Optional[str] = None  # ISO datetime string


def intake_to_dict(i: LeadIntake) -> dict:
    return {
        "id": i.id,
        "name": i.name,
        "email": i.email,
        "phone": i.phone,
        "address": i.address,
        "city": i.city,
        "state": i.state,
        "zip_code": i.zip_code,
        "service_type": i.service_type,
        "bedrooms": i.bedrooms,
        "bathrooms": getattr(i, "bathrooms", None),
        "square_footage": i.square_footage,
        "guests": getattr(i, "guests", None),
        "frequency": getattr(i, "frequency", None),
        "requested_date": getattr(i, "requested_date", None),
        "check_in": getattr(i, "check_in", None),
        "check_out": getattr(i, "check_out", None),
        "estimate_min": getattr(i, "estimate_min", None),
        "estimate_max": getattr(i, "estimate_max", None),
        "property_name": getattr(i, "property_name", None),
        "message": i.message,
        "preferred_date": i.preferred_date,
        "source": i.source,
        "status": i.status,
        "priority": getattr(i, "priority", "normal"),
        "assigned_to": getattr(i, "assigned_to", None),
        "internal_notes": getattr(i, "internal_notes", None),
        "custom_fields": getattr(i, "custom_fields", None) or {},
        "followed_up_at": getattr(i, "followed_up_at", None).isoformat() if getattr(i, "followed_up_at", None) else None,
        "client_id": i.client_id,
        "opportunity_id": getattr(i, "opportunity_id", None),
        "created_at": i.created_at.isoformat() if i.created_at else None,
    }


@router.post("/submit", status_code=201)  # PUBLIC: leads from maineclean.co contact form
@limiter.limit("30/hour")
def submit_intake(request: Request, data: IntakeSubmit, db: Session = Depends(get_db)):
    """Public endpoint — called from maineclean.co contact/quote form.

    Idempotency: if the same email/phone submitted an intake within the
    last 5 minutes, return that intake instead of creating a duplicate.
    The maineclean.co site is observed to call both /submit and /webhook
    in rapid succession for a single user click.
    """
    normalized_phone = normalize_phone(data.phone)
    name_in = (data.name or "").strip()
    email_in = (data.email or "").strip() or None

    # --- Idempotency window ---------------------------------------------------
    if email_in or normalized_phone:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
        dup_q = db.query(LeadIntake).filter(LeadIntake.created_at >= cutoff)
        dup_filters = []
        if email_in:
            dup_filters.append(LeadIntake.email.ilike(email_in))
        if normalized_phone:
            dup_filters.append(LeadIntake.phone == normalized_phone)
        if dup_filters:
            recent = dup_q.filter(or_(*dup_filters)).order_by(LeadIntake.created_at.desc()).first()
            if recent:
                changed = False
                merge_fields = [
                    ("address", data.address),
                    ("city", data.city),
                    ("zip_code", data.zip_code),
                    ("service_type", data.service_type),
                    ("bedrooms", data.bedrooms),
                    ("square_footage", data.square_footage),
                    ("preferred_date", data.preferred_date),
                ]
                for field, val in merge_fields:
                    if val and not getattr(recent, field, None):
                        setattr(recent, field, val)
                        changed = True
                if data.message and (not recent.message or len(data.message) > len(recent.message or "")):
                    recent.message = data.message
                    changed = True
                if changed:
                    db.commit()
                    db.refresh(recent)
                return {
                    "success": True,
                    "intake_id": recent.id,
                    "client_id": recent.client_id,
                    "deduped": True,
                }

    # --- Client match / create -----------------------------------------------
    client = find_client_by_contact(db, email=email_in, phone=normalized_phone)

    if not client:
        client = Client(
            name=name_in or "Unknown",
            email=email_in,
            phone=normalized_phone,
            address=data.address,
            city=data.city,
            state=data.state or "ME",
            zip_code=data.zip_code,
            status="lead",
            source=data.source or "website",
        )
        db.add(client)
        db.flush()  # get client.id without committing
    else:
        # We matched an existing client. If the existing record looks like a
        # placeholder (e.g. "BrightBase Webhook Test", a bare phone number,
        # "Unknown"), overwrite the name with the real lead's name so the
        # Quoting dropdown and Send Quote modal show the right person.
        if name_in and _looks_placeholder_name(client.name):
            client.name = name_in
        # Backfill missing contact fields so future lookups still match.
        if email_in and not client.email:
            client.email = email_in
        if normalized_phone and not client.phone:
            client.phone = normalized_phone
        if data.address and not client.address:
            client.address = data.address

    intake = LeadIntake(
        name=name_in or client.name,
        email=email_in,
        phone=normalized_phone,
        address=data.address,
        city=data.city,
        state=data.state or "ME",
        zip_code=data.zip_code,
        service_type=data.service_type or "residential",
        bedrooms=data.bedrooms,
        square_footage=data.square_footage,
        message=data.message,
        preferred_date=data.preferred_date,
        source=data.source or "website",
        client_id=client.id,
    )
    db.add(intake)
    db.commit()
    db.refresh(intake)
    return {"success": True, "intake_id": intake.id, "client_id": client.id}


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def get_intakes(
    status: Optional[str] = None,
    source: Optional[str] = None,
    service_type: Optional[str] = None,
    priority: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """List intakes with filtering by status, source, service_type, priority."""
    q = db.query(LeadIntake)
    if status:
        q = q.filter(LeadIntake.status == status)
    if source:
        q = q.filter(LeadIntake.source == source)
    if service_type:
        q = q.filter(LeadIntake.service_type == service_type)
    if priority:
        q = q.filter(LeadIntake.priority == priority)
    return [intake_to_dict(i) for i in q.order_by(LeadIntake.created_at.desc()).offset(offset).limit(limit).all()]


@router.get("/stats", dependencies=[Depends(require_role("admin", "manager"))])
def get_intake_stats(db: Session = Depends(get_db)):
    """Quick counts for the requests dashboard."""
    total = db.query(func.count(LeadIntake.id)).scalar()
    new = db.query(func.count(LeadIntake.id)).filter(LeadIntake.status == "new").scalar()
    reviewed = db.query(func.count(LeadIntake.id)).filter(LeadIntake.status == "reviewed").scalar()
    quoted = db.query(func.count(LeadIntake.id)).filter(LeadIntake.status == "quoted").scalar()
    converted = db.query(func.count(LeadIntake.id)).filter(LeadIntake.status == "converted").scalar()
    archived = db.query(func.count(LeadIntake.id)).filter(LeadIntake.status == "archived").scalar()
    urgent = db.query(func.count(LeadIntake.id)).filter(
        LeadIntake.priority == "urgent",
        LeadIntake.status.in_(["new", "reviewed"])
    ).scalar()
    return {
        "total": total,
        "new": new,
        "reviewed": reviewed,
        "quoted": quoted,
        "converted": converted,
        "archived": archived,
        "urgent": urgent,
    }


@router.patch("/{intake_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_intake(intake_id: int, data: IntakeUpdate, db: Session = Depends(get_db)):
    intake = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")
    updates = data.model_dump(exclude_none=True)
    # Convert followed_up_at string to datetime
    if "followed_up_at" in updates and updates["followed_up_at"]:
        try:
            updates["followed_up_at"] = datetime.fromisoformat(updates["followed_up_at"])
        except (ValueError, TypeError):
            updates["followed_up_at"] = datetime.now(timezone.utc)
    for field, value in updates.items():
        setattr(intake, field, value)
    db.commit()
    db.refresh(intake)
    return intake_to_dict(intake)


@router.delete("/{intake_id}", dependencies=[Depends(require_role("admin", "manager"))])
def delete_intake(intake_id: int, db: Session = Depends(get_db)):
    intake = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")
    db.delete(intake)
    db.commit()
    return {"success": True}



@router.post("/{intake_id}/convert-to-quote", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def convert_intake_to_quote(intake_id: int, db: Session = Depends(get_db)):
    """Convert an intake to a quote with sensible defaults."""
    from database.models import Quote

    intake = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")

    client_id = intake.client_id
    if not client_id:
        client = Client(
            name=intake.name,
            email=intake.email,
            phone=intake.phone,
            address=intake.address,
            city=intake.city,
            state=intake.state,
            zip_code=intake.zip_code,
            status="lead",
            source=intake.source,
        )
        db.add(client)
        db.flush()
        client_id = client.id

    address = " ".join(filter(None, [intake.address, intake.city, intake.state, intake.zip_code]))

    # Seed the first line item's price from the website "instant quote" estimate
    # (midpoint of the range) so the operator starts from the customer's number
    # instead of $0.
    est = None
    if intake.estimate_min is not None and intake.estimate_max is not None:
        est = round((intake.estimate_min + intake.estimate_max) / 2, 2)
    elif intake.estimate_max is not None:
        est = intake.estimate_max
    elif intake.estimate_min is not None:
        est = intake.estimate_min
    unit_price = float(est or 0)
    tax_rate = 5.5
    subtotal = round(unit_price, 2)
    tax = round(subtotal * tax_rate / 100, 2)
    total = round(subtotal + tax, 2)

    import secrets
    from modules.quoting.router import _assign_quote_number, _quote_dict

    quote = Quote(
        client_id=client_id,
        intake_id=intake_id,
        # Temporary unique placeholder; replaced with QT-YYYY-#### after flush.
        quote_number=f"PENDING-{secrets.token_hex(8)}",
        address=address or None,
        service_type=intake.service_type or "residential",
        items=[{
            "name": f"{(intake.service_type or 'residential').title()} Cleaning",
            "qty": 1,
            "unit_price": unit_price,
            "description": "Estimated from website instant quote" if est else "",
        }],
        subtotal=subtotal,
        tax_rate=tax_rate,
        tax=tax,
        total=total,
        status="draft",
        notes=intake.message or "",
        valid_until=None,
    )
    db.add(quote)
    db.flush()
    _assign_quote_number(quote)
    intake.status = "quoted"
    intake.converted_quote_id = quote.id
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


# ---------------------------------------------------------------------------
# Webhook endpoint - accepts the maineclean.co InstantEstimate payload format
# Set CRM_WEBHOOK_URL=https://your-brightbase-backend.com/api/intake/webhook
# ---------------------------------------------------------------------------

class WebhookPayload(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    zip: Optional[str] = None
    serviceType: Optional[str] = None
    frequency: Optional[str] = None
    sqft: Optional[int] = None
    bathrooms: Optional[float] = None
    petHair: Optional[str] = None
    condition: Optional[str] = None
    estimateMin: Optional[float] = None
    estimateMax: Optional[float] = None
    notes: Optional[str] = None
    source: Optional[str] = "website"
    service: Optional[str] = None
    squareFeet: Optional[int] = None
    message: Optional[str] = None
    propertyType: Optional[str] = None
    class Config:
        extra = "allow"


SERVICE_TYPE_MAP = {
    "standard": "residential",
    "deep": "residential",
    "move-in-out": "residential",
    "str": "str",
    "vacation-rental": "str",
    "commercial": "commercial",
    "residential": "residential",
}


@router.post("/webhook", status_code=201)  # PUBLIC: maineclean.co InstantEstimate webhook posts here
@limiter.limit("30/hour")
def webhook_intake(request: Request, data: WebhookPayload, db: Session = Depends(get_db)):
    """
    Accepts the maineclean.co InstantEstimate payload OR CRM-forward payload.
    Computes the canonical backend estimate so ops always sees the
    authoritative number, and flags any drift from the site's reported value.
    """
    if not data.name and not data.email and not data.phone:
        return {"success": False, "error": "No contact info provided"}

    service_key = data.serviceType or data.service or data.propertyType or ""
    sqft = data.sqft or data.squareFeet
    notes_text = data.notes or data.message or ""
    service_type = SERVICE_TYPE_MAP.get(service_key, "residential")

    parts = []
    if service_key:
        parts.append(f"Service: {service_key}")
    if data.frequency:
        parts.append(f"Frequency: {data.frequency}")
    if sqft:
        parts.append(f"Sq ft: {sqft}")
    if data.bathrooms:
        parts.append(f"Bathrooms: {data.bathrooms}")
    if data.petHair and data.petHair != "none":
        parts.append(f"Pet hair: {data.petHair}")
    if data.condition:
        parts.append(f"Condition: {data.condition}")

    # Compute the canonical backend estimate so ops always sees the authoritative
    # number - even if the maineclean.co site's pricing math has drifted.
    canonical_min = canonical_max = None
    try:
        from modules.booking.pricing import estimate_price
        canonical_min, canonical_max = estimate_price(
            service_type=service_key or "residential",
            sqft=sqft,
            bathrooms=data.bathrooms,
            frequency=data.frequency,
            pet_hair=data.petHair,
            condition=data.condition,
        )
    except Exception as e:
        logger.warning("Canonical estimate computation failed: %s", e)
        canonical_min = canonical_max = None

    site_min, site_max = data.estimateMin, data.estimateMax
    if canonical_min is not None and canonical_max is not None:
        parts.append(f"Canonical estimate: ${canonical_min:.0f}-${canonical_max:.0f}")
        if site_min and site_max and (
            abs(float(site_min) - float(canonical_min)) > 10
            or abs(float(site_max) - float(canonical_max)) > 10
        ):
            parts.append(f"Site reported: ${site_min:.0f}-${site_max:.0f} (review pricing)")
    elif site_min and site_max:
        parts.append(f"Estimate: ${site_min:.0f}-${site_max:.0f}")

    if notes_text:
        parts.append(f"Notes: {notes_text}")
    message = " | ".join(parts) if parts else notes_text

    normalized = IntakeSubmit(
        name=data.name or "Unknown",
        email=data.email,
        phone=data.phone,
        address=data.address,
        zip_code=data.zip,
        service_type=service_type,
        square_footage=sqft,
        message=message,
        source=data.source or "website",
    )
    return submit_intake(normalized, db)
