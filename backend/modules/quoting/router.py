"""FastAPI router for Quotes system."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_
from uuid import UUID
from datetime import datetime
from decimal import Decimal
from typing import List, Optional

from database.db import get_db
from schemas.quotes import (
    QuoteCreate, QuoteUpdate, QuoteResponse, QuoteSummary,
    QuoteLineItemCreate, QuoteLineItemUpdate, QuoteLineItemResponse,
    QuoteRequestCreate, QuoteRequestUpdate, QuoteRequestResponse
)
from database.models import Quote, QuoteLineItem, QuoteRequest, QuoteStatus, QuoteRequestStatus, QuoteEmail, Client

router = APIRouter(tags=["quotes"])


# ========================
# Quote CRUD Endpoints
# ========================

@router.post("/", response_model=QuoteResponse, status_code=201)
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


@router.get("/{quote_id}", response_model=QuoteResponse)
async def get_quote(
    quote_id: UUID,
    db: Session = Depends(get_db)
):
    """Get a specific quote by ID."""
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


@router.get("/", response_model=List[QuoteSummary])
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


@router.put("/{quote_id}", response_model=QuoteResponse)
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

@router.post("/{quote_id}/line-items", response_model=QuoteLineItemResponse, status_code=201)
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


@router.get("/{quote_id}/line-items", response_model=List[QuoteLineItemResponse])
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


@router.put("/line-items/{item_id}", response_model=QuoteLineItemResponse)
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


@router.delete("/line-items/{item_id}", status_code=204)
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

@router.post("/{quote_id}/send", response_model=QuoteResponse)
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

    db.commit()
    db.refresh(quote)

    # TODO: Send email to client here

    return quote


@router.post("/{quote_id}/view", response_model=QuoteResponse)
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


@router.post("/{quote_id}/accept", response_model=QuoteResponse)
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


@router.post("/{quote_id}/decline", response_model=QuoteResponse)
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
# Quote Request Endpoints
# ========================

@router.post("/requests/", response_model=QuoteRequestResponse, status_code=201)
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


@router.get("/requests/", response_model=List[QuoteRequestResponse])
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


@router.get("/requests/{request_id}", response_model=QuoteRequestResponse)
async def get_quote_request(
    request_id: UUID,
    db: Session = Depends(get_db)
):
    """Get a specific quote request."""
    quote_request = db.query(QuoteRequest).filter(QuoteRequest.id == request_id).first()
    if not quote_request:
        raise HTTPException(status_code=404, detail="Quote request not found")
    return quote_request


@router.put("/requests/{request_id}", response_model=QuoteRequestResponse)
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


@router.post("/{quote_id}/generate-pdf")
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


@router.post("/{quote_id}/send-email")
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

    email_service = QuoteEmailService()
    email_result = email_service.send_quote_email(
        to_email=recipient_email,
        client_name=client.name,
        quote_number=quote.quote_number,
        total_amount=float(quote.total_amount),
        expires_at=quote.expires_at.strftime("%B %d, %Y") if quote.expires_at else "Upon Request",
        quote_link=f"https://bright-space.com/quotes/{quote_id}",
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
        "timestamp": datetime.now().isoformat(),
        "status": "sent",
    }


@router.get("/{quote_id}/email-history")
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
