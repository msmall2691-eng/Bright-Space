from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
from urllib.parse import urlparse
import os
import secrets
import logging

from database.db import get_db
from database.models import Quote, Job, LeadIntake, Client, Message, Activity, ActivityType, Property
from modules.auth.router import require_role

router = APIRouter()
logger = logging.getLogger(__name__)


# Hosts that must NEVER be used as the customer-facing quote link host.
# maineclean.co is the marketing site (Squarespace) — it 404s on /quote/<token>.
_REFUSED_PUBLIC_HOSTS = {"maineclean.co", "www.maineclean.co"}


def _get_public_app_url(request: Optional[Request] = None) -> str:
    """Return the base URL the customer should hit for the public quote page.

    Precedence:
      1. PUBLIC_APP_URL env var (preferred — set this on Railway)
      2. APP_URL env var, *unless* it points to a known marketing host
      3. The incoming request's scheme + host (works on any deploy)
      4. Hard-coded Railway URL as a last resort

    The marketing-host refuse-list is important: an older deploy had
    APP_URL=https://maineclean.co and that's what was producing the 404
    in the customer-facing accept email.
    """
    def _safe(url: Optional[str]) -> Optional[str]:
        if not url:
            return None
        try:
            host = urlparse(url).hostname or ""
        except Exception:
            return None
        if host.lower() in _REFUSED_PUBLIC_HOSTS:
            return None
        return url.rstrip("/")

    candidate = _safe(os.getenv("PUBLIC_APP_URL"))
    if candidate:
        return candidate

    candidate = _safe(os.getenv("APP_URL"))
    if candidate:
        return candidate

    if request is not None:
        try:
            host = request.headers.get("x-forwarded-host") or request.url.hostname
            scheme = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
            if host and host.lower() not in _REFUSED_PUBLIC_HOSTS:
                return f"{scheme}://{host}".rstrip("/")
        except Exception:
            pass

    return "https://brightbase-production.up.railway.app"


def _notify_quote_accepted(db: Session, quote: Quote, job: Optional[Job], scheduled_for: Optional[str]) -> None:
    """Best-effort: email the customer a confirmation and email ops a heads-up.

    Never raises — quote acceptance must succeed even if SMTP is down.
    """
    try:
        from integrations.email import send_email
    except Exception:
        return

    q_num = quote.quote_number or f"QT-{quote.id}"
    client = db.query(Client).filter(Client.id == quote.client_id).first()
    customer_name = (client.name if client else "there") or "there"
    customer_email = (client.email if client else None)
    company_name = os.getenv("FROM_NAME", "Maine Cleaning Co")

    # If the quote came from a website intake, prefer the lead's email (the
    # auto-matched Client may be a placeholder with the wrong address).
    if quote.intake_id:
        intake = db.query(LeadIntake).filter(LeadIntake.id == quote.intake_id).first()
        if intake and intake.email:
            customer_email = intake.email
        if intake and intake.name:
            customer_name = intake.name

    scheduled_line = ""
    if scheduled_for:
        scheduled_line = f"<p>Your service is tentatively scheduled for <b>{scheduled_for}</b>. We will confirm the time with you shortly.</p>"

    # Customer confirmation
    if customer_email:
        try:
            html = (
                f"<p>Hi {customer_name},</p>"
                f"<p>Thank you for accepting quote <b>{q_num}</b>. We've received your acceptance and our team has been notified.</p>"
                f"{scheduled_line}"
                f"<p>If you need to change anything, just reply to this email.</p>"
                f"<p>— {company_name}</p>"
            )
            sched_plain = (
                f"Your service is tentatively scheduled for {scheduled_for}. We will confirm the time with you shortly.\n\n"
                if scheduled_for else ""
            )
            plain = (
                f"Hi {customer_name},\n\n"
                f"Thank you for accepting quote {q_num}. We've received your acceptance and our team has been notified.\n\n"
                f"{sched_plain}"
                f"If you need to change anything, just reply to this email.\n\n— {company_name}"
            )
            send_email(to=customer_email, subject=f"Thanks — Quote {q_num} accepted",
                       html_body=html, text_body=plain)
            db.add(Message(client_id=quote.client_id, channel="email", direction="outbound",
                           from_addr=os.getenv("SMTP_USER", ""), to_addr=customer_email,
                           subject=f"Quote {q_num} accepted", body=plain, status="sent"))
        except Exception as e:
            logger.warning("Customer confirmation email failed for quote %s: %s", q_num, e)

    # Ops notification
    notify_to = os.getenv("NOTIFY_EMAIL") or os.getenv("SMTP_USER")
    if notify_to:
        try:
            html = (
                f"<p><b>{customer_name}</b> accepted quote <b>{q_num}</b>.</p>"
                f"<p>Total: ${quote.total or 0:.2f}<br>"
                f"Address: {quote.address or '(none on quote)'}<br>"
                f"Customer email: {customer_email or '(none on file)'}</p>"
                f"<p>{('Job auto-created (#' + str(job.id) + ') — review and confirm scheduling.') if job else 'No Job created automatically — please create one manually.'}</p>"
            )
            plain = (
                f"{customer_name} accepted quote {q_num}.\n"
                f"Total: ${quote.total or 0:.2f}\n"
                f"Address: {quote.address or '(none on quote)'}\n"
                f"Customer email: {customer_email or '(none on file)'}\n"
                f"{('Job auto-created (#' + str(job.id) + ') — review and confirm scheduling.') if job else 'No Job created automatically — please create one manually.'}"
            )
            send_email(to=notify_to, subject=f"[Quote {q_num}] Customer accepted",
                       html_body=html, text_body=plain)
        except Exception as e:
            logger.warning("Ops accept notification failed for quote %s: %s", q_num, e)


def _resolve_property_for_quote(db: Session, quote: Quote) -> int | None:
    """Find an existing Property for this quote's address, or create one.

    Job.property_id is NOT NULL — every Job needs a Property. When we convert
    a Quote to a Job we either match the Quote's address to a Property the
    client already owns, or auto-create a minimal Property record so the
    pipeline doesn't fail. Returns property.id, or None only if quote has no
    address and no fallback property (caller should 422).
    """
    if not quote.client_id:
        return None
    addr = (quote.address or "").strip()
    if addr:
        norm = addr.lower()
        existing = (
            db.query(Property)
            .filter(Property.client_id == quote.client_id)
            .all()
        )
        for p in existing:
            pa = (p.address or "").strip().lower()
            if pa and (pa == norm or pa in norm or norm in pa):
                return p.id
        # No match — auto-create a residential Property for this address.
        new_prop = Property(
            client_id=quote.client_id,
            name=addr[:120],
            address=addr,
            property_type=(quote.service_type or "residential"),
            active=True,
        )
        db.add(new_prop)
        db.flush()
        return new_prop.id
    # No address on the quote — fall back to client's first property if any.
    fallback = (
        db.query(Property)
        .filter(Property.client_id == quote.client_id, Property.active == True)
        .order_by(Property.id.asc())
        .first()
    )
    return fallback.id if fallback else None



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
def send_quote(quote_id: int, data: SendQuoteRequest, request: Request, db: Session = Depends(get_db)):
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
    # Use the safe app URL helper — refuses marketing-site hosts so the
    # customer link never lands on maineclean.co/quote/<token> (which 404s).
    app_url = _get_public_app_url(request)

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

    property_id = _resolve_property_for_quote(db, quote)
    if property_id is None:
        raise HTTPException(status_code=422, detail="Quote has no address and the client has no property. Add an address to the quote or a property to the client first.")

    # Derive a sensible default scheduled_date so the Schedule view doesn't
    # render "Invalid Date". Prefer the linked intake's preferred_date if set,
    # otherwise default to one week out (clearly tentative).
    derived_date = None
    derived_note = ""
    if quote.intake_id:
        intake = db.query(LeadIntake).filter(LeadIntake.id == quote.intake_id).first()
        if intake and intake.preferred_date:
            try:
                derived_date = datetime.fromisoformat(str(intake.preferred_date)).date()
            except Exception:
                derived_date = None
    if derived_date is None:
        derived_date = (datetime.utcnow() + timedelta(days=7)).date()
        derived_note = "\n\n(Tentative date — confirm with customer)"

    job = Job(
        client_id=quote.client_id,
        property_id=property_id,
        quote_id=quote.id,  # Persist the source quote for revenue tracking
        job_type=quote.service_type or "residential",
        title=f"Clean — {quote.quote_number or f'QT-{quote.id}'}",
        address=quote.address or "",
        scheduled_date=derived_date,
        start_time="09:00",
        end_time="12:00",
        status="scheduled",
        notes=(quote.notes or "") + derived_note,
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


class RequestChangesBody(BaseModel):
    message: str
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None


@router.post("/public/{token}/accept")
def accept_public_quote(token: str, data: AcceptQuoteRequest, request: Request, db: Session = Depends(get_db)):
    """Accept a quote via public token (no auth required). Creates a Job
    with a sensible scheduled_date and fires confirmation emails to the
    customer and ops."""
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

    property_id = _resolve_property_for_quote(db, quote)
    if property_id is None:
        activity = Activity(
            client_id=quote.client_id,
            activity_type=ActivityType.QUOTE_ACCEPTED,
            summary=f"Quote {quote.quote_number or f'QT-{quote.id}'} accepted (manual Job creation needed - no property)",
            extra_data={"quote_id": quote.id, "accepted_ip": client_ip, "needs_manual_job": True},
        )
        db.add(activity)
        db.commit()
        try:
            _notify_quote_accepted(db, quote, None, None)
            db.commit()
        except Exception:
            db.rollback()
        return {"job_id": None, "scheduled_status": "needs_property"}

    derived_date = None
    if quote.intake_id:
        intake = db.query(LeadIntake).filter(LeadIntake.id == quote.intake_id).first()
        if intake and intake.preferred_date:
            try:
                derived_date = datetime.fromisoformat(str(intake.preferred_date)).date()
            except Exception:
                derived_date = None
    tentative = derived_date is None
    if derived_date is None:
        derived_date = (datetime.utcnow() + timedelta(days=7)).date()

    job = Job(
        client_id=quote.client_id,
        property_id=property_id,
        quote_id=quote.id,
        job_type=quote.service_type or "residential",
        title=f"Clean - {quote.quote_number or f'QT-{quote.id}'}",
        address=quote.address or "",
        scheduled_date=derived_date,
        start_time="09:00",
        end_time="12:00",
        status="scheduled",
        notes=(quote.notes or "") + ("\n\n(Tentative date - confirm with customer)" if tentative else ""),
    )
    db.add(job)

    activity = Activity(
        client_id=quote.client_id,
        activity_type=ActivityType.QUOTE_ACCEPTED,
        summary=f"Quote {quote.quote_number or f'QT-{quote.id}'} accepted via public link",
        extra_data={"quote_id": quote.id, "accepted_ip": client_ip, "tentative_date": tentative},
    )
    db.add(activity)

    db.commit()
    db.refresh(job)

    logger.info("Quote %s accepted via public link (job %s, scheduled %s, tentative=%s)",
                quote.quote_number or quote.id, job.id, derived_date, tentative)
    try:
        _notify_quote_accepted(db, quote, job, derived_date.isoformat() if derived_date else None)
        db.commit()
    except Exception as e:
        logger.warning("Accept notifications failed for quote %s: %s", quote.quote_number or quote.id, e)
        db.rollback()

    from modules.scheduling.router import job_to_dict
    return {
        "job_id": job.id,
        "scheduled_status": "tentative" if tentative else "scheduled",
        "scheduled_date": derived_date.isoformat() if derived_date else None,
        "job": job_to_dict(job),
    }


@router.post("/public/{token}/request-changes")
def request_quote_changes(token: str, body: RequestChangesBody, request: Request, db: Session = Depends(get_db)):
    """Customer asks for changes via the public quote link. Records an
    Activity and emails the company so staff can edit + resend the quote."""
    from integrations.email import send_email

    quote = db.query(Quote).filter(Quote.public_token == token).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    if quote.accepted_at:
        raise HTTPException(status_code=409, detail="This quote was already accepted")

    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Tell us what to change")

    client_ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "")
    client = db.query(Client).filter(Client.id == quote.client_id).first()
    customer_name = (body.customer_name or (client.name if client else "Customer")).strip()
    customer_email = (body.customer_email or (client.email if client else "")).strip()

    quote.status = "viewed"

    activity = Activity(
        client_id=quote.client_id,
        activity_type=ActivityType.QUOTE_ACCEPTED,
        summary=f"Customer requested changes on quote {quote.quote_number or f'QT-{quote.id}'}",
        extra_data={
            "quote_id": quote.id,
            "kind": "request_changes",
            "message": msg,
            "customer_name": customer_name,
            "customer_email": customer_email,
            "ip": client_ip,
        },
    )
    db.add(activity)

    inbound = Message(
        client_id=quote.client_id,
        channel="email",
        direction="inbound",
        from_addr=customer_email or "(public quote link)",
        to_addr=os.getenv("SMTP_USER", ""),
        subject=f"Changes requested on quote {quote.quote_number or f'QT-{quote.id}'}",
        body=msg,
        status="received",
    )
    db.add(inbound)

    try:
        notify_to = os.getenv("NOTIFY_EMAIL") or os.getenv("SMTP_USER")
        if notify_to:
            q_num = quote.quote_number or f"QT-{quote.id}"
            subject = f"[Quote {q_num}] Customer requested changes"
            body_html = (
                f"<p>{customer_name} asked for changes on quote <b>{q_num}</b>.</p>"
                f"<p><b>Message:</b></p><blockquote>{msg}</blockquote>"
                f"<p>Open the quote in BrightBase to edit and resend.</p>"
            )
            body_plain = f"{customer_name} requested changes on quote {q_num}:\n\n{msg}\n\nOpen the quote in BrightBase to edit and resend."
            send_email(to=notify_to, subject=subject, html_body=body_html, text_body=body_plain)
    except Exception:
        pass

    db.commit()
    return {"quote_id": quote.id, "status": "changes_requested"}
