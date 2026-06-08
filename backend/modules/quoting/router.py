"""FastAPI router for the Quotes system.

Integer-keyed quotes with inline JSON line items, matching the rest of the app
(clients/jobs/invoices) and what the Quoting UI sends/reads. Responses are
plain dicts (see ``_quote_dict``) so the wire shape is decoupled from the ORM.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session
from datetime import datetime, date
from typing import Optional
import logging
import os
import secrets

from database.db import get_db
from schemas.quotes import (
    QuoteCreate, QuoteUpdate, QuoteRequestCreate, QuoteRequestUpdate,
)
from database.models import (
    Quote, QuoteRequest, QuoteEmail, Client, Job, Property,
)
from modules.auth.router import get_current_user, require_role

logger = logging.getLogger(__name__)
router = APIRouter(tags=["quotes"])


# ========================
# Helpers
# ========================

def _parse_date(value) -> Optional[date]:
    """'YYYY-MM-DD' (or a date) -> date | None. Empty string -> None."""
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _compute_totals(items, tax_rate, discount=0.0):
    """Return (subtotal, tax, total) from line items + a percent tax rate."""
    subtotal = sum(
        float(i.get("qty", 1) or 0) * float(i.get("unit_price", 0) or 0)
        for i in (items or [])
    )
    tax = round(subtotal * (float(tax_rate or 0) / 100.0), 2)
    total = round(subtotal + tax - float(discount or 0), 2)
    return round(subtotal, 2), tax, total


def _items_to_dicts(items) -> list:
    """Normalize incoming Pydantic items (or dicts) to plain dicts."""
    out = []
    for i in (items or []):
        d = i.dict() if hasattr(i, "dict") else dict(i)
        out.append({
            "name": d.get("name", "") or "",
            "description": d.get("description", "") or "",
            "qty": float(d.get("qty", 1) or 0),
            "unit_price": float(d.get("unit_price", 0) or 0),
        })
    return out


def _quote_dict(q: Quote) -> dict:
    """Serialize a Quote to the shape the Quoting UI expects."""
    return {
        "id": q.id,
        "client_id": q.client_id,
        "client_name": q.client.name if q.client else None,
        "intake_id": q.intake_id,
        "opportunity_id": q.opportunity_id,
        "property_id": q.property_id,
        "quote_number": q.quote_number,
        "public_token": q.public_token,
        "title": q.title,
        "service_type": q.service_type,
        "address": q.address,
        "notes": q.notes,
        "items": q.items or [],
        "subtotal": q.subtotal,
        "tax_rate": q.tax_rate,
        "tax": q.tax,
        "discount": q.discount,
        "total": q.total,
        "status": q.status,
        "valid_until": q.valid_until.isoformat() if q.valid_until else None,
        "sent_at": q.sent_at.isoformat() if q.sent_at else None,
        "viewed_at": q.viewed_at.isoformat() if q.viewed_at else None,
        "accepted_at": q.accepted_at.isoformat() if q.accepted_at else None,
        "accepted_by_name": q.accepted_by_name,
        "accepted_by_email": q.accepted_by_email,
        "declined_at": q.declined_at.isoformat() if q.declined_at else None,
        "declined_reason": getattr(q, "declined_reason", None),
        "declined_by_name": getattr(q, "declined_by_name", None),
        "requested_changes_message": getattr(q, "requested_changes_message", None),
        "requested_changes_at": q.requested_changes_at.isoformat() if getattr(q, "requested_changes_at", None) else None,
        "created_at": q.created_at.isoformat() if q.created_at else None,
        "updated_at": q.updated_at.isoformat() if q.updated_at else None,
    }


def _ensure_public_token(quote: Quote) -> str:
    """Return the quote's public link token, generating one if missing."""
    if not quote.public_token:
        quote.public_token = secrets.token_urlsafe(32)
    return quote.public_token


def _get_quote_or_404(quote_id: int, db: Session) -> Quote:
    quote = db.query(Quote).filter(Quote.id == quote_id).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


def _assign_quote_number(quote: Quote) -> None:
    """Set a unique, human-readable quote number (QT-YYYY-####) from the row id
    so it's race-free."""
    quote.quote_number = f"QT-{datetime.now().year}-{quote.id:04d}"


# ========================
# Quote CRUD
# ========================

@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_quote(
    quote_data: QuoteCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Create a quote from the Quoting UI (integer client_id + inline items)."""
    client = db.query(Client).filter(Client.id == quote_data.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    items = _items_to_dicts(quote_data.items)
    subtotal, tax, total = _compute_totals(items, quote_data.tax_rate, quote_data.discount)

    quote = Quote(
        client_id=quote_data.client_id,
        intake_id=quote_data.intake_id,
        opportunity_id=quote_data.opportunity_id,
        property_id=quote_data.property_id,
        created_by=getattr(current_user, "id", None),
        # Temporary unique placeholder; replaced with QT-YYYY-#### after flush.
        quote_number=f"PENDING-{secrets.token_hex(8)}",
        title=quote_data.title,
        service_type=quote_data.service_type or "residential",
        address=quote_data.address,
        notes=quote_data.notes,
        items=items,
        subtotal=subtotal,
        tax_rate=float(quote_data.tax_rate or 0),
        tax=tax,
        discount=float(quote_data.discount or 0),
        total=total,
        valid_until=_parse_date(quote_data.valid_until),
        status=quote_data.status or "draft",
    )
    db.add(quote)
    db.flush()  # assign id
    _assign_quote_number(quote)
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_quotes(
    db: Session = Depends(get_db),
    client_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List quotes (most recent first), optionally filtered."""
    query = db.query(Quote)
    if client_id is not None:
        query = query.filter(Quote.client_id == client_id)
    if status:
        query = query.filter(Quote.status == status)
    quotes = query.order_by(Quote.created_at.desc()).offset(offset).limit(limit).all()
    return [_quote_dict(q) for q in quotes]


@router.get("/{quote_id}")
def get_quote(quote_id: int, db: Session = Depends(get_db)):
    return _quote_dict(_get_quote_or_404(quote_id, db))


def _apply_update(quote: Quote, data: dict) -> None:
    """Apply a partial update dict, recomputing totals when pricing changes."""
    if "items" in data and data["items"] is not None:
        quote.items = _items_to_dicts(data["items"])
    for field in ("title", "service_type", "address", "notes", "status",
                  "client_id", "intake_id", "opportunity_id", "property_id"):
        if field in data and data[field] is not None:
            setattr(quote, field, data[field])
    if "valid_until" in data:
        quote.valid_until = _parse_date(data["valid_until"])
    if "tax_rate" in data and data["tax_rate"] is not None:
        quote.tax_rate = float(data["tax_rate"])
    if "discount" in data and data["discount"] is not None:
        quote.discount = float(data["discount"])
    # Recompute money if anything affecting it changed.
    if any(k in data for k in ("items", "tax_rate", "discount")):
        quote.subtotal, quote.tax, quote.total = _compute_totals(
            quote.items, quote.tax_rate, quote.discount
        )
    quote.updated_at = datetime.now()


@router.patch("/{quote_id}")
def patch_quote(quote_id: int, quote_data: QuoteUpdate, db: Session = Depends(get_db)):
    """Partial update (the Quoting UI uses PATCH for both edits and status)."""
    quote = _get_quote_or_404(quote_id, db)
    _apply_update(quote, quote_data.dict(exclude_unset=True))
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


# PUT kept as an alias of PATCH for backward compatibility.
@router.put("/{quote_id}")
def update_quote(quote_id: int, quote_data: QuoteUpdate, db: Session = Depends(get_db)):
    return patch_quote(quote_id, quote_data, db)


# ========================
# Status transitions
# ========================

class QuoteSendRequest(BaseModel):
    channel: str = "email"                 # 'email' | 'sms' | 'both'
    email: Optional[str] = None
    phone: Optional[str] = None
    custom_message: Optional[str] = None


@router.post("/{quote_id}/send")
def send_quote(quote_id: int, body: QuoteSendRequest = QuoteSendRequest(), db: Session = Depends(get_db)):
    """Actually DELIVER the quote to the customer over the chosen channel(s), then
    mark it sent. Email attaches the PDF; SMS texts the public accept-link.

    Previously this only flipped the status and minted the link — nothing was
    delivered — so the UI's email/SMS picker was ignored and customers never
    received anything. Returns per-channel results: {"email": "sent", "sms": ...}.
    """
    quote = _get_quote_or_404(quote_id, db)
    if quote.status not in ("draft", "sent"):
        raise HTTPException(status_code=400, detail=f"Cannot send a {quote.status} quote")
    client = db.query(Client).filter(Client.id == quote.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    channel = (body.channel or "email").lower()
    want_email = channel in ("email", "both")
    want_sms = channel in ("sms", "both")
    if not (want_email or want_sms):
        raise HTTPException(status_code=400, detail=f"Unknown channel '{body.channel}'")

    token = _ensure_public_token(quote)
    app_base = os.getenv("APP_BASE_URL", "https://bright-space.com").rstrip("/")
    quote_link = f"{app_base}/quote/{token}"

    results: dict = {}
    errors: list = []

    if want_email:
        to_email = (body.email or client.email or "").strip()
        if "@" not in to_email:
            results["email"] = "no email address on file"
            errors.append("no valid email address")
        else:
            try:
                pdf_bytes = QuotePDFService().generate_quote_pdf(
                    quote_number=quote.quote_number, client_name=client.name,
                    client_email=client.email or "", client_phone=client.phone,
                    line_items=_pdf_line_items(quote), subtotal=quote.subtotal,
                    tax_amount=quote.tax, discount_amount=quote.discount,
                    total_amount=quote.total, notes=quote.notes, expires_at=quote.valid_until,
                )
                res = QuoteEmailService().send_quote_email(
                    to_email=to_email, client_name=client.name, quote_number=quote.quote_number,
                    total_amount=float(quote.total or 0),
                    expires_at=quote.valid_until.strftime("%B %d, %Y") if quote.valid_until else "Upon Request",
                    quote_link=quote_link, pdf_bytes=pdf_bytes, pdf_filename=f"{quote.quote_number}.pdf",
                )
                if res.get("success"):
                    results["email"] = "sent"
                    db.add(QuoteEmail(
                        quote_id=quote.id, recipient_email=to_email, sent_at=datetime.now(),
                        delivery_status="sent", email_id=res.get("email_id"),
                    ))
                else:
                    results["email"] = "failed"
                    errors.append("email could not be sent")
                    logger.warning(f"Quote {quote.id} email send failed: {res.get('error')}")
            except Exception as e:
                results["email"] = "failed"
                errors.append("email could not be sent")
                logger.warning(f"Quote {quote.id} email send error: {e}")

    if want_sms:
        to_phone = (body.phone or client.phone or "").strip()
        if not to_phone:
            results["sms"] = "no phone number on file"
            errors.append("no phone number")
        else:
            try:
                from integrations.twilio_client import send_sms
                base = (body.custom_message or "").strip() or f"Hi {client.name or ''}, your quote {quote.quote_number} is ready."
                msg = base if quote_link in base else f"{base} View & accept: {quote_link}"
                send_sms(to=to_phone, body=msg)
                results["sms"] = "sent"
            except Exception as e:
                results["sms"] = "failed"
                errors.append("text message could not be sent")
                logger.warning(f"Quote {quote.id} SMS send error: {e}")

    delivered = any(v == "sent" for v in results.values())
    if delivered:
        quote.status = "sent"
        quote.sent_at = datetime.now()
    quote.updated_at = datetime.now()
    db.commit()
    db.refresh(quote)

    if not delivered:
        # Nothing went out — surface why so the UI shows a real error, not a
        # false "sent".
        raise HTTPException(status_code=502, detail="; ".join(errors) or "Quote could not be sent")

    return {
        "quote_id": quote.id,
        "quote_number": quote.quote_number,
        "status": quote.status,
        "results": results,
        "errors": errors,
        "public_token": token,
        "quote_link": quote_link,
    }


@router.post("/{quote_id}/generate-token")
def generate_quote_token(quote_id: int, db: Session = Depends(get_db)):
    """Ensure a public token exists and return it + the shareable link."""
    quote = _get_quote_or_404(quote_id, db)
    token = _ensure_public_token(quote)
    quote.updated_at = datetime.now()
    db.commit()
    app_base = os.getenv("APP_BASE_URL", "").rstrip("/")
    return {
        "public_token": token,
        "quote_link": f"{app_base}/quote/{token}" if app_base else None,
    }


@router.post("/{quote_id}/accept")
def accept_quote(quote_id: int, db: Session = Depends(get_db)):
    quote = _get_quote_or_404(quote_id, db)
    if quote.status in ("accepted", "declined"):
        raise HTTPException(status_code=400, detail=f"Quote has already been {quote.status}")
    quote.status = "accepted"
    quote.accepted_at = datetime.now()
    quote.updated_at = datetime.now()
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


@router.post("/{quote_id}/decline")
def decline_quote(quote_id: int, db: Session = Depends(get_db)):
    quote = _get_quote_or_404(quote_id, db)
    if quote.status in ("accepted", "declined"):
        raise HTTPException(status_code=400, detail=f"Quote has already been {quote.status}")
    quote.status = "declined"
    quote.declined_at = datetime.now()
    quote.updated_at = datetime.now()
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


# ========================
# Convert accepted quote -> Job
# ========================

@router.post("/{quote_id}/convert-to-job")
def convert_quote_to_job(quote_id: int, db: Session = Depends(get_db)):
    """Create a Job from a quote. The date/time is left unset for the user to
    fill in on the Scheduling page; every Job needs a Property, so we reuse the
    client's existing property or create one from the quote address."""
    quote = _get_quote_or_404(quote_id, db)

    # Map the quote's service_type onto the Job/Property vocabularies.
    svc = (quote.service_type or "residential").lower()
    job_type = "str_turnover" if svc in ("str", "str_turnover") else (
        "commercial" if svc == "commercial" else "residential")
    prop_type = "str" if svc in ("str", "str_turnover") else (
        "commercial" if svc == "commercial" else "residential")

    prop = (
        db.query(Property)
        .filter(Property.client_id == quote.client_id)
        .order_by(Property.id.asc())
        .first()
    )
    if not prop:
        addr = (quote.address or "Address TBD").strip() or "Address TBD"
        prop = Property(
            client_id=quote.client_id,
            name=addr.split("\n")[0][:255],
            address=addr,
            property_type=prop_type,
            active=True,
        )
        db.add(prop)
        db.flush()

    job = Job(
        client_id=quote.client_id,
        quote_id=quote.id,
        opportunity_id=quote.opportunity_id,
        property_id=prop.id,
        job_type=job_type,
        title=quote.title or f"{svc.title()} clean",
        address=quote.address or prop.address,
        status="scheduled",
        notes=quote.notes,
    )
    db.add(job)
    # Mark the quote converted so it stops showing as "accepted — ready to
    # schedule" and the Schedule-Job action can't create a second job for it.
    quote.status = "converted"
    quote.updated_at = datetime.now()
    db.commit()
    db.refresh(job)
    return {
        "id": job.id,
        "client_id": job.client_id,
        "quote_id": job.quote_id,
        "property_id": job.property_id,
        "title": job.title,
        "status": job.status,
        "job_type": job.job_type,
    }


# ========================
# Public (no-login) endpoints — reached via the tokenized link.
# /api/quotes/public/ is allowlisted in auth.py so these run without a session.
# ========================

class PublicAcceptRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None


class PublicChangeRequest(BaseModel):
    message: str


class PublicDeclineRequest(BaseModel):
    name: Optional[str] = None
    reason: Optional[str] = None


def _quote_by_token(token: str, db: Session) -> Quote:
    quote = db.query(Quote).filter(Quote.public_token == token).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


def _public_quote_dict(quote: Quote) -> dict:
    """Client-facing serialization for the public accept page."""
    return {
        "id": quote.id,
        "quote_number": quote.quote_number,
        "status": quote.status,
        "company_name": os.getenv("COMPANY_NAME", "Bright Space"),
        "company_email": os.getenv("COMPANY_EMAIL") or os.getenv("SMTP_USER"),
        "company_phone": os.getenv("COMPANY_PHONE"),
        "address": quote.address or "",
        "service_type": quote.service_type,
        "notes": quote.notes,
        "items": quote.items or [],
        "subtotal": quote.subtotal,
        "tax_rate": quote.tax_rate,
        "tax": quote.tax,
        "total": quote.total,
        "valid_until": quote.valid_until.strftime("%B %d, %Y") if quote.valid_until else None,
    }


def _notify_staff_quote_event(db: Session, quote: Quote, summary: str, activity_type: str):
    """Best-effort Activity row so staff see quote events in the timeline."""
    try:
        from utils.activity_logger import log_activity
        log_activity(
            db, activity_type,
            client_id=quote.client_id,
            actor="client",
            summary=summary,
            extra_data={"quote_id": quote.id, "quote_number": quote.quote_number},
            commit=False,
        )
    except Exception as e:
        logger.warning(f"[quotes] activity log failed for {quote.id}: {e}")


def _notify_owner_quote_event(db: Session, quote: Quote, subject: str, lines: list) -> None:
    """Email the business owner when a customer responds to a quote.

    Sends to the configured business address (the same from_email used to send
    quotes) so the owner gets a real heads-up instead of only a hidden activity
    log. Best-effort: never let a notification failure break the public response.
    """
    try:
        from integrations.email import _load_smtp_creds, send_email
        creds = _load_smtp_creds()
        owner = creds.get("from_email")
        if not owner:
            logger.info("[quotes] no owner email configured; skipping owner notification")
            return
        client_name = quote.client.name if quote.client else "a customer"
        app_base = os.getenv("APP_BASE_URL", "https://bright-space.com").rstrip("/")
        body_lines = lines + [
            "",
            f"Quote: {quote.quote_number}",
            f"Customer: {client_name}",
            f"Total: ${float(quote.total or 0):,.2f}",
            f"Open it: {app_base}/quoting",
        ]
        import html as _html
        body = "<br>".join(_html.escape(l) if l else "&nbsp;" for l in body_lines)
        send_email(to=owner, subject=subject, html_body=f"<div style='font-family:sans-serif'>{body}</div>",
                   text_body="\n".join(body_lines))
    except Exception as e:
        logger.warning(f"[quotes] owner notification failed for {quote.id}: {e}")


def _send_customer_quote_confirmation(db: Session, quote: Quote, to_email: str) -> None:
    """Email the customer a receipt when they accept their quote. Best-effort —
    never let a failure block the acceptance."""
    if not to_email or "@" not in to_email:
        return
    try:
        from integrations.email import _load_smtp_creds, send_email
        creds = _load_smtp_creds()
        company = creds.get("from_name") or "Our team"
        name = quote.accepted_by_name or (quote.client.name if quote.client else "there")
        total = f"${float(quote.total or 0):,.2f}"
        lines = [
            f"Hi {name},",
            "",
            f"Thanks for accepting quote {quote.quote_number} ({total}).",
            f"{company} will reach out shortly to schedule your service.",
            "",
            "Questions? Just reply to this email.",
        ]
        import html as _html
        body = "<div style='font-family:sans-serif;font-size:14px;color:#111'>" + \
            "<br>".join(_html.escape(l) if l else "&nbsp;" for l in lines) + "</div>"
        send_email(to=to_email, subject=f"Quote {quote.quote_number} confirmed — thank you!",
                   html_body=body, text_body="\n".join(lines))
    except Exception as e:
        logger.warning(f"[quotes] customer confirmation email failed for {quote.id}: {e}")


@router.get("/public/{token}")
def public_view_quote(token: str, db: Session = Depends(get_db)):
    """Client-facing quote view. Marks the quote VIEWED on first open."""
    quote = _quote_by_token(token, db)
    if not quote.viewed_at:
        quote.viewed_at = datetime.now()
        if quote.status == "sent":
            quote.status = "viewed"
        _notify_staff_quote_event(db, quote, f"Client viewed quote {quote.quote_number}", "quote_viewed")
        db.commit()
        db.refresh(quote)
    return _public_quote_dict(quote)


@router.post("/public/{token}/accept")
def public_accept_quote(token: str, data: PublicAcceptRequest = None, db: Session = Depends(get_db)):
    """Client accepts the quote from the public link."""
    quote = _quote_by_token(token, db)
    if quote.status == "accepted":
        return {"status": "accepted", "quote_number": quote.quote_number}
    if quote.status == "declined":
        raise HTTPException(status_code=409, detail="This quote was declined and can no longer be accepted.")
    if quote.valid_until and quote.valid_until < date.today():
        quote.status = "expired"
        db.commit()
        raise HTTPException(status_code=409, detail="This quote has expired. Please contact us for an updated quote.")

    quote.status = "accepted"
    quote.accepted_at = datetime.now()
    quote.updated_at = datetime.now()
    if data:
        quote.accepted_by_name = data.name or quote.accepted_by_name
        quote.accepted_by_email = data.email or quote.accepted_by_email
    who = quote.accepted_by_name or (quote.client.name if quote.client else "The customer")
    _notify_staff_quote_event(db, quote, f"Client accepted quote {quote.quote_number}", "quote_accepted")
    _notify_owner_quote_event(
        db, quote, f"✅ Quote {quote.quote_number} accepted",
        [f"{who} accepted quote {quote.quote_number}.",
         "You can convert it to a scheduled job from the Quoting page."],
    )
    # Send the customer a receipt/confirmation too.
    _send_customer_quote_confirmation(
        db, quote,
        quote.accepted_by_email or (quote.client.email if quote.client else None),
    )
    db.commit()
    return {"status": "accepted", "quote_number": quote.quote_number}


@router.post("/public/{token}/request-changes")
def public_request_changes(token: str, data: PublicChangeRequest, db: Session = Depends(get_db)):
    """Client asks for changes instead of accepting — logged for staff."""
    quote = _quote_by_token(token, db)
    msg = (data.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Please include a message describing the changes.")
    # Persist the request on the quote (not just an activity line) and flag it so
    # the owner sees it needs attention.
    quote.requested_changes_message = msg
    quote.requested_changes_at = datetime.now()
    if quote.status in ("sent", "viewed", "draft"):
        quote.status = "changes_requested"
    quote.updated_at = datetime.now()
    _notify_staff_quote_event(
        db, quote,
        f"Client requested changes to quote {quote.quote_number}: {msg[:500]}",
        "quote_change_requested",
    )
    _notify_owner_quote_event(
        db, quote, f"✏️ Quote {quote.quote_number}: changes requested",
        ["The customer requested changes to this quote:", "", f"“{msg}”"],
    )
    db.commit()
    return {"status": "received"}


@router.post("/public/{token}/decline")
def public_decline_quote(token: str, data: "PublicDeclineRequest" = None, db: Session = Depends(get_db)):
    """Client declines the quote from the public link."""
    quote = _quote_by_token(token, db)
    if quote.status == "accepted":
        raise HTTPException(status_code=409, detail="This quote was already accepted.")
    quote.status = "declined"
    quote.declined_at = datetime.now()
    quote.updated_at = datetime.now()
    if data:
        quote.declined_by_name = (data.name or "").strip() or quote.declined_by_name
        quote.declined_reason = (data.reason or "").strip() or quote.declined_reason
    who = quote.declined_by_name or (quote.client.name if quote.client else "The customer")
    reason = quote.declined_reason
    _notify_staff_quote_event(db, quote, f"Client declined quote {quote.quote_number}", "quote_rejected")
    _notify_owner_quote_event(
        db, quote, f"❌ Quote {quote.quote_number} declined",
        [f"{who} declined quote {quote.quote_number}."] + ([f"Reason: {reason}"] if reason else []),
    )
    db.commit()
    return {"status": "declined"}


# ========================
# Quote Requests (web form intake)
# ========================

@router.post("/requests/", status_code=201)
def create_quote_request(request_data: QuoteRequestCreate, db: Session = Depends(get_db)):
    qr = QuoteRequest(**request_data.dict())
    db.add(qr)
    db.commit()
    db.refresh(qr)
    return {"id": qr.id, "status": qr.status, "requester_name": qr.requester_name}


@router.get("/requests/")
def list_quote_requests(
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    query = db.query(QuoteRequest)
    if status:
        query = query.filter(QuoteRequest.status == status)
    rows = query.order_by(QuoteRequest.created_at.desc()).offset(offset).limit(limit).all()
    return [
        {
            "id": r.id, "client_id": r.client_id, "requester_name": r.requester_name,
            "requester_email": r.requester_email, "requester_phone": r.requester_phone,
            "service_type": r.service_type, "description": r.description,
            "status": r.status, "quote_id": r.quote_id,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.put("/requests/{request_id}")
def update_quote_request(request_id: int, request_data: QuoteRequestUpdate, db: Session = Depends(get_db)):
    qr = db.query(QuoteRequest).filter(QuoteRequest.id == request_id).first()
    if not qr:
        raise HTTPException(status_code=404, detail="Quote request not found")
    for field, value in request_data.dict(exclude_unset=True).items():
        setattr(qr, field, value)
    qr.updated_at = datetime.now()
    db.commit()
    return {"id": qr.id, "status": qr.status}


# ========================
# PDF & Email
# ========================

from services.quote_pdf_service import QuotePDFService
from services.quote_email_service import QuoteEmailService


def _pdf_line_items(quote: Quote) -> list:
    return [
        {
            "description": i.get("name") or i.get("description") or "",
            "quantity": float(i.get("qty", 1) or 0),
            "unit": None,
            "unit_price": float(i.get("unit_price", 0) or 0),
            "line_total": round(float(i.get("qty", 1) or 0) * float(i.get("unit_price", 0) or 0), 2),
        }
        for i in (quote.items or [])
    ]


@router.post("/{quote_id}/generate-pdf")
def generate_quote_pdf(quote_id: int, db: Session = Depends(get_db)):
    quote = _get_quote_or_404(quote_id, db)
    client = db.query(Client).filter(Client.id == quote.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    pdf_bytes = QuotePDFService().generate_quote_pdf(
        quote_number=quote.quote_number,
        client_name=client.name,
        client_email=client.email or "",
        client_phone=client.phone,
        line_items=_pdf_line_items(quote),
        subtotal=quote.subtotal,
        tax_amount=quote.tax,
        discount_amount=quote.discount,
        total_amount=quote.total,
        notes=quote.notes,
        expires_at=quote.valid_until,
    )
    return {
        "pdf_generated": True,
        "quote_id": quote.id,
        "quote_number": quote.quote_number,
        "file_size": len(pdf_bytes),
        "timestamp": datetime.now().isoformat(),
    }


@router.post("/{quote_id}/send-email")
def send_quote_email(quote_id: int, recipient_email: str = Query(...), db: Session = Depends(get_db)):
    quote = _get_quote_or_404(quote_id, db)
    if "@" not in recipient_email:
        raise HTTPException(status_code=400, detail="Invalid email address")
    client = db.query(Client).filter(Client.id == quote.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    pdf_bytes = QuotePDFService().generate_quote_pdf(
        quote_number=quote.quote_number,
        client_name=client.name,
        client_email=client.email or "",
        client_phone=client.phone,
        line_items=_pdf_line_items(quote),
        subtotal=quote.subtotal,
        tax_amount=quote.tax,
        discount_amount=quote.discount,
        total_amount=quote.total,
        notes=quote.notes,
        expires_at=quote.valid_until,
    )

    token = _ensure_public_token(quote)
    app_base = os.getenv("APP_BASE_URL", "https://bright-space.com").rstrip("/")
    quote_link = f"{app_base}/quote/{token}"

    result = QuoteEmailService().send_quote_email(
        to_email=recipient_email,
        client_name=client.name,
        quote_number=quote.quote_number,
        total_amount=float(quote.total or 0),
        expires_at=quote.valid_until.strftime("%B %d, %Y") if quote.valid_until else "Upon Request",
        quote_link=quote_link,
        pdf_bytes=pdf_bytes,
        pdf_filename=f"{quote.quote_number}.pdf",
    )
    if not result["success"]:
        raise HTTPException(status_code=500, detail=f"Email failed: {result['error']}")

    if quote.status == "draft":
        quote.status = "sent"
        quote.sent_at = datetime.now()

    db.add(QuoteEmail(
        quote_id=quote.id,
        recipient_email=recipient_email,
        sent_at=datetime.now(),
        delivery_status="sent",
        email_id=result.get("email_id"),
    ))
    db.commit()
    return {
        "success": True,
        "quote_id": quote.id,
        "quote_number": quote.quote_number,
        "sent_to": recipient_email,
        "email_id": result.get("email_id"),
        "public_token": token,
        "quote_link": quote_link,
        "status": "sent",
    }


@router.get("/{quote_id}/email-history")
def get_quote_email_history(quote_id: int, db: Session = Depends(get_db)):
    quote = _get_quote_or_404(quote_id, db)
    emails = (
        db.query(QuoteEmail)
        .filter(QuoteEmail.quote_id == quote_id)
        .order_by(QuoteEmail.sent_at.desc())
        .all()
    )
    return {
        "quote_id": quote.id,
        "quote_number": quote.quote_number,
        "total_emails_sent": len(emails),
        "emails": [
            {
                "recipient": e.recipient_email,
                "sent_at": e.sent_at.isoformat() if e.sent_at else None,
                "status": e.delivery_status,
                "email_id": e.email_id,
            }
            for e in emails
        ],
    }


@router.post("/webhooks/resend")
async def resend_webhook(request: Request, db: Session = Depends(get_db)):
    """Webhook for Resend delivery events."""
    body = await request.json()
    event_type = body.get("type")
    email_id = body.get("data", {}).get("id")
    if not email_id:
        return {"received": True}
    status_map = {
        "email.delivered": "delivered",
        "email.bounced": "bounced",
        "email.complained": "complained",
        "email.failed": "failed",
    }
    new_status = status_map.get(event_type)
    if not new_status:
        return {"received": True}
    record = db.query(QuoteEmail).filter(QuoteEmail.email_id == email_id).first()
    if record:
        record.delivery_status = new_status
        if event_type == "email.failed":
            record.error_message = body.get("data", {}).get("error", {}).get("message", "Unknown error")
        db.commit()
    return {"received": True}
