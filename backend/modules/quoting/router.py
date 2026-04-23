from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
import os
import secrets

from database.db import get_db
from database.models import Quote, Job, LeadIntake, Client, Message, Activity, ActivityType
from modules.auth.router import require_role

router = APIRouter()


class QuoteItem(BaseModel):
    name: str
    description: Optional[str] = ""
    qty: float = 1
    unit_price: float


class QuoteCreate(BaseModel):
    client_id: int
    intake_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    address: Optional[str] = None
    service_type: Optional[str] = "residential"
    items: List[QuoteItem]
    tax_rate: Optional[float] = 0
    notes: Optional[str] = None
    custom_fields: Optional[dict] = {}
    valid_until: Optional[str] = None


class QuoteUpdate(BaseModel):
    address: Optional[str] = None
    service_type: Optional[str] = None
    items: Optional[List[QuoteItem]] = None
    tax_rate: Optional[float] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = None
    valid_until: Optional[str] = None
    status: Optional[str] = None


def calc_totals(items: list, tax_rate: float) -> tuple:
    subtotal = sum(i["qty"] * i["unit_price"] for i in items)
    tax = round(subtotal * (tax_rate / 100), 2)
    total = round(subtotal + tax, 2)
    return round(subtotal, 2), tax, total


def next_quote_number(db: Session) -> str:
    count = db.query(Quote).count()
    return f"QT-{str(count + 1).zfill(4)}"


def quote_to_dict(q: Quote) -> dict:
    return {
        "id": q.id,
        "client_id": q.client_id,
        "intake_id": q.intake_id,
        "opportunity_id": q.opportunity_id,
        "quote_number": q.quote_number,
        "address": q.address,
        "service_type": q.service_type,
        "items": q.items,
        "subtotal": q.subtotal,
        "tax_rate": q.tax_rate,
        "tax": q.tax,
        "total": q.total,
        "status": q.status,
        "notes": q.notes,
        "custom_fields": q.custom_fields or {},
        "valid_until": q.valid_until,
        "public_token": q.public_token,
        "accepted_at": q.accepted_at.isoformat() if q.accepted_at else None,
        "created_at": q.created_at.isoformat() if q.created_at else None,
        "updated_at": q.updated_at.isoformat() if q.updated_at else None,
    }


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_quotes(client_id: Optional[int] = None, status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(Quote)
    if client_id:
        q = q.filter(Quote.client_id == client_id)
    if status:
        q = q.filter(Quote.status == status)
    return [quote_to_dict(x) for x in q.order_by(Quote.created_at.desc()).all()]


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_quote(data: QuoteCreate, db: Session = Depends(get_db)):
    items = [i.model_dump() for i in data.items]
    subtotal, tax, total = calc_totals(items, data.tax_rate or 0)
    quote = Quote(
        client_id=data.client_id,
        intake_id=data.intake_id,
        opportunity_id=data.opportunity_id,
        quote_number=next_quote_number(db),
        address=data.address,
        service_type=data.service_type,
        items=items,
        subtotal=subtotal,
        tax_rate=data.tax_rate or 0,
        tax=tax,
        total=total,
        notes=data.notes,
        custom_fields=data.custom_fields or {},
        valid_until=data.valid_until,
    )
    db.add(quote)
    # Mark intake as quoted
    if data.intake_id:
        intake = db.query(LeadIntake).filter(LeadIntake.id == data.intake_id).first()
        if intake:
            intake.status = "quoted"
    db.commit()
    db.refresh(quote)
    return quote_to_dict(quote)


@router.get("/{quote_id}", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_quote(quote_id: int, db: Session = Depends(get_db)):
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote_to_dict(quote)


@router.patch("/{quote_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_quote(quote_id: int, data: QuoteUpdate, db: Session = Depends(get_db)):
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    if data.items is not None:
        items = [i.model_dump() for i in data.items]
        tax_rate = data.tax_rate if data.tax_rate is not None else quote.tax_rate
        subtotal, tax, total = calc_totals(items, tax_rate)
        quote.items = items
        quote.subtotal = subtotal
        quote.tax = tax
        quote.total = total
    for field in ["tax_rate", "notes", "valid_until", "status", "address", "service_type", "custom_fields"]:
        val = getattr(data, field)
        if val is not None:
            setattr(quote, field, val)
    db.commit()
    db.refresh(quote)
    return quote_to_dict(quote)


class SendQuoteRequest(BaseModel):
    channel: str                        # "email" | "sms" | "both"
    email: Optional[str] = None
    phone: Optional[str] = None
    custom_message: Optional[str] = None


@router.post("/{quote_id}/send")
def send_quote(quote_id: int, data: SendQuoteRequest, db: Session = Depends(get_db)):
    """Send a quote to a client via email and/or SMS."""
    from integrations.email import send_email, build_quote_email, build_quote_sms
    from integrations.twilio_client import send_sms

    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if not quote.public_token:
        quote.public_token = secrets.token_urlsafe(32)
        db.flush()

    client = db.query(Client).filter(Client.id == quote.client_id).first()
    client_name = client.name if client else "Valued Customer"
    company_phone = os.getenv("TWILIO_PHONE_NUMBER", "")
    app_url = os.getenv("APP_URL", "https://maineclean.co")

    q_dict = quote_to_dict(quote)
    public_url = f"{app_url}/quote/{quote.public_token}"
    results = {}

    if data.channel in ("email", "both"):
        to_email = data.email or (client.email if client else None)
        if not to_email:
            raise HTTPException(status_code=400, detail="No email address available")
        html, plain = build_quote_email(q_dict, client_name, company_phone, public_url)
        q_num = quote.quote_number or f"QT-{quote.id}"
        try:
            send_email(to=to_email, subject=f"Your Quote from Maine Cleaning Co — {q_num}", html_body=html, text_body=plain)
            results["email"] = "sent"
            msg = Message(client_id=quote.client_id, channel="email", direction="outbound",
                          from_addr=os.getenv("SMTP_USER", ""), to_addr=to_email,
                          subject=f"Quote {q_num}", body=plain, status="sent")
            db.add(msg)
        except Exception as e:
            results["email"] = f"failed: {str(e)}"

    if data.channel in ("sms", "both"):
        to_phone = data.phone or (client.phone if client else None)
        if not to_phone:
            raise HTTPException(status_code=400, detail="No phone number available")
        sms_body = build_quote_sms(q_dict, client_name, company_phone, public_url)
        if data.custom_message:
            sms_body = data.custom_message + "\n\n" + sms_body
        try:
            send_sms(to=to_phone, body=sms_body)
            results["sms"] = "sent"
            msg = Message(client_id=quote.client_id, channel="sms", direction="outbound",
                          from_addr=company_phone, to_addr=to_phone, body=sms_body, status="sent")
            db.add(msg)
        except Exception as e:
            results["sms"] = f"failed: {str(e)}"

    if any(v == "sent" for v in results.values()):
        quote.status = "sent"

    db.commit()
    return {"quote_id": quote_id, "results": results, "status": quote.status}


@router.post("/{quote_id}/convert-to-job", status_code=201)
def convert_to_job(quote_id: int, db: Session = Depends(get_db)):
    """Convert an accepted quote into a scheduled job. Links quote → job for revenue traceability."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    job = Job(
        client_id=quote.client_id,
        quote_id=quote.id,  # Persist the source quote for revenue tracking
        job_type=quote.service_type or "residential",
        title=f"Clean — {quote.quote_number or f'QT-{quote.id}'}",
        address=quote.address or "",
        scheduled_date="",  # user sets this when editing the job
        start_time="09:00",
        end_time="12:00",
        status="scheduled",
        notes=quote.notes,
    )
    db.add(job)

    # Mark quote as converted
    quote.status = "converted"

    # Mark intake as converted if linked
    if quote.intake_id:
        intake = db.query(LeadIntake).filter(LeadIntake.id == quote.intake_id).first()
        if intake:
            intake.status = "converted"

    db.commit()
    db.refresh(job)
    from modules.scheduling.router import job_to_dict
    return job_to_dict(job)


@router.delete("/{quote_id}", status_code=204)
def delete_quote(quote_id: int, db: Session = Depends(get_db)):
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    db.delete(quote)
    db.commit()


@router.post("/{quote_id}/generate-token")
def generate_public_token(quote_id: int, db: Session = Depends(get_db)):
    """Generate or return existing public token for a quote."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if quote.public_token:
        return {"public_token": quote.public_token, "quote_id": quote_id}

    token = secrets.token_urlsafe(32)
    quote.public_token = token
    db.commit()
    return {"public_token": token, "quote_id": quote_id}


@router.get("/public/{token}")
def get_public_quote(token: str, db: Session = Depends(get_db)):
    """Fetch a quote by public token (no auth required). Tracks first view."""
    from datetime import datetime

    quote = db.query(Quote).filter(Quote.public_token == token).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    # Track first view
    if not quote.viewed_at:
        quote.viewed_at = datetime.utcnow()
        quote.status = "viewed"
        db.commit()

    client = db.query(Client).filter(Client.id == quote.client_id).first()
    q_dict = quote_to_dict(quote)
    q_dict["company_name"] = os.getenv("FROM_NAME", "Maine Cleaning Co")
    q_dict["company_email"] = os.getenv("SMTP_USER", "")
    q_dict["company_phone"] = os.getenv("TWILIO_PHONE_NUMBER", "")
    return q_dict


class AcceptQuoteRequest(BaseModel):
    pass


@router.post("/public/{token}/accept")
def accept_public_quote(token: str, data: AcceptQuoteRequest, request: Request, db: Session = Depends(get_db)):
    """Accept a quote via public token (no auth required). Creates a Job."""
    from datetime import datetime

    quote = db.query(Quote).filter(Quote.public_token == token).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if quote.accepted_at:
        raise HTTPException(status_code=409, detail="This quote was already accepted")

    if quote.status in ("rejected", "expired"):
        raise HTTPException(status_code=409, detail="This quote is no longer available for acceptance")

    client_ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "")

    quote.status = "accepted"
    quote.accepted_at = datetime.utcnow()
    quote.accepted_ip = client_ip

    job = Job(
        client_id=quote.client_id,
        quote_id=quote.id,
        job_type=quote.service_type or "residential",
        title=f"Clean — {quote.quote_number or f'QT-{quote.id}'}",
        address=quote.address or "",
        scheduled_date="",
        start_time="09:00",
        end_time="12:00",
        status="scheduled",
        notes=quote.notes,
    )
    db.add(job)

    activity = Activity(
        client_id=quote.client_id,
        activity_type=ActivityType.QUOTE_ACCEPTED,
        summary=f"Quote {quote.quote_number or f'QT-{quote.id}'} accepted via public link",
        extra_data={"quote_id": quote.id, "accepted_ip": client_ip},
    )
    db.add(activity)

    db.commit()
    db.refresh(job)

    from modules.scheduling.router import job_to_dict
    return {
        "job_id": job.id,
        "scheduled_status": "needs_date",
        "job": job_to_dict(job),
    }
