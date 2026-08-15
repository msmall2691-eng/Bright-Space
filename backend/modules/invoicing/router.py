import hashlib
import hmac
import os
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List, Literal
from datetime import datetime, date, timezone

from database.db import get_db
from database.models import Invoice, Client, Message
from modules.auth.router import require_role, current_org_id, resolve_org_id
from utils.activity_logger import log_invoice_created, log_invoice_paid


def _invoice_public_token(invoice_id: int) -> str:
    secret = os.getenv("JWT_SECRET", "fallback-for-dev-only")
    return hmac.new(secret.encode(), f"inv-{invoice_id}".encode(), hashlib.sha256).hexdigest()[:16]

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
    status: Optional[Literal["draft", "sent", "paid", "overdue", "void"]] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None
    paid_at: Optional[str] = None
    custom_fields: Optional[dict] = None


def assign_invoice_number(db: Session, inv: Invoice) -> str:
    """Assign a race-free invoice number derived from the row's own primary key.

    The old `max(Invoice.id)+1` raced two concurrent creates onto the same
    number (unique-violation 500) and was a single global counter. The PK is
    unique and monotonic, so deriving from it is collision-free — the same
    approach the quote numbering already uses. Idempotent (never overwrites an
    existing number); flushes to materialize the PK when needed.

    Every path that creates an invoice MUST call this. An unnumbered invoice
    mails the customer an email/SMS titled "Invoice None" (the auto-invoice on
    job completion skipped it — see modules/scheduling/router.py)."""
    if inv.invoice_number:
        return inv.invoice_number
    if inv.id is None:
        db.flush()
    inv.invoice_number = f"INV-{str(inv.id).zfill(4)}"
    return inv.invoice_number


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


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_invoices(
    client_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    # MT-2: scope to the caller's workspace; tolerate legacy NULL-org rows.
    q = db.query(Invoice).filter(or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)))
    if client_id:
        q = q.filter(Invoice.client_id == client_id)
    if status:
        q = q.filter(Invoice.status == status)
    return [invoice_to_dict(i) for i in q.order_by(Invoice.created_at.desc()).offset(offset).limit(limit).all()]


@router.get("/summary/by-service", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def invoice_summary_by_service(
    period: str = Query("mtd", pattern="^(mtd|all)$"),
    db: Session = Depends(get_db),
):
    """Paid-revenue split by service type (residential/commercial/str_turnover),
    joined through the invoice's job. `period=mtd` (default) limits to this month
    by paid_at; `all` is all-time. Powers the dashboard's revenue breakdown."""
    from sqlalchemy import func
    from database.models import Job
    q = (
        db.query(Job.job_type, func.count(Invoice.id), func.coalesce(func.sum(Invoice.total), 0.0))
        .join(Invoice, Invoice.job_id == Job.id)
        .filter(Invoice.status == "paid")
    )
    if period == "mtd":
        month_start = datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        q = q.filter(Invoice.paid_at >= month_start)
    rows = q.group_by(Job.job_type).all()
    return {
        "period": period,
        "by_service": [
            {"service": (jt or "residential"), "count": int(c or 0), "total": float(tot or 0)}
            for jt, c, tot in rows
        ],
    }


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_invoice(data: InvoiceCreate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    items = [i.model_dump() for i in data.items]
    subtotal, tax, total = calc_totals(items, data.tax_rate or 0)
    inv = Invoice(
        client_id=data.client_id,
        job_id=data.job_id,
        opportunity_id=data.opportunity_id,
        org_id=resolve_org_id(org_id, db),  # MT-2: stamp the caller's workspace
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
    db.flush()                      # materialize the PK
    assign_invoice_number(db, inv)  # race-free number derived from it
    db.commit()
    db.refresh(inv)
    # Timeline: record the invoice being raised (best-effort — never block the
    # create on a logging hiccup).
    try:
        log_invoice_created(db, inv)
        db.commit()
    except Exception:
        db.rollback()
    return invoice_to_dict(inv)


@router.get("/{invoice_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_invoice(invoice_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice_to_dict(inv)


@router.get("/{invoice_id}/details", dependencies=[Depends(require_role("admin", "manager"))])
def get_invoice_details(invoice_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Full invoice record for the detail page: the invoice (incl. line items)
    plus its linked records — client, job, opportunity, and the originating
    quote (reached via Job.quote_id when the invoice came from a job)."""
    from database.models import Job, Opportunity, Quote
    oid = resolve_org_id(org_id, db)
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == oid, Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    client = db.query(Client).filter(Client.id == inv.client_id).first()
    job = db.query(Job).filter(Job.id == inv.job_id).first() if inv.job_id else None
    opp = db.query(Opportunity).filter(Opportunity.id == inv.opportunity_id).first() if inv.opportunity_id else None
    quote = db.query(Quote).filter(Quote.id == job.quote_id).first() if (job and job.quote_id) else None

    return {
        **invoice_to_dict(inv),
        "client_name": client.name if client else None,
        "job": ({"id": job.id, "title": job.title, "status": job.status,
                 "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None} if job else None),
        "opportunity": ({"id": opp.id, "title": opp.title, "stage": opp.stage} if opp else None),
        "quote": ({"id": quote.id, "quote_number": quote.quote_number, "total": quote.total} if quote else None),
    }


@router.patch("/{invoice_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_invoice(invoice_id: int, data: InvoiceUpdate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    was_paid = inv.status == "paid"
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
    # Timeline: log the paid transition once (whether it came via paid_at or a
    # status="paid" edit), never on an already-paid invoice.
    if inv.status == "paid" and not was_paid:
        try:
            log_invoice_paid(db, inv)
            db.commit()
        except Exception:
            db.rollback()
    return invoice_to_dict(inv)


@router.delete("/{invoice_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
def delete_invoice(invoice_id: int, force: bool = False,
                   db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """BB-SEC-10: deleting a PAID invoice erases the payment record — the
    money trail for work already done. It used to be a plain delete with no
    server-side distinction; a paid invoice now 409s unless the caller
    explicitly passes ?force=true (the UI escalates its confirm and retries
    with force). Unpaid invoices delete as before."""
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        or_(Invoice.org_id == resolve_org_id(org_id, db), Invoice.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if not force and (inv.status or "").lower() == "paid":
        raise HTTPException(status_code=409, detail={
            "code": "invoice_paid",
            "message": "This invoice is PAID — deleting it erases the payment record.",
        })
    db.delete(inv)
    db.commit()


class SendInvoiceRequest(BaseModel):
    channel: Literal["email", "sms", "both"]
    email: Optional[str] = None
    phone: Optional[str] = None
    custom_message: Optional[str] = None


@router.post("/{invoice_id}/send", dependencies=[Depends(require_role("admin", "manager"))])
def send_invoice(invoice_id: int, data: SendInvoiceRequest, db: Session = Depends(get_db)):
    """Send an invoice to a client via email and/or SMS."""
    from integrations.email import send_email, build_invoice_email, build_invoice_sms
    from integrations.twilio_client import send_sms

    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    client = db.query(Client).filter(Client.id == inv.client_id).first()
    client_name = client.name if client else f"Client #{inv.client_id}"
    # Heal invoices auto-created without a number (older completions) so the
    # customer never receives an email/SMS titled "Invoice None". The set value
    # persists on the db.commit() at the end of this handler.
    inv_num = assign_invoice_number(db, inv)
    inv_dict = invoice_to_dict(inv)
    company_phone = os.getenv("TWILIO_PHONE_NUMBER", "")
    results = {}

    if data.channel in ("email", "both"):
        to_email = data.email or (client.email if client else None)
        if not to_email:
            raise HTTPException(status_code=400, detail="No email address available")
        html, plain = build_invoice_email(inv_dict, client_name, company_phone)
        # A custom note (e.g. an AI-drafted payment reminder) is prepended to
        # both the HTML and plain-text bodies, mirroring the SMS path below.
        if data.custom_message:
            from html import escape as _esc
            note_html = "".join(
                f"<p style=\"margin:0 0 12px\">{_esc(line)}</p>"
                for line in data.custom_message.split("\n") if line.strip()
            )
            html = note_html + html
            plain = data.custom_message + "\n\n" + plain
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


@router.get("/public/{invoice_id}/{token}")
def get_public_invoice(invoice_id: int, token: str, db: Session = Depends(get_db)):
    """Get invoice details for public payment portal (via HMAC token)."""
    expected = _invoice_public_token(invoice_id)
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=404, detail="Invalid invoice token")

    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    client = db.query(Client).filter(Client.id == inv.client_id).first()
    inv_dict = invoice_to_dict(inv)

    return {
        **inv_dict,
        "client_email": client.email if client else None,
        "client_phone": client.phone if client else None,
    }


@router.post("/{invoice_id}/pay", dependencies=[Depends(require_role("admin", "manager"))])
def process_payment(invoice_id: int, data: dict, db: Session = Depends(get_db)):
    """Record a payment for an invoice. Requires admin/manager auth.

    In production, Stripe webhooks should confirm payment server-side.
    """
    inv = db.query(Invoice).filter(Invoice.id == invoice_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    was_paid = inv.status == "paid"
    # In production, verify payment with Stripe API before marking as paid
    # For now, accept the payment and mark invoice as paid
    inv.status = "paid"
    inv.paid_at = datetime.now(timezone.utc)

    # Create a payment message record
    msg = Message(
        client_id=inv.client_id,
        channel="payment",
        direction="inbound",
        from_addr=data.get("email", ""),
        to_addr=data.get("phone", ""),
        body=f"Payment received: ${inv.total}",
        status="received",
    )
    db.add(msg)
    # Timeline: log the paid transition (once) alongside the payment message.
    if not was_paid:
        log_invoice_paid(db, inv)
    db.commit()

    return {
        "status": "success",
        "message": f"Payment of ${inv.total} received and recorded",
        "invoice_id": invoice_id,
    }
