from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta, timezone
import logging

from database.db import get_db
from modules.auth.router import require_role, current_org_id, resolve_org_id
from database.models import LeadIntake, Client
from modules.intake.normalize import build_intake, upsert_lead
from ratelimit import limiter

router = APIRouter()
logger = logging.getLogger(__name__)


class IntakeSubmit(BaseModel):
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = "ME"
    zip_code: Optional[str] = None
    service_type: Optional[str] = "residential"
    # Full structured superset the website can send (the LeadIntake model has
    # columns for all of these; the schema used to silently drop most of them).
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None
    square_footage: Optional[int] = None
    guests: Optional[int] = None
    frequency: Optional[str] = None
    requested_date: Optional[str] = None
    check_in: Optional[str] = None
    check_out: Optional[str] = None
    estimate_min: Optional[float] = None
    estimate_max: Optional[float] = None
    property_name: Optional[str] = None
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

    Goes through the single canonical intake path (see modules.intake.normalize):
    every structured field is persisted, the estimate is computed, and a visit
    that also hits /booking/submit or /webhook within 5 minutes merges into one
    lead instead of creating duplicates.
    """
    payload = build_intake(
        name=data.name, email=data.email, phone=data.phone, address=data.address,
        city=data.city, state=data.state, zip_code=data.zip_code,
        service_key=data.service_type, bedrooms=data.bedrooms,
        bathrooms=data.bathrooms, square_footage=data.square_footage,
        guests=data.guests, frequency=data.frequency,
        requested_date=data.requested_date, check_in=data.check_in,
        check_out=data.check_out, estimate_min=data.estimate_min,
        estimate_max=data.estimate_max, property_name=data.property_name,
        message=data.message, preferred_date=data.preferred_date, source=data.source,
    )
    return upsert_lead(db, payload)


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def get_intakes(
    status: Optional[str] = None,
    source: Optional[str] = None,
    service_type: Optional[str] = None,
    priority: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """List intakes with filtering by status, source, service_type, priority."""
    # MT-2: scope to the caller's workspace; tolerate legacy + public-submitted
    # NULL-org leads (the contact form has no logged-in user).
    q = db.query(LeadIntake).filter(or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)))
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
def update_intake(intake_id: int, data: IntakeUpdate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
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
def delete_intake(intake_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")
    db.delete(intake)
    db.commit()
    return {"success": True}



@router.post("/{intake_id}/convert-to-quote", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def convert_intake_to_quote(intake_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Convert an intake to a quote with sensible defaults."""
    from database.models import Quote

    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
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

    # Carry the customer's structured request onto a Property so the quote (and
    # later the job) start from real data instead of re-typing. Reuse an existing
    # property at the same address; otherwise create one and back-fill size.
    from database.models import Property
    prop = None
    if intake.address:
        prop = (
            db.query(Property)
            .filter(Property.client_id == client_id, Property.address == intake.address)
            .first()
        )
    if prop:
        if intake.bedrooms and not prop.bedrooms:
            prop.bedrooms = intake.bedrooms
        if intake.bathrooms and not prop.bathrooms:
            prop.bathrooms = intake.bathrooms
        if intake.square_footage and not prop.square_footage:
            prop.square_footage = intake.square_footage
    else:
        prop = Property(
            client_id=client_id,
            name=intake.property_name or intake.address or f"{intake.name}'s property",
            address=intake.address or address or "(no address on file)",
            city=intake.city,
            state=intake.state,
            zip_code=intake.zip_code,
            property_type=intake.service_type or "residential",
            bedrooms=intake.bedrooms,
            bathrooms=intake.bathrooms,
            square_footage=intake.square_footage,
        )
        db.add(prop)
        db.flush()

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
        property_id=prop.id,
        org_id=intake.org_id or resolve_org_id(org_id, db),  # MT-2: inherit the lead's workspace
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
    # Pipeline: advance the lead's deal to "quoted" and link the quote.
    from utils.opportunity_helper import ensure_opportunity, advance_opportunity
    opp = ensure_opportunity(
        db, client_id=client_id, org_id=intake.org_id,
        title=quote.title or (intake.service_type or "Quote"),
        amount=quote.total, service_type=intake.service_type,
    )
    if opp:
        quote.opportunity_id = opp.id
        intake.opportunity_id = opp.id
        advance_opportunity(db, opp, "quoted", amount=quote.total)
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


@router.post("/webhook", status_code=201)  # PUBLIC: maineclean.co InstantEstimate webhook posts here
@limiter.limit("30/hour")
def webhook_intake(request: Request, data: WebhookPayload, db: Session = Depends(get_db)):
    """
    Accepts the maineclean.co InstantEstimate payload OR CRM-forward payload.

    Maps the webhook's field names onto the canonical intake path, which computes
    the authoritative backend estimate (so the website and webhook can never
    disagree on the rate card). The customer's structured answers land in their
    own columns; ``message`` keeps only the free-text note. Any drift from the
    site-reported estimate is recorded in internal_notes for ops to review.
    """
    if not data.name and not data.email and not data.phone:
        return {"success": False, "error": "No contact info provided"}

    service_key = data.serviceType or data.service or data.propertyType or ""
    sqft = data.sqft or data.squareFeet
    notes_text = data.notes or data.message or ""

    payload = build_intake(
        name=data.name, email=data.email, phone=data.phone, address=data.address,
        zip_code=data.zip, service_key=service_key, bathrooms=data.bathrooms,
        square_footage=sqft, frequency=data.frequency, message=notes_text or None,
        source=data.source or "website",
        pet_hair=data.petHair, condition=data.condition,
    )
    result = upsert_lead(db, payload)

    # Record drift between the site's reported estimate and our canonical one so
    # ops can spot a stale rate card on the website — without polluting message.
    site_min, site_max = data.estimateMin, data.estimateMax
    if (
        not result.get("deduped")
        and payload.estimate_min is not None and payload.estimate_max is not None
        and site_min and site_max
        and (abs(float(site_min) - float(payload.estimate_min)) > 10
             or abs(float(site_max) - float(payload.estimate_max)) > 10)
    ):
        intake = db.query(LeadIntake).filter(LeadIntake.id == result["intake_id"]).first()
        if intake:
            intake.internal_notes = (
                f"Site reported ${site_min:.0f}-${site_max:.0f} vs canonical "
                f"${payload.estimate_min:.0f}-${payload.estimate_max:.0f} (review pricing)"
            )
            db.commit()
    return result
