"""FastAPI router for Quotes system."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_
from uuid import UUID
from datetime import datetime
from decimal import Decimal
from typing import List, Optional
import logging
import os
import secrets

logger = logging.getLogger(__name__)


def _ensure_public_token(quote) -> str:
    """Return the quote's public link token, generating one if missing. Used
    when sending a quote so the client can open the no-login accept page."""
    if not quote.public_token:
        quote.public_token = secrets.token_urlsafe(32)
    return quote.public_token


def _public_quote_dict(quote) -> dict:
    """Serialize a Quote for the public accept page (PublicQuote.jsx). Maps the
    DB model to the field names the page expects (items/total/tax/etc.) and
    deliberately omits anything internal."""
    items = [
        {
            "name": li.description,
            "description": li.service_type or "",
            "qty": float(li.quantity or 1),
            "unit_price": float(li.unit_price or 0),
        }
        for li in sorted(quote.line_items, key=lambda x: (x.display_order or 0))
    ]
    return {
        "id": str(quote.id),
        "quote_number": quote.quote_number,
        "status": quote.status,
        "company_name": os.getenv("COMPANY_NAME", "Bright Space"),
        "company_email": os.getenv("COMPANY_EMAIL") or os.getenv("SMTP_USER"),
        "company_phone": os.getenv("COMPANY_PHONE"),
        "address": quote.title or "",
        "service_type": None,
        "notes": quote.notes,
        "items": items,
        "subtotal": float(quote.subtotal or 0),
        "tax": float(quote.tax_amount or 0),
        "total": float(quote.total_amount or 0),
        "valid_until": quote.expires_at.strftime("%B %d, %Y") if quote.expires_at else None,
    }

from database.db import get_db
from schemas.quotes import (
    QuoteCreate, QuoteUpdate, QuoteResponse, QuoteSummary,
    QuoteLineItemCreate, QuoteLineItemUpdate, QuoteLineItemResponse,
    QuoteRequestCreate, QuoteRequestUpdate, QuoteRequestResponse
)
from database.models import Quote, QuoteLineItem, QuoteRequest, QuoteStatus, QuoteRequestStatus, QuoteEmail, Client
from modules.auth.router import require_role

router = APIRouter(tags=["quotes"])


def _app_base() -> str:
    """Public base URL for customer-facing links (quote accept pages, etc.).

    Set APP_BASE_URL to your real host. Falls back to the Railway deployment —
    NOT a custom domain, since the obvious one (bright-space.com) belongs to an
    unrelated company and would send customers to a stranger's site."""
    return os.getenv(
        "APP_BASE_URL", "https://brightbase-production.up.railway.app"
    ).rstrip("/")



# ========================
# Quote CRUD Endpoints
# ========================

@router.post("/", response_model=QuoteResponse, status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
async def create_quote(
    quote_data: QuoteCreate,
    db: Session = Depends(get_db),
):
    """Create a new quote."""
    year = datetime.now().year
    last_quote = (
        db.query(Quote)
        .order_by(Quote.created_at.desc())
        .first()
    )

    if last_quote and last_quote.quote_number.startswith(f"QT-{year}"):
        # Extract number and increment
        num = int(last_quote.quote_number.split("-")[-1])
        next_num = num + 1
    else:
        next_num = 1

    quote_number = f"QT-{year}-{next_num:04d}"

    # Calculate totals if not provided
    total = quote_data.subtotal + quote_data.tax_amount - quote_data.discount_amount

    # Create quote
    quote = Quote(
        quote_number=quote_number,
        client_id=quote_data.client_id,
        property_id=quote_data.property_id,
        created_by=UUID("00000000-0000-0000-0000-000000000000"),
        title=quote_data.title,
        description=quote_data.description,
        notes=quote_data.notes,
        subtotal=quote_data.subtotal,
        tax_amount=quote_data.tax_amount,
        discount_amount=quote_data.discount_amount,
        total_amount=total,
        preferred_day=quote_data.preferred_day,
        preferred_time=quote_data.preferred_time,
        expires_at=quote_data.expires_at,
        status=QuoteStatus.DRAFT
    )

    db.add(quote)
    db.flush()  # Get the ID without committing yet

    # Add line items if provided
    if quote_data.line_items:
        for item_data in quote_data.line_items:
            line_item = QuoteLineItem(
                quote_id=quote.id,
                **item_data.dict()
            )
            db.add(line_item)

    db.commit()
    db.refresh(quote)

    return quote


@router.get("/{quote_id}", response_model=QuoteResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def get_quote(
    quote_id: UUID,
    db: Session = Depends(get_db)
):
    """Get a specific quote by ID."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


@router.get("/", response_model=List[QuoteSummary], dependencies=[Depends(require_role("admin", "manager"))])
async def list_quotes(
    db: Session = Depends(get_db),
    client_id: Optional[UUID] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0)
):
    """List quotes with optional filters."""
    query = db.query(Quote)

    if client_id:
        query = query.filter(Quote.client_id == client_id)

    if status:
        query = query.filter(Quote.status == status)

    quotes = query.order_by(Quote.created_at.desc()).offset(offset).limit(limit).all()
    return quotes


@router.put("/{quote_id}", response_model=QuoteResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def update_quote(
    quote_id: UUID,
    quote_data: QuoteUpdate,
    db: Session = Depends(get_db)
):
    """Update a quote (only if in draft status)."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    # Only allow updates to draft quotes
    if quote.status != QuoteStatus.DRAFT:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot update quote with status '{quote.status}'. Only draft quotes can be updated."
        )

    # Update fields
    update_data = quote_data.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(quote, field, value)

    # Recalculate total if pricing changed
    if any(k in update_data for k in ["subtotal", "tax_amount", "discount_amount"]):
        quote.total_amount = quote.subtotal + quote.tax_amount - quote.discount_amount

    quote.updated_at = datetime.now()
    db.commit()
    db.refresh(quote)

    return quote


# ========================
# Quote Line Items Endpoints
# ========================

@router.post("/{quote_id}/line-items", response_model=QuoteLineItemResponse, status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
async def add_line_item(
    quote_id: UUID,
    item_data: QuoteLineItemCreate,
    db: Session = Depends(get_db)
):
    """Add a line item to a quote."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if quote.status != QuoteStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Can only add items to draft quotes")

    line_item = QuoteLineItem(
        quote_id=quote_id,
        **item_data.dict()
    )

    db.add(line_item)
    db.commit()
    db.refresh(line_item)

    # Update quote totals
    _update_quote_totals(quote, db)

    return line_item


@router.get("/{quote_id}/line-items", response_model=List[QuoteLineItemResponse], dependencies=[Depends(require_role("admin", "manager"))])
async def get_line_items(
    quote_id: UUID,
    db: Session = Depends(get_db)
):
    """Get all line items for a quote."""
    items = (
        db.query(QuoteLineItem)
        .filter(QuoteLineItem.quote_id == quote_id)
        .order_by(QuoteLineItem.display_order)
        .all()
    )
    return items


@router.put("/line-items/{item_id}", response_model=QuoteLineItemResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def update_line_item(
    item_id: UUID,
    item_data: QuoteLineItemUpdate,
    db: Session = Depends(get_db)
):
    """Update a line item."""
    item = db.query(QuoteLineItem).filter(QuoteLineItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Line item not found")

    # Check quote is still in draft
    quote = db.query(Quote).filter(Quote.id == item.quote_id).first()
    if quote.status != QuoteStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Can only edit items in draft quotes")

    update_data = item_data.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(item, field, value)

    item.updated_at = datetime.now()
    db.commit()
    db.refresh(item)

    # Update quote totals
    _update_quote_totals(quote, db)

    return item


@router.delete("/line-items/{item_id}", status_code=204, dependencies=[Depends(require_role("admin", "manager"))])
async def delete_line_item(
    item_id: UUID,
    db: Session = Depends(get_db)
):
    """Delete a line item."""
    item = db.query(QuoteLineItem).filter(QuoteLineItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Line item not found")

    quote = db.query(Quote).filter(Quote.id == item.quote_id).first()
    if quote.status != QuoteStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Can only delete items from draft quotes")

    db.delete(item)
    db.commit()

    # Update quote totals
    _update_quote_totals(quote, db)


# ========================
# Quote Status Endpoints
# ========================

@router.post("/{quote_id}/send", response_model=QuoteResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def send_quote(
    quote_id: UUID,
    db: Session = Depends(get_db)
):
    """Mark quote as sent (updates status and sent_at timestamp)."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if quote.status != QuoteStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Only draft quotes can be sent")

    quote.status = QuoteStatus.SENT
    quote.sent_at = datetime.now()
    quote.updated_at = datetime.now()
    _ensure_public_token(quote)  # mint the public accept-link token

    db.commit()
    db.refresh(quote)

    return quote


@router.post("/{quote_id}/generate-token", dependencies=[Depends(require_role("admin", "manager"))])
async def generate_quote_token(quote_id: UUID, db: Session = Depends(get_db)):
    """Ensure the quote has a public accept-link token and return it +
    the full shareable link. Used by the 'Copy Link' action so staff can share
    the no-login accept page without sending an email."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    token = _ensure_public_token(quote)
    quote.updated_at = datetime.now()
    db.commit()
    app_base = _app_base()
    return {
        "public_token": token,
        "quote_link": f"{app_base}/quote/{token}",
    }


@router.post("/{quote_id}/view", response_model=QuoteResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def mark_quote_viewed(
    quote_id: UUID,
    db: Session = Depends(get_db)
):
    """Mark quote as viewed (updates viewed_at timestamp)."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if not quote.viewed_at:
        quote.viewed_at = datetime.now()
        quote.status = QuoteStatus.VIEWED
        db.commit()
        db.refresh(quote)

    return quote


@router.post("/{quote_id}/accept", response_model=QuoteResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def accept_quote(
    quote_id: UUID,
    db: Session = Depends(get_db)
):
    """Accept a quote (updates status and accepted_at timestamp)."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if quote.status in [QuoteStatus.ACCEPTED, QuoteStatus.DECLINED]:
        raise HTTPException(
            status_code=400,
            detail=f"Quote has already been {quote.status}"
        )

    quote.status = QuoteStatus.ACCEPTED
    quote.accepted_at = datetime.now()
    quote.updated_at = datetime.now()

    db.commit()
    db.refresh(quote)

    # TODO: Send acceptance confirmation email
    # TODO: Notify admin team

    return quote


@router.post("/{quote_id}/decline", response_model=QuoteResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def decline_quote(
    quote_id: UUID,
    db: Session = Depends(get_db)
):
    """Decline a quote (updates status and declined_at timestamp)."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if quote.status in [QuoteStatus.ACCEPTED, QuoteStatus.DECLINED]:
        raise HTTPException(
            status_code=400,
            detail=f"Quote has already been {quote.status}"
        )

    quote.status = QuoteStatus.DECLINED
    quote.declined_at = datetime.now()
    quote.updated_at = datetime.now()

    db.commit()
    db.refresh(quote)

    return quote


# ========================
# Public (no-login) quote endpoints — reached via the tokenized accept link
# emailed to the client. The /api/quotes/public/ prefix is whitelisted in
# auth.py so these run without a session.
# ========================

class PublicAcceptRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None


class PublicChangeRequest(BaseModel):
    message: str


def _quote_by_token(token: str, db: Session) -> Quote:
    quote = db.query(Quote).filter(Quote.public_token == token).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


def _notify_staff_quote_event(db: Session, quote: Quote, summary: str, activity_type: str):
    """Best-effort: drop an Activity row so staff see quote events in the
    client timeline. Never let a logging failure break the public response."""
    try:
        from utils.activity_logger import log_activity
        log_activity(
            db, activity_type,
            client_id=quote.client_id,
            actor="client",
            summary=summary,
            extra_data={"quote_id": str(quote.id), "quote_number": quote.quote_number},
            commit=False,
        )
    except Exception as e:
        logger.warning(f"[quotes] activity log failed for {quote.id}: {e}")


@router.get("/public/{token}")
async def public_view_quote(token: str, db: Session = Depends(get_db)):
    """Client-facing quote view. Marks the quote VIEWED on first open."""
    quote = _quote_by_token(token, db)
    # First view: stamp viewed_at + advance status (only from SENT, so we don't
    # downgrade an already-accepted/declined quote).
    if not quote.viewed_at:
        quote.viewed_at = datetime.now()
        if quote.status == QuoteStatus.SENT:
            quote.status = QuoteStatus.VIEWED
        _notify_staff_quote_event(db, quote, f"Client viewed quote {quote.quote_number}", "quote_viewed")
        db.commit()
        db.refresh(quote)
    return _public_quote_dict(quote)


@router.post("/public/{token}/accept")
async def public_accept_quote(token: str, data: PublicAcceptRequest = None, db: Session = Depends(get_db)):
    """Client accepts the quote from the public link."""
    quote = _quote_by_token(token, db)

    if quote.status == QuoteStatus.ACCEPTED:
        # Idempotent: re-accepting is a no-op success, not an error.
        return {"status": "accepted", "quote_number": quote.quote_number}
    if quote.status == QuoteStatus.DECLINED:
        raise HTTPException(status_code=409, detail="This quote was declined and can no longer be accepted.")
    if quote.expires_at and quote.expires_at < datetime.now(quote.expires_at.tzinfo):
        quote.status = QuoteStatus.EXPIRED
        db.commit()
        raise HTTPException(status_code=409, detail="This quote has expired. Please contact us for an updated quote.")

    quote.status = QuoteStatus.ACCEPTED
    quote.accepted_at = datetime.now()
    quote.updated_at = datetime.now()
    if data:
        quote.accepted_by_name = data.name or quote.accepted_by_name
        quote.accepted_by_email = data.email or quote.accepted_by_email
    _notify_staff_quote_event(db, quote, f"Client accepted quote {quote.quote_number}", "quote_accepted")
    db.commit()
    return {"status": "accepted", "quote_number": quote.quote_number}


@router.post("/public/{token}/request-changes")
async def public_request_changes(token: str, data: PublicChangeRequest, db: Session = Depends(get_db)):
    """Client asks for changes instead of accepting — logged for staff."""
    quote = _quote_by_token(token, db)
    msg = (data.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Please include a message describing the changes.")
    _notify_staff_quote_event(
        db, quote,
        f"Client requested changes to quote {quote.quote_number}: {msg[:500]}",
        "quote_change_requested",
    )
    db.commit()
    return {"status": "received"}


# ========================
# Quote Request Endpoints
# ========================

@router.post("/requests/", response_model=QuoteRequestResponse, status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
async def create_quote_request(
    request_data: QuoteRequestCreate,
    db: Session = Depends(get_db),
):
    """Create a quote request from customer form."""
    quote_request = QuoteRequest(
        **request_data.dict()
    )

    db.add(quote_request)
    db.commit()
    db.refresh(quote_request)

    # TODO: Send confirmation email to requester
    # TODO: Notify admin team

    return quote_request


@router.get("/requests/", response_model=List[QuoteRequestResponse], dependencies=[Depends(require_role("admin", "manager"))])
async def list_quote_requests(
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0)
):
    """List quote requests."""
    query = db.query(QuoteRequest)

    if status:
        query = query.filter(QuoteRequest.status == status)

    requests = query.order_by(QuoteRequest.created_at.desc()).offset(offset).limit(limit).all()
    return requests


@router.get("/requests/{request_id}", response_model=QuoteRequestResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def get_quote_request(
    request_id: UUID,
    db: Session = Depends(get_db)
):
    """Get a specific quote request."""
    quote_request = db.query(QuoteRequest).filter(QuoteRequest.id == request_id).first()
    if not quote_request:
        raise HTTPException(status_code=404, detail="Quote request not found")
    return quote_request


@router.put("/requests/{request_id}", response_model=QuoteRequestResponse, dependencies=[Depends(require_role("admin", "manager"))])
async def update_quote_request(
    request_id: UUID,
    request_data: QuoteRequestUpdate,
    db: Session = Depends(get_db)
):
    """Update a quote request."""
    quote_request = db.query(QuoteRequest).filter(QuoteRequest.id == request_id).first()
    if not quote_request:
        raise HTTPException(status_code=404, detail="Quote request not found")

    update_data = request_data.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(quote_request, field, value)

    quote_request.updated_at = datetime.now()
    db.commit()
    db.refresh(quote_request)

    return quote_request


# ========================
# Helper Functions
# ========================

def _update_quote_totals(quote: Quote, db: Session):
    """Recalculate quote totals from line items."""
    line_items = db.query(QuoteLineItem).filter(QuoteLineItem.quote_id == quote.id).all()

    subtotal = sum(item.line_total for item in line_items)
    total = subtotal + quote.tax_amount - quote.discount_amount

    quote.subtotal = subtotal
    quote.total_amount = total
    quote.updated_at = datetime.now()

    db.commit()


# ========================
# Phase 2: PDF & Email Endpoints
# ========================

from services.quote_pdf_service import QuotePDFService
from services.quote_email_service import QuoteEmailService
from fastapi.responses import StreamingResponse


@router.post("/{quote_id}/generate-pdf", dependencies=[Depends(require_role("admin", "manager"))])
async def generate_quote_pdf(
    quote_id: UUID,
    db: Session = Depends(get_db),
):
    """Generate a PDF for a quote"""
    quote = db.query(Quote).filter(
        Quote.id == quote_id,
    ).first()

    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    line_items = db.query(QuoteLineItem).filter(
        QuoteLineItem.quote_id == quote_id
    ).order_by(QuoteLineItem.display_order).all()

    client = db.query(Client).filter(Client.id == quote.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    pdf_service = QuotePDFService()
    pdf_bytes = pdf_service.generate_quote_pdf(
        quote_number=quote.quote_number,
        client_name=client.name,
        client_email=client.email or "",
        client_phone=client.phone,
        line_items=[
            {
                "description": item.description,
                "quantity": float(item.quantity),
                "unit": item.unit,
                "unit_price": float(item.unit_price),
                "line_total": float(item.line_total),
            }
            for item in line_items
        ],
        subtotal=float(quote.subtotal),
        tax_amount=float(quote.tax_amount),
        discount_amount=float(quote.discount_amount),
        total_amount=float(quote.total_amount),
        notes=quote.notes,
        expires_at=quote.expires_at,
    )

    return {
        "pdf_generated": True,
        "quote_id": str(quote_id),
        "quote_number": quote.quote_number,
        "file_size": len(pdf_bytes),
        "timestamp": datetime.now().isoformat(),
    }


@router.post("/{quote_id}/send-email", dependencies=[Depends(require_role("admin", "manager"))])
async def send_quote_email(
    quote_id: UUID,
    recipient_email: str = Query(...),
    db: Session = Depends(get_db),
):
    """Send quote via email to client"""
    quote = db.query(Quote).filter(
        Quote.id == quote_id,
    ).first()

    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    if "@" not in recipient_email:
        raise HTTPException(status_code=400, detail="Invalid email address")

    line_items = db.query(QuoteLineItem).filter(
        QuoteLineItem.quote_id == quote_id
    ).order_by(QuoteLineItem.display_order).all()

    client = db.query(Client).filter(Client.id == quote.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    pdf_service = QuotePDFService()
    pdf_bytes = pdf_service.generate_quote_pdf(
        quote_number=quote.quote_number,
        client_name=client.name,
        client_email=client.email or "",
        client_phone=client.phone,
        line_items=[
            {
                "description": item.description,
                "quantity": float(item.quantity),
                "unit": item.unit,
                "unit_price": float(item.unit_price),
                "line_total": float(item.line_total),
            }
            for item in line_items
        ],
        subtotal=float(quote.subtotal),
        tax_amount=float(quote.tax_amount),
        discount_amount=float(quote.discount_amount),
        total_amount=float(quote.total_amount),
        notes=quote.notes,
        expires_at=quote.expires_at,
    )

    # Public accept-link token + base URL (configurable; falls back to prod host).
    token = _ensure_public_token(quote)
    app_base = _app_base()
    quote_link = f"{app_base}/quote/{token}"

    email_service = QuoteEmailService()
    email_result = email_service.send_quote_email(
        to_email=recipient_email,
        client_name=client.name,
        quote_number=quote.quote_number,
        total_amount=float(quote.total_amount),
        expires_at=quote.expires_at.strftime("%B %d, %Y") if quote.expires_at else "Upon Request",
        quote_link=quote_link,
        pdf_bytes=pdf_bytes,
        pdf_filename=f"{quote.quote_number}.pdf",
    )

    if not email_result["success"]:
        raise HTTPException(status_code=500, detail=f"Email failed: {email_result['error']}")

    # Update quote status to SENT if it was in DRAFT
    if hasattr(quote, 'status') and quote.status and str(quote.status).upper() == 'DRAFT':
        quote.status = 'SENT'
        quote.sent_at = datetime.now()

    # Create email tracking record
    quote_email = QuoteEmail(
        quote_id=quote_id,
        recipient_email=recipient_email,
        sent_at=datetime.now(),
        delivery_status="sent",
        email_id=email_result.get("email_id"),
    )
    db.add(quote_email)
    db.commit()

    return {
        "success": True,
        "quote_id": str(quote_id),
        "quote_number": quote.quote_number,
        "sent_to": recipient_email,
        "email_id": email_result.get("email_id"),
        "public_token": token,
        "quote_link": quote_link,
        "timestamp": datetime.now().isoformat(),
        "status": "sent",
    }


@router.get("/{quote_id}/email-history", dependencies=[Depends(require_role("admin", "manager"))])
async def get_quote_email_history(
    quote_id: UUID,
    db: Session = Depends(get_db),
):
    """Get email delivery history for a quote"""
    quote = db.query(Quote).filter(
        Quote.id == quote_id,
    ).first()

    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")

    emails = db.query(QuoteEmail).filter(
        QuoteEmail.quote_id == quote_id
    ).order_by(QuoteEmail.sent_at.desc()).all()

    return {
        "quote_id": str(quote_id),
        "quote_number": quote.quote_number,
        "total_emails_sent": len(emails),
        "emails": [
            {
                "recipient": email.recipient_email,
                "sent_at": email.sent_at.isoformat(),
                "status": email.delivery_status,
                "email_id": email.email_id,
            }
            for email in emails
        ],
    }


@router.post("/webhooks/resend")
async def resend_webhook(request: Request, db: Session = Depends(get_db)):
    """Webhook endpoint for Resend delivery events"""
    body = await request.json()
    
    # Verify webhook signature (implement based on Resend webhook secret)
    # For now, assume signature is valid
    
    event_type = body.get("type")
    email_id = body.get("data", {}).get("id")
    
    if not email_id:
        return {"received": True}
    
    # Map event types to delivery statuses
    status_map = {
        "email.delivered": "delivered",
        "email.bounced": "bounced",
        "email.complained": "complained",
        "email.failed": "failed",
    }
    
    new_status = status_map.get(event_type)
    if not new_status:
        return {"received": True}
    
    # Update the email record
    email_record = db.query(QuoteEmail).filter(QuoteEmail.email_id == email_id).first()
    if email_record:
        email_record.delivery_status = new_status
        if event_type == "email.failed":
            email_record.error_message = body.get("data", {}).get("error", {}).get("message", "Unknown error")
        db.commit()
    
    return {"received": True}
