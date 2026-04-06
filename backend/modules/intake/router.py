from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

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
    priority: Optional[str] = None
    assigned_to: Optional[str] = None
    internal_notes: Optional[str] = None
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
        "followed_up_at": getattr(i, "followed_up_at", None).isoformat() if getattr(i, "followed_up_at", None) else None,
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
def get_intakes(status: Optional[str] = None, source: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(LeadIntake)
    if status:
        q = q.filter(LeadIntake.status == status)
    if source:
        q = q.filter(LeadIntake.source == source)
    return [intake_to_dict(i) for i in q.order_by(LeadIntake.created_at.desc()).all()]


@router.get("/stats")
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


@router.patch("/{intake_id}")
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
            updates["followed_up_at"] = datetime.utcnow()
    for field, value in updates.items():
        setattr(intake, field, value)
    db.commit()
    db.refresh(intake)
    return intake_to_dict(intake)


@router.delete("/{intake_id}")
def delete_intake(intake_id: int, db: Session = Depends(get_db)):
    intake = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")
    db.delete(intake)
    db.commit()
    return {"success": True}


# ---------------------------------------------------------------------------
# Webhook endpoint — accepts the maineclean.co InstantEstimate payload format
# Set CRM_WEBHOOK_URL=https://your-brightbase-backend.com/api/intake/webhook
# ---------------------------------------------------------------------------

class WebhookPayload(BaseModel):
