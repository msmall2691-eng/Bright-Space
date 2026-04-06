from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.db import get_db
from database.models import LeadIntake, Client

router = APIRouter()


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
        "client_id": i.client_id,
        "created_at": i.created_at.isoformat() if i.created_at else None,
    }


@router.post("/submit", status_code=201)
def submit_intake(data: IntakeSubmit, db: Session = Depends(get_db)):
    """Public endpoint — called from maineclean.co contact/quote form."""
    # Check if client already exists by email or phone
    client = None
    if data.email:
        client = db.query(Client).filter(Client.email == data.email).first()
    if not client and data.phone:
        client = db.query(Client).filter(Client.phone == data.phone).first()

    # Create client if new
    if not client:
        client = Client(
            name=data.name,
            email=data.email,
            phone=data.phone,
            address=data.address,
            city=data.city,
            state=data.state or "ME",
            zip_code=data.zip_code,
            status="lead",
            source=data.source or "website",
        )
        db.add(client)
        db.flush()  # get client.id without committing

    intake = LeadIntake(
        name=data.name,
        email=data.email,
        phone=data.phone,
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


@router.get("")
def get_intakes(status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(LeadIntake)
    if status:
        q = q.filter(LeadIntake.status == status)
    return [intake_to_dict(i) for i in q.order_by(LeadIntake.created_at.desc()).all()]


@router.patch("/{intake_id}")
def update_intake(intake_id: int, data: IntakeUpdate, db: Session = Depends(get_db)):
    intake = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(intake, field, value)
    db.commit()
    db.refresh(intake)
    return intake_to_dict(intake)


# ---------------------------------------------------------------------------
# Webhook endpoint — accepts the maineclean.co InstantEstimate payload format
# Set CRM_WEBHOOK_URL=https://your-brightbase-backend.com/api/intake/webhook
# ---------------------------------------------------------------------------

class WebhookPayload(BaseModel):
    # Contact
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    zip: Optional[str] = None
    # Service details (website format)
    serviceType: Optional[str] = None   # standard/deep/str/vacation-rental/commercial/move-in-out
    frequency: Optional[str] = None
    sqft: Optional[int] = None
    bathrooms: Optional[float] = None
    petHair: Optional[str] = None
    condition: Optional[str] = None
    estimateMin: Optional[float] = None
    estimateMax: Optional[float] = None
    notes: Optional[str] = None
    source: Optional[str] = "website"
    # Allow any extra fields
    class Config:
        extra = "allow"


SERVICE_TYPE_MAP = {
    "standard": "residential",
    "deep": "residential",
    "move-in-out": "residential",
    "str": "str",
    "vacation-rental": "str",
    "commercial": "commercial",
}


@router.post("/webhook", status_code=201)
def webhook_intake(data: WebhookPayload, db: Session = Depends(get_db)):
    """
    Accepts the maineclean.co InstantEstimate payload.
    Set CRM_WEBHOOK_URL to https://<your-brightbase>/api/intake/webhook
    """
    if not data.name and not data.email and not data.phone:
        return {"success": False, "error": "No contact info provided"}

    service_type = SERVICE_TYPE_MAP.get(data.serviceType or "", "residential")

    # Build a message summary from the estimate details
    parts = []
    if data.serviceType:
        parts.append(f"Service: {data.serviceType}")
    if data.frequency:
        parts.append(f"Frequency: {data.frequency}")
    if data.sqft:
        parts.append(f"Sq ft: {data.sqft}")
    if data.bathrooms:
        parts.append(f"Bathrooms: {data.bathrooms}")
    if data.petHair and data.petHair != "none":
        parts.append(f"Pet hair: {data.petHair}")
    if data.condition:
        parts.append(f"Condition: {data.condition}")
    if data.estimateMin and data.estimateMax:
        parts.append(f"Estimate: ${data.estimateMin:.0f}–${data.estimateMax:.0f}")
    if data.notes:
        parts.append(f"Notes: {data.notes}")
    message = " | ".join(parts) if parts else data.notes or ""

    normalized = IntakeSubmit(
        name=data.name or "Unknown",
        email=data.email,
        phone=data.phone,
        address=data.address,
        zip_code=data.zip,
        service_type=service_type,
        square_footage=data.sqft,
        message=message,
        source=data.source or "website",
    )
    return submit_intake(normalized, db)
