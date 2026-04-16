import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, date

from database.db import get_db
from database.models import Invoice, Client, Message

router = APIRouter()


class InvoiceItem(BaseModel):
    name: str
    description: Optional[str] = ""
    qty: float = 1
    unit_price: float


class InvoiceCreate(BaseModel):
    client_id: int
    job_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    items: List[InvoiceItem]
    tax_rate: Optional[float] = 0
    due_date: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = {}


class InvoiceUpdate(BaseModel):
    items: Optional[List[InvoiceItem]] = None
    tax_rate: Optional[float] = None
    status: Optional[str] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None
    paid_at: Optional[str] = None
    custom_fields: Optional[dict] = None


def next_invoice_number(db: Session) -> str:
    count = db.query(Invoice).count()
    return f"INV-{str(count + 1).zfill(4)}"


def calc_totals(items: list, tax_rate: float) -> tuple:
    subtotal = sum(i["qty"] * i["unit_price"] for i in items)
    tax = round(subtotal * (tax_rate / 100), 2)
    return round(subtotal, 2), tax, round(subtotal + tax, 2)


def invoice_to_dict(inv: Invoice) -> dict:
    return {
        "id": inv.id,
        "client_id": inv.client_id,
        "job_id": inv.job_id,
        "opportunity_id": inv.opportunity_id,
        "invoice_number": inv.invoice_number,
        "items": inv.items,
        "subtotal": inv.subtotal,
        "tax_rate": inv.tax_rate,
        "tax": inv.tax,
        "total": inv.total,
        "status": inv.status,
        "due_date": inv.due_date,
        "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
        "notes": inv.notes,
        "custom_fields": inv.custom_fields or {},
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
        "updated_at": inv.updated_at.isoformat() if inv.updated_at else None,
    }


@router.get("")
def get_invoices(
    client_id: Optional[int] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Invoice)
    if client_id:
        q = q.filter(Invoice.client_id == client_id)
    if status:
        q = q.filter(Invoice.status == status)
    return [invoice_to_dict(i) for i in q.order_by(Invoice.created_at.desc()).all()]


@router.post("", status_code=201)
def create_invoice(data: InvoiceCreate, db: Session = Depends(get_db)):
    items = [i.model_dump() for i in data.items]
    subtotal, tax, total = calc_totals(items, data.tax_rate or 0)
    inv = Invoice(
        client_id=data.client_id,
        job_id=data.job_id,
        opportunity_id=data.opportunity_id,
        invoice_number=next_invoice_number(db),
        items=items,
        subtotal=subtotal,
        tax_rate=data.tax_rate or 0,
        tax=tax,
        total=total,
        due_date=data.due_date,
        notes=data.notes,
        custom_fields=data.custom_fields or {},
    )
    db.add(inv)
    db.commit()
    db.refresh(inv)
    return invoice_to_dict(inv)


@router.get("/{invoice_id}")
def get_invoice(invoice_id: int, db: Session = Depends(get_db)):
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice_to_dict(inv)


@router.patch("/{invoice_id}")
def update_invoice(invoice_id: int, data: InvoiceUpdate, db: Session = Depends(get_db)):
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if data.items is not None:
        items = [i.model_dump() for i in data.items]
        tax_rate = data.tax_rate if data.tax_rate is not None else inv.tax_rate
        subtotal, tax, total = calc_totals(items, tax_rate)
        inv.items = items
        inv.subtotal = subtotal
        inv.tax = tax
        inv.total = total
    for field in ["tax_rate", "status", "due_date", "notes", "custom_fields"]:
        val = getattr(data, field)
        if val is not None:
            setattr(inv, field, val)
    if data.paid_at:
        inv.paid_at = datetime.fromisoformat(data.paid_at)
        inv.status = "paid"
    db.commit()
    db.refresh(inv)
    return invoice_to_dict(inv)


@router.delete("/{invoice_id}", status_code=204)
def delete_invoice(invoice_id: int, db: Session = Depends(get_db)):
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    db.delete(inv)
    db.commit()


class SendInvoiceRequest(BaseModel):
    channel: str                        # "email" | "sms" | "both"
    email: Optional[str] = None
    phone: Optional[str] = None
    custom_message: Optional[str] = None


@router.post("/{invoice_id}/send")
def send_invoice(invoice_id: int, data: SendInvoiceRequest, db: Session = Depends(get_db)):
    """Send an invoice to a client via email and/or SMS."""
    from integrations.email import send_email, build_invoice_email, build_invoice_sms
    from integrations.twilio_client import send_sms

    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    client = db.query(Client).filter(Client.id == inv.client_id).first()
    client_name = client.name if client else f"Client #{inv.client_id}"
    inv_dict = invoice_to_dict(inv)
    inv_num = inv.invoice_number
    company_phone = os.getenv("TWILIO_PHONE_NUMBER", "")
    results = {}

    if data.channel in ("email", "both"):
        to_email = data.email or (client.email if client else None)
        if not to_email:
            raise HTTPException(status_code=400, detail="No email address available")
        html, plain = build_invoice_email(inv_dict, client_name, company_phone)
        try:
            send_email(to=to_email, subject=f"Invoice {inv_num} — Maine Cleaning Co", html_body=html, text_body=plain)
            results["email"] = "sent"
            msg = Message(client_id=inv.client_id, channel="email", direction="outbound",
                          from_addr=os.getenv("SMTP_USER", ""), to_addr=to_email,
                          body=f"Invoice {inv_num} sent via email", status="sent")
            db.add(msg)
        except Exception as e:
            results["email"] = f"failed: {str(e)}"

    if data.channel in ("sms", "both"):
        to_phone = data.phone or (client.phone if client else None)
        if not to_phone:
            raise HTTPException(status_code=400, detail="No phone number available")
        sms_body = build_invoice_sms(inv_dict, client_name, company_phone)
        if data.custom_message:
            sms_body = data.custom_message + "\n\n" + sms_body
        try:
            send_sms(to=to_phone, body=sms_body)
            results["sms"] = "sent"
            msg = Message(client_id=inv.client_id, channel="sms", direction="outbound",
                          from_addr=company_phone, to_addr=to_phone, body=sms_body, status="sent")
            db.add(msg)
        except Exception as e:
            results["sms"] = f"failed: {str(e)}"

    # Mark as sent if it was draft
    if inv.status == "draft":
        inv.status = "sent"
    db.commit()

    return {"invoice_id": invoice_id, "results": results}
