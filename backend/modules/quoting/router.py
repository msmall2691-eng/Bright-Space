"""FastAPI router for the Quotes system.

Integer-keyed quotes with inline JSON line items, matching the rest of the app
(clients/jobs/invoices) and what the Quoting UI sends/reads. Responses are
plain dicts (see ``_quote_dict``) so the wire shape is decoupled from the ORM.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from io import BytesIO
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from datetime import datetime, date, timedelta, timezone
from typing import Optional
import logging
import os
import secrets

from ratelimit import rate_limit
from database.db import get_db
from schemas.quotes import (
    QuoteCreate, QuoteUpdate, QuoteRequestCreate, QuoteRequestUpdate,
)
from database.models import (
    Quote, Client, Job, Property, LeadIntake, IntegrationEvent,
)
from modules.auth.router import get_current_user, require_role, current_org_id, resolve_org_id
from utils.integration_log import log_integration_event as _log_integration
from utils.dates import coerce_date, fmt_long_date
from utils.address import format_address
from config import app_base_url, DEFAULT_COMPANY_NAME

import re as _re
# A greeting override that is really an intake/display label ("TEST"), a phone
# number, or "unknown" must NOT beat the real first name derived from the client
# record. Returns None so QuoteEmailService falls back to first_name_of(client.name).
_PLACEHOLDER_GREETING = _re.compile(r"^(unknown|test|test\s*[-–—].*|webhook test|test client|n/?a|\+?[\d\s().-]+)$", _re.I)
def _safe_greeting(override):
    o = (override or "").strip()
    if not o or _PLACEHOLDER_GREETING.match(o):
        return None
    return o
from utils.dates import business_today

logger = logging.getLogger(__name__)
router = APIRouter(tags=["quotes"])


# ========================
# Helpers
# ========================

def _utcnow():
    """Timezone-aware UTC now for writes into timestamptz columns (replaces the
    old naive wall-clock now, which only happened to be right on UTC Railway)."""
    return datetime.now(timezone.utc)


def _iso(v):
    """Serialize a date/datetime to ISO 8601, tolerating values that are
    already strings (legacy VARCHAR columns) instead of raising
    AttributeError and 500-ing the whole list endpoint."""
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


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
        d = i.model_dump() if hasattr(i, "model_dump") else dict(i)
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
        "customer_message": getattr(q, "customer_message", None),
        "internal_notes": getattr(q, "internal_notes", None),
        "service_type": q.service_type,
        "frequency": getattr(q, "frequency", None),
        "address": format_address(q.address),
        "notes": q.notes,
        "items": q.items or [],
        "custom_fields": q.custom_fields or {},
        "subtotal": q.subtotal,
        "tax_rate": q.tax_rate,
        "tax": q.tax,
        "discount": q.discount,
        "total": q.total,
        "status": q.status,
        "valid_until": _iso(q.valid_until),
        "sent_at": _iso(q.sent_at),
        "viewed_at": _iso(q.viewed_at),
        "accepted_at": _iso(q.accepted_at),
        "accepted_by_name": q.accepted_by_name,
        "accepted_by_email": q.accepted_by_email,
        "declined_at": _iso(q.declined_at),
        "converted_at": _iso(getattr(q, "converted_at", None)),
        "archived_at": _iso(getattr(q, "archived_at", None)),
        "follow_up_sent_at": _iso(getattr(q, "follow_up_sent_at", None)),
        "last_send_attempt_at": _iso(getattr(q, "last_send_attempt_at", None)),
        "last_send_error": getattr(q, "last_send_error", None),
        "declined_reason": getattr(q, "declined_reason", None),
        "declined_by_name": getattr(q, "declined_by_name", None),
        "requested_changes_message": getattr(q, "requested_changes_message", None),
        "requested_changes_at": _iso(getattr(q, "requested_changes_at", None)),
        "created_at": _iso(q.created_at),
        "updated_at": _iso(q.updated_at),
    }


def _intake_summary(intake) -> Optional[dict]:
    """Compact view of the original request (LeadIntake) a quote came from, for
    the "Original request" card on the quote editor/detail — so staff can see
    exactly what the customer asked for while writing the quote. Only the
    customer-facing request fields; no internal notes/assignment."""
    if not intake:
        return None
    loc = ", ".join(p for p in [
        intake.city, intake.state, intake.zip_code] if p) or None
    return {
        "id": intake.id,
        "name": intake.name,
        "email": intake.email,
        "phone": intake.phone,
        "address": intake.address,
        "location": loc,
        "service_type": intake.service_type,
        "requested_service": getattr(intake, "requested_service", None),
        "bedrooms": intake.bedrooms,
        "bathrooms": intake.bathrooms,
        "square_footage": intake.square_footage,
        "guests": intake.guests,
        "condition": getattr(intake, "condition", None),
        "pet_hair": getattr(intake, "pet_hair", None),
        "frequency": intake.frequency,
        "requested_date": intake.requested_date,
        "preferred_date": intake.preferred_date,
        "preferred_time": intake.preferred_time,
        "check_in": intake.check_in,
        "check_out": intake.check_out,
        "estimate_min": intake.estimate_min,
        "estimate_max": intake.estimate_max,
        "message": intake.message,
        "source": intake.source,
        # Customer's preferred arrival window (custom_fields.arrival_window) so
        # the convert-to-job modal can pre-fill the crew's start/end from it.
        "arrival_window": (getattr(intake, "custom_fields", None) or {}).get("arrival_window"),
        "created_at": _iso(intake.created_at),
    }


def _quote_intake(db: Session, quote: Quote):
    """Find the LeadIntake behind a quote: the direct intake_id link, else the
    row that recorded this quote as its conversion target."""
    if getattr(quote, "intake_id", None):
        row = db.query(LeadIntake).filter(LeadIntake.id == quote.intake_id).first()
        if row:
            return row
    return db.query(LeadIntake).filter(LeadIntake.converted_quote_id == quote.id).first()


# Frequency codes → the cadence label the customer sees. Keys mirror
# modules.booking.pricing.FREQUENCY_FACTOR so the shown cadence and the price
# that cadence produced never disagree.
_FREQUENCY_LABELS = {
    "weekly": "Weekly",
    "biweekly": "Every 2 weeks",
    "bi-weekly": "Every 2 weeks",
    "monthly": "Monthly",
    "one-time": "One-time",
    "onetime": "One-time",
    "one time": "One-time",
}

# How heavy the clean is, in the customer's words (LeadIntake.condition).
_CONDITION_LABELS = {
    "maintenance": "Routine upkeep",
    "moderate": "Moderate — some buildup",
    "heavy": "Heavy — needs extra attention",
}

# Pet situation (LeadIntake.pet_hair). "none" is intentionally dropped — a
# "no pets" row is noise on a cleaning quote.
_PET_LABELS = {
    "some": "Some pet hair",
    "heavy": "Heavy pet hair",
}


def _fmt_home_size(bedrooms, bathrooms, square_footage) -> Optional[str]:
    """'3 bed · 2 bath · 2,000 sq ft' from whatever subset is known, or None.

    Tolerant of the mixed column types across the schema (Property/LeadIntake
    hold ints and a Float for baths): a value that won't coerce is skipped
    rather than raising, so a stray string can never break a quote send."""
    parts = []
    try:
        if bedrooms:
            parts.append(f"{int(bedrooms)} bed")
    except (TypeError, ValueError):
        pass
    try:
        if bathrooms:
            parts.append(f"{float(bathrooms):g} bath")
    except (TypeError, ValueError):
        pass
    try:
        if square_footage:
            parts.append(f"{int(square_footage):,} sq ft")
    except (TypeError, ValueError):
        pass
    return " · ".join(parts) or None


def build_service_details(db: Session, quote: Quote) -> list[dict]:
    """An ordered, customer-safe ``[{label, value}]`` summary of WHAT was
    requested, for the customer-facing quote surfaces (public page, email, PDF).

    Sourced from the structured request behind the quote — the linked
    ``LeadIntake`` (``_quote_intake``) plus the ``Property`` and the ``Quote``
    itself — so the customer can confirm the quote matches what they asked for
    before they accept or request changes. These structured fields already
    drive the estimate; this simply makes them visible instead of collapsing
    them into a single price line.

    Deliberately EXCLUDES access/entry material (entry method, lock/alarm/house
    codes, parking notes) and free-text special instructions: a quote link is a
    shareable bearer token, so those details belong on the internal
    Job/dispatch, never on a page anyone with the link can open. Returns ``[]``
    when nothing is derivable (e.g. a hand-built quote with no property), so
    every surface collapses the section cleanly."""
    intake = _quote_intake(db, quote)
    prop = getattr(quote, "property", None)
    cf = getattr(intake, "custom_fields", None) if intake is not None else None
    if not isinstance(cf, dict):
        cf = {}

    details: list[dict] = []

    def add(label, value):
        if isinstance(value, str):
            value = value.strip()
        if value in (None, "", []):
            return
        details.append({"label": label, "value": value if isinstance(value, str) else str(value)})

    # Home size — prefer the Property (the structured record that carries into
    # the Job) and fall back to the intake's self-reported numbers.
    beds = getattr(prop, "bedrooms", None) if prop is not None else None
    baths = getattr(prop, "bathrooms", None) if prop is not None else None
    sqft = getattr(prop, "square_footage", None) if prop is not None else None
    if intake is not None:
        beds = beds if beds is not None else intake.bedrooms
        baths = baths if baths is not None else intake.bathrooms
        sqft = sqft if sqft is not None else intake.square_footage
    add("Home size", _fmt_home_size(beds, baths, sqft))

    # STR / vacation-rental guest count (only meaningful when the customer gave one).
    guests = intake.guests if intake is not None else None
    if guests:
        add("Guests", guests)

    # Cadence — the quote is authoritative once the operator sets it; else the intake.
    freq = (quote.frequency or (intake.frequency if intake is not None else None) or "").strip().lower()
    if freq:
        add("Frequency", _FREQUENCY_LABELS.get(freq, freq.replace("-", " ").title()))

    # How heavy the clean is.
    cond = ((intake.condition if intake is not None else None) or "").strip().lower()
    if cond:
        add("Condition", _CONDITION_LABELS.get(cond, cond.title()))

    # Pets — only surfaced when there's hair to deal with.
    pet = ((intake.pet_hair if intake is not None else None) or "").strip().lower()
    if pet in _PET_LABELS:
        add("Pets", _PET_LABELS[pet])

    # Rooms/areas the customer flagged as priorities (custom_fields.focus_areas).
    focus = cf.get("focus_areas")
    if isinstance(focus, (list, tuple)):
        labels = [str(x).strip().replace("_", " ").title() for x in focus if str(x).strip()]
        if labels:
            add("Focus areas", ", ".join(labels))
    elif isinstance(focus, str):
        add("Focus areas", focus)

    # Requested / preferred date (whichever the customer supplied).
    if intake is not None:
        req_date = intake.requested_date or intake.preferred_date
        if req_date:
            add("Preferred date", fmt_long_date(req_date) or str(req_date))

    return details


def _ensure_public_token(quote: Quote) -> str:
    """Return the quote's public link token, generating one if missing."""
    if not quote.public_token:
        quote.public_token = secrets.token_urlsafe(32)
    return quote.public_token


def _get_quote_or_404(quote_id: int, db: Session, org_id: int = None) -> Quote:
    q = db.query(Quote).filter(Quote.id == quote_id)
    if org_id is not None:
        # MT-2: a quote in another workspace reads as 404; tolerate legacy NULL-org.
        q = q.filter(or_(Quote.org_id == org_id, Quote.org_id.is_(None)))
    quote = q.first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


def _assign_quote_number(quote: Quote) -> None:
    """Set a unique, human-readable quote number (QT-YYYY-####) from the row id
    so it's race-free."""
    quote.quote_number = f"QT-{_utcnow().year}-{quote.id:04d}"


# ========================
# Quote CRUD
# ========================

@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_quote(
    quote_data: QuoteCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
    org_id: int = Depends(current_org_id),
):
    """Create a quote from the Quoting UI (integer client_id + inline items)."""
    client = db.query(Client).filter(Client.id == quote_data.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    items = _items_to_dicts(quote_data.items)
    subtotal, tax, total = _compute_totals(items, quote_data.tax_rate, quote_data.discount)

    # Carry the customer's stated cadence onto the quote: prefer an explicit
    # value, else inherit it from the linked lead so a won quote can pre-fill
    # the recurring-plan setup without re-asking.
    intake = None
    if quote_data.intake_id:
        intake = db.query(LeadIntake).filter(LeadIntake.id == quote_data.intake_id).first()
    frequency = quote_data.frequency or (getattr(intake, "frequency", None) if intake else None)

    quote = Quote(
        client_id=quote_data.client_id,
        intake_id=quote_data.intake_id,
        opportunity_id=quote_data.opportunity_id,
        property_id=quote_data.property_id,
        created_by=getattr(current_user, "id", None),
        org_id=resolve_org_id(org_id, db),  # MT-2: stamp the caller's workspace
        # Temporary unique placeholder; replaced with QT-YYYY-#### after flush.
        quote_number=f"PENDING-{secrets.token_hex(8)}",
        title=quote_data.title,
        customer_message=quote_data.customer_message,
        internal_notes=quote_data.internal_notes,
        service_type=quote_data.service_type or "residential",
        frequency=frequency,
        address=quote_data.address,
        notes=quote_data.notes,
        items=items,
        custom_fields=quote_data.custom_fields or {},
        subtotal=subtotal,
        tax_rate=float(quote_data.tax_rate or 0),
        tax=tax,
        discount=float(quote_data.discount or 0),
        total=total,
        # Every quote is valid for 30 days (owner policy). Default when the UI
        # doesn't supply a date so the validity line is never empty/contradictory.
        valid_until=_parse_date(quote_data.valid_until) or (business_today() + timedelta(days=30)),
        status=quote_data.status or "draft",
    )
    db.add(quote)
    db.flush()  # assign id
    _assign_quote_number(quote)
    # Stamp the source lead as quoted. This is the ONLY quote-creation path
    # the live "Create Quote" button actually calls (Requests.jsx -> Quoting.jsx
    # -> here), unlike /intake/{id}/convert-to-quote which has no UI caller —
    # so without this, lead_intakes.status/converted_quote_id never advance
    # past "new"/"reviewed" and Requests list filtering by quoted status lies.
    if intake and not intake.converted_quote_id:
        intake.status = "quoted"
        intake.converted_quote_id = quote.id
    # Pipeline: surface this quote as a deal (reuse the client's active one).
    from utils.opportunity_helper import ensure_opportunity, advance_opportunity
    opp = ensure_opportunity(
        db, client_id=quote.client_id, org_id=getattr(quote, "org_id", None),
        title=quote.title, amount=quote.total, service_type=quote.service_type,
    )
    if opp:
        quote.opportunity_id = opp.id
        advance_opportunity(db, opp, "quoted", amount=quote.total)
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_quotes(
    db: Session = Depends(get_db),
    client_id: Optional[int] = Query(None),
    # Closes a linearity dead-end: a quote not yet converted to a job had no
    # path back from the Property page (PropertyDetail showed jobs but never
    # quotes, even though Quote.property_id has carried this link all along).
    property_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    org_id: int = Depends(current_org_id),
):
    """List quotes (most recent first), optionally filtered."""
    org_id = resolve_org_id(org_id, db)
    # MT-2: scope to the caller's workspace; tolerate legacy NULL-org rows.
    query = db.query(Quote).filter(or_(Quote.org_id == org_id, Quote.org_id.is_(None)))
    # isinstance guards (not `is not None`): in-process callers that predate
    # this param (e.g. tests calling list_quotes() directly, bypassing
    # FastAPI's request handling) don't pass property_id, so its default
    # arrives as the unresolved `Query(None)` sentinel object — truthy and
    # very much "is not None" — the same class of bug resolve_org_id() above
    # exists to guard against for org_id.
    if isinstance(client_id, int):
        query = query.filter(Quote.client_id == client_id)
    if isinstance(property_id, int):
        query = query.filter(Quote.property_id == property_id)
    if status:
        query = query.filter(Quote.status == status)
    else:
        # Archived (soft-deleted) quotes are hidden unless asked for explicitly.
        query = query.filter(Quote.status != "archived")
    quotes = query.order_by(Quote.created_at.desc()).offset(offset).limit(limit).all()
    return [_quote_dict(q) for q in quotes]


def _hours_since(ts) -> Optional[float]:
    """Hours elapsed since a stored timestamp, tolerant of naive vs tz-aware
    values (legacy rows may be naive; new writes are tz-aware UTC)."""
    if ts is None:
        return None
    t = ts if getattr(ts, "tzinfo", None) else ts.replace(tzinfo=timezone.utc)
    return (_utcnow() - t).total_seconds() / 3600.0


@router.get("/follow-ups", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def quotes_needing_follow_up(
    db: Session = Depends(get_db),
    sent_hours: float = Query(48, ge=0, description="Flag sent-but-unviewed quotes older than this many hours"),
    viewed_hours: float = Query(24, ge=0, description="Flag viewed-but-unaccepted quotes older than this many hours"),
):
    """Quotes that are waiting on the customer and due for a nudge (Journey E).

    Read-only — surfaces the list so the operator can act; it does NOT send
    anything. Two buckets, mirroring the audit's rules:
      - 'sent_not_viewed': sent > sent_hours ago and never opened.
      - 'viewed_not_accepted': opened > viewed_hours ago, still not accepted.
    A quote already nudged more recently than its bucket's window is suppressed
    (so it doesn't reappear every poll right after you follow up)."""
    candidates = (
        db.query(Quote)
        .filter(Quote.status.in_(["sent", "viewed"]))
        .order_by(Quote.sent_at.asc().nullslast())
        .all()
    )
    out = []
    for q in candidates:
        if not q.viewed_at:
            waited = _hours_since(q.sent_at)
            if waited is None or waited < sent_hours:
                continue
            reason, window = "sent_not_viewed", sent_hours
        else:
            waited = _hours_since(q.viewed_at)
            if waited is None or waited < viewed_hours:
                continue
            reason, window = "viewed_not_accepted", viewed_hours
        nudged = _hours_since(q.follow_up_sent_at)
        if nudged is not None and nudged < window:
            continue  # already followed up within this window
        row = _quote_dict(q)
        row["follow_up_reason"] = reason
        row["hours_waiting"] = round(waited, 1)
        out.append(row)
    return out


@router.get("/property-lookup", dependencies=[Depends(require_role("admin", "manager"))])
def property_lookup(address: str = Query(...), db: Session = Depends(get_db)):
    """Look up property specs (sqft/beds/baths/year) for an address to pre-fill a
    quote. Returns {enabled, specs}. Best-effort — disabled or no match yields
    specs=None and never errors. Defined before /{quote_id} so the static path
    wins over the int route."""
    from services.property_media import enrichment_enabled, property_specs
    from modules.settings.router import get_setting
    if not (address or "").strip() or not enrichment_enabled(db):
        return {"enabled": enrichment_enabled(db), "specs": None}
    return {"enabled": True, "specs": property_specs(address.strip(), get_setting(db, "rentcast_api_key"))}


@router.get("/property-photo", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def property_photo(address: str = Query(..., min_length=3, max_length=300), db: Session = Depends(get_db)):
    """Stream the Google Street View front-of-house photo for an ADDRESS — the
    same photo the customer sees on their quote, but keyed on the address so it
    works on the Requests page and in the quote composer BEFORE a quote exists.

    Authenticated (staff-only). 404 when the feature is off, no key is set, or
    Google has no imagery for the address — the frontend hides the <img> on a
    failed load, so a 404 is a normal, expected outcome. Defined before the
    /{quote_id} route so the static path wins."""
    from services.property_media import street_view_enabled, street_view_bytes
    from modules.settings.router import get_setting
    if not street_view_enabled(db):
        raise HTTPException(status_code=404, detail="No photo")
    img = street_view_bytes(address.strip(), get_setting(db, "google_maps_api_key"))
    if not img:
        raise HTTPException(status_code=404, detail="No photo")
    return StreamingResponse(
        BytesIO(img), media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/{quote_id}", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_quote(quote_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    return _quote_dict(_get_quote_or_404(quote_id, db, resolve_org_id(org_id, db)))


@router.get("/{quote_id}/details", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_quote_details(quote_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Full quote record for the detail page: the quote (incl. line items) plus
    its linked records — client, opportunity, property — and the job it was
    converted into, if any (Job.quote_id back-link)."""
    from database.models import Opportunity
    oid = resolve_org_id(org_id, db)
    quote = _get_quote_or_404(quote_id, db, oid)

    opp = None
    if quote.opportunity_id:
        opp = db.query(Opportunity).filter(Opportunity.id == quote.opportunity_id).first()
    prop = None
    if quote.property_id:
        prop = db.query(Property).filter(Property.id == quote.property_id).first()
    job = db.query(Job).filter(Job.quote_id == quote.id).first()
    client = quote.client

    return {
        **_quote_dict(quote),
        # Contact fields the detail page's Send panel prefills from.
        "client_email": getattr(client, "email", None) if client else None,
        "client_phone": getattr(client, "phone", None) if client else None,
        "opportunity": ({"id": opp.id, "title": opp.title, "stage": opp.stage} if opp else None),
        "property": ({"id": prop.id, "name": prop.name, "address": prop.address} if prop else None),
        "job": ({"id": job.id, "title": job.title, "status": job.status,
                 "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None} if job else None),
        # The original request this quote answers, so the detail/send page can
        # show it side-by-side while reviewing the quote.
        "intake": _intake_summary(_quote_intake(db, quote)),
    }


def _apply_update(quote: Quote, data: dict) -> None:
    """Apply a partial update dict, recomputing totals when pricing changes."""
    if "items" in data and data["items"] is not None:
        quote.items = _items_to_dicts(data["items"])
    if "custom_fields" in data and data["custom_fields"] is not None:
        quote.custom_fields = dict(data["custom_fields"])
    for field in ("title", "customer_message", "internal_notes", "service_type", "frequency", "address",
                  "notes", "status",
                  "client_id", "intake_id", "opportunity_id", "property_id"):
        if field in data and data[field] is not None:
            setattr(quote, field, data[field])
    if "valid_until" in data:
        # Keep the flat 30-day policy even on edit: never let it become null.
        quote.valid_until = _parse_date(data["valid_until"]) or (business_today() + timedelta(days=30))
    if "tax_rate" in data and data["tax_rate"] is not None:
        quote.tax_rate = float(data["tax_rate"])
    if "discount" in data and data["discount"] is not None:
        quote.discount = float(data["discount"])
    # Recompute money if anything affecting it changed.
    if any(k in data for k in ("items", "tax_rate", "discount")):
        quote.subtotal, quote.tax, quote.total = _compute_totals(
            quote.items, quote.tax_rate, quote.discount
        )
    # Stamp converted_at on the transition to 'converted' no matter which path
    # got here — the "Set up schedule" onboarding flow PATCHes status directly
    # rather than going through convert-to-job, and the conversion metric needs
    # the timestamp set there too.
    if quote.status == "converted" and not quote.converted_at:
        quote.converted_at = _utcnow()
    quote.updated_at = _utcnow()


@router.patch("/{quote_id}", dependencies=[Depends(require_role("admin", "manager"))])
def patch_quote(quote_id: int, quote_data: QuoteUpdate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Partial update (the Quoting UI uses PATCH for both edits and status)."""
    quote = _get_quote_or_404(quote_id, db, resolve_org_id(org_id, db))
    _apply_update(quote, quote_data.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


# PUT kept as an alias of PATCH for backward compatibility.
@router.put("/{quote_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_quote(quote_id: int, quote_data: QuoteUpdate, db: Session = Depends(get_db)):
    return patch_quote(quote_id, quote_data, db)


@router.delete("/{quote_id}", dependencies=[Depends(require_role("admin", "manager"))])
def delete_quote(quote_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Soft-delete (archive) a quote: hidden from lists but recoverable, and its
    linked data is preserved. Refuses to archive a quote already converted into a
    job — that would orphan the revenue→job link; cancel the job first."""
    quote = _get_quote_or_404(quote_id, db, resolve_org_id(org_id, db))
    if quote.status == "converted" or _existing_job_for_quote(db, quote):
        raise HTTPException(
            status_code=409,
            detail="This quote has been scheduled into a job. Cancel/delete the job first.",
        )
    quote.status = "archived"
    quote.archived_at = _utcnow()
    quote.updated_at = _utcnow()
    db.commit()
    return {"status": "archived", "id": quote.id}


@router.delete("/{quote_id}/permanent", dependencies=[Depends(require_role("admin"))])
def permanently_delete_quote(quote_id: int, db: Session = Depends(get_db)):
    """Hard-delete an archived quote (admin only) — for clearing test/junk quotes.

    Requires the quote be archived first (so this can't be a one-click way to
    destroy a live quote), and still refuses anything scheduled into a job.
    Recurring-schedule links are detached first so the delete can't be FK-blocked.
    Delivery audit rows in integration_events keep the historical send record
    intact (no FK back to quotes)."""
    from database.models import RecurringSchedule

    quote = _get_quote_or_404(quote_id, db)
    if quote.status != "archived":
        raise HTTPException(status_code=409, detail="Archive the quote before deleting it permanently.")
    if quote.status == "converted" or _existing_job_for_quote(db, quote):
        raise HTTPException(
            status_code=409,
            detail="This quote has been scheduled into a job. Cancel/delete the job first.",
        )
    # Detach the RESTRICT references so the row can actually be removed.
    db.query(RecurringSchedule).filter(RecurringSchedule.quote_id == quote.id).update(
        {RecurringSchedule.quote_id: None}, synchronize_session=False)
    db.query(Job).filter(Job.quote_id == quote.id).update(
        {Job.quote_id: None}, synchronize_session=False)
    db.delete(quote)
    db.commit()
    return {"status": "deleted", "id": quote_id}


# ========================
# Status transitions
# ========================

class QuoteSendRequest(BaseModel):
    channel: str = "email"                 # 'email' | 'sms' | 'both'
    email: Optional[str] = None
    phone: Optional[str] = None
    # Included in BOTH the email body and the SMS (it used to be SMS-only
    # while the send panel implied otherwise).
    custom_message: Optional[str] = None
    # Optional per-send overrides for the email envelope.
    subject: Optional[str] = None
    greeting: Optional[str] = None
    # Owner copy: blind-copy the business on the customer email. When omitted,
    # the configured company email is used; pass "" to explicitly skip the copy.
    copy_to: Optional[str] = None


@router.post("/{quote_id}/send", dependencies=[Depends(require_role("admin", "manager"))])
def send_quote(quote_id: int, body: QuoteSendRequest = QuoteSendRequest(), db: Session = Depends(get_db)):
    """Actually DELIVER the quote to the customer over the chosen channel(s), then
    mark it sent. Email attaches the PDF; SMS texts the public accept-link.

    Previously this only flipped the status and minted the link — nothing was
    delivered — so the UI's email/SMS picker was ignored and customers never
    received anything. Returns per-channel results: {"email": "sent", "sms": ...}.
    """
    quote = _get_quote_or_404(quote_id, db)
    # draft = first send; sent/viewed = a follow-up nudge (re-send);
    # changes_requested = the owner revised it and is sending the revised quote
    # back (which clears the change-request flag below).
    if quote.status not in ("draft", "sent", "viewed", "changes_requested"):
        raise HTTPException(status_code=400, detail=f"Cannot send a {quote.status} quote")
    # Send guard: never email a customer an empty or $0 quote. The pipeline is
    # PATCH-able, so a quote with no priced line items can reach here — block it
    # with a clear message instead of shipping a blank quote. Totals are computed
    # from the line items, so an empty quote nets to $0; guarding on the total
    # covers both "no line items" and "priced to zero/negative".
    if float(quote.total or 0) <= 0:
        raise HTTPException(
            status_code=400,
            detail="Add at least one priced line item — this quote totals $0 and can't be sent.",
        )
    prior_status = quote.status
    client = db.query(Client).filter(Client.id == quote.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    channel = (body.channel or "email").lower()
    want_email = channel in ("email", "both")
    want_sms = channel in ("sms", "both")
    if not (want_email or want_sms):
        raise HTTPException(status_code=400, detail=f"Unknown channel '{body.channel}'")

    token = _ensure_public_token(quote)
    app_base = app_base_url()
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
                company = _company_info(db)
                # Owner copy: default to the configured company email so the
                # owner always gets a copy; an explicit "" from the UI skips it,
                # and an explicit address overrides the default.
                owner_copy = (company.get("company_email") or "") if body.copy_to is None \
                    else (body.copy_to or "")
                # Front-of-house photo proxy URL (when enabled + address). The
                # PDF fetch and the email both skip gracefully if there's no
                # Street View coverage.
                photo_url = _property_photo_url(quote, db)
                # Structured "what you asked for" rows from the linked request,
                # shown on the PDF and the email so the customer can verify the
                # scope matches what they submitted (same source as the page).
                service_details = build_service_details(db, quote)
                pdf_bytes = QuotePDFService(
                    company_name=company["company_name"], company_email=company["company_email"] or "",
                    company_phone=company["company_phone"], brand_color=company["brand_color"],
                    terms=company["quote_terms"], logo_url=company.get("company_logo_url"),
                ).generate_quote_pdf(
                    quote_number=quote.quote_number, client_name=client.name,
                    client_email=client.email or "", client_phone=client.phone,
                    line_items=_pdf_line_items(quote), subtotal=quote.subtotal,
                    tax_amount=quote.tax, discount_amount=quote.discount,
                    total_amount=quote.total, notes=quote.notes, expires_at=quote.valid_until,
                    quote_title=quote.title, property_photo_url=photo_url,
                    quote_link=quote_link, address=format_address(quote.address),
                    service_type=quote.service_type, customer_message=quote.customer_message,
                    service_details=service_details,
                )
                # For the EMAIL we only embed the photo when Google actually has
                # imagery (a 404 proxy would show a broken image in mail clients).
                email_photo_url = None
                if photo_url:
                    try:
                        from services.property_media import has_street_view
                        from modules.settings.router import get_setting
                        if has_street_view(quote.address, get_setting(db, "google_maps_api_key")):
                            email_photo_url = photo_url
                    except Exception:
                        email_photo_url = None
                res = QuoteEmailService().send_quote_email(
                    to_email=to_email, client_name=client.name, quote_number=quote.quote_number,
                    # Authoritative first name from the client record; falls
                    # back to name-splitting inside the service when unset.
                    client_first_name=getattr(client, "first_name", None),
                    total_amount=float(quote.total or 0),
                    expires_at=fmt_long_date(quote.valid_until),
                    quote_link=quote_link, pdf_bytes=pdf_bytes, pdf_filename=f"{quote.quote_number}.pdf",
                    subject=(body.subject or "").strip() or None,
                    greeting=_safe_greeting(body.greeting),
                    # Send-time personal note wins; the quote's stored
                    # customer message is the default intro.
                    intro_message=(body.custom_message or "").strip()
                                  or (quote.customer_message or "").strip() or None,
                    quote_title=quote.title,
                    items=quote.items or [],
                    subtotal=quote.subtotal, tax=quote.tax, discount=quote.discount,
                    tax_rate=quote.tax_rate, address=format_address(quote.address),
                    bcc=owner_copy, property_photo_url=email_photo_url,
                    scope=quote.notes, service_type=quote.service_type,
                    service_details=service_details,
                )
                if res.get("success"):
                    results["email"] = "sent"
                    _log_integration(db, entity_type="quote", entity_id=quote.id, provider="email",
                                     action="send", status="ok", external_id=res.get("email_id"),
                                     recipient=to_email, commit=False)
                else:
                    results["email"] = "failed"
                    # Surface the REAL reason (not a generic string) so the
                    # owner/UI can tell an SMTP problem from a code bug.
                    real_error = str(res.get("error") or "email could not be sent")
                    errors.append(real_error)
                    logger.error(f"Quote {quote.id} email send failed: {real_error}")
                    _log_integration(db, entity_type="quote", entity_id=quote.id, provider="email",
                                     action="send", status="failed", recipient=to_email,
                                     detail=real_error, commit=False)
            except Exception as e:
                results["email"] = "failed"
                # PDF build / service construction can raise (e.g. the date
                # drift bug); record the actual exception, not "email could
                # not be sent", and capture the traceback.
                errors.append(str(e) or "email could not be sent")
                logger.exception(f"Quote {quote.id} email send error")
                _log_integration(db, entity_type="quote", entity_id=quote.id, provider="email",
                                 action="send", status="failed", recipient=to_email,
                                 detail=str(e), commit=False)

    if want_sms:
        to_phone = (body.phone or client.phone or "").strip()
        from utils.phone import is_deliverable_sms_number, normalize_e164
        if not to_phone:
            results["sms"] = "no phone number on file"
            errors.append("no phone number")
        elif not is_deliverable_sms_number(to_phone):
            # Twilio would silently reject / bill for placeholder-labelled or
            # malformed numbers. Fail cleanly here with a reason the UI can show.
            results["sms"] = "invalid phone number"
            errors.append("invalid phone number")
            _log_integration(db, entity_type="quote", entity_id=quote.id, provider="sms",
                             action="send", status="failed", recipient=to_phone,
                             detail="invalid phone number (placeholder or bad format)", commit=False)
        else:
            try:
                from integrations.twilio_client import send_sms
                from services.quote_email_service import build_quote_sms_body
                company_name = _company_info(db).get("company_name")
                msg = build_quote_sms_body(
                    quote=quote, client=client, company_name=company_name,
                    quote_link=quote_link, custom_message=body.custom_message,
                )
                sms_result = send_sms(to=(normalize_e164(to_phone) or to_phone), body=msg)
                results["sms"] = "sent"
                _log_integration(db, entity_type="quote", entity_id=quote.id, provider="sms",
                                 action="send", status="ok", external_id=sms_result.get("sid"),
                                 recipient=to_phone, commit=False)
            except Exception as e:
                results["sms"] = "failed"
                errors.append("text message could not be sent")
                logger.warning(f"Quote {quote.id} SMS send error: {e}")
                _log_integration(db, entity_type="quote", entity_id=quote.id, provider="sms",
                                 action="send", status="failed", recipient=to_phone,
                                 detail=str(e), commit=False)

    delivered = any(v == "sent" for v in results.values())
    # Delivery visibility: a failed send must not leave a silent "draft" —
    # record the attempt + reason so the UI can show a "send failed" state.
    quote.last_send_attempt_at = _utcnow()
    quote.last_send_error = None if delivered else ("; ".join(errors) or "delivery failed")
    if delivered:
        if prior_status == "draft":
            quote.status = "sent"
            quote.sent_at = _utcnow()
        elif prior_status == "changes_requested":
            # The owner revised the quote and sent it back. Move it to "sent"
            # and CLEAR the change-request flag so the list stops nagging
            # "revise and resend" — the ball is back in the customer's court.
            quote.status = "sent"
            quote.follow_up_sent_at = _utcnow()
            quote.requested_changes_at = None
            quote.requested_changes_message = None
        else:
            # A re-send of an already sent/viewed quote is a follow-up nudge:
            # keep the original status/sent_at (so the "viewed" signal and the
            # sent→accepted clock survive) and just record the nudge.
            quote.follow_up_sent_at = _utcnow()
    quote.updated_at = _utcnow()
    db.commit()
    db.refresh(quote)

    # Don't 502 when delivery fails: the public link IS the deliverable and it's
    # ready, so always return 200 with the link + per-channel results. The UI
    # shows what went out (and what didn't) and can offer the link to copy —
    # instead of a dead-end error with no way to share the quote.
    return {
        "quote_id": quote.id,
        "quote_number": quote.quote_number,
        "status": quote.status,
        "delivered": delivered,
        "results": results,
        "errors": errors,
        "public_token": token,
        "quote_link": quote_link,
    }


@router.post("/{quote_id}/generate-token", dependencies=[Depends(require_role("admin", "manager"))])
def generate_quote_token(quote_id: int, db: Session = Depends(get_db)):
    """Ensure a public token exists and return it + the shareable link."""
    quote = _get_quote_or_404(quote_id, db)
    token = _ensure_public_token(quote)
    quote.updated_at = _utcnow()
    db.commit()
    app_base = app_base_url()
    return {
        "public_token": token,
        "quote_link": f"{app_base}/quote/{token}",
    }


class AdminAcceptRequest(BaseModel):
    """Optional body for the admin accept endpoint. ``notify_customer`` lets the
    admin skip the customer receipt email when they're accepting on the customer's
    behalf (e.g. a verbal yes over the phone)."""
    notify_customer: bool = True


@router.post("/{quote_id}/accept", dependencies=[Depends(require_role("admin", "manager"))])
def accept_quote(quote_id: int, body: AdminAcceptRequest = None,
                 background_tasks: BackgroundTasks = None, db: Session = Depends(get_db)):
    """Admin-side accept. Runs the SAME side effects as the public accept link
    (convert to job / advance the opportunity to won / notify) via the shared
    finalizer, instead of the old stub that only flipped the status."""
    quote = _get_quote_or_404(quote_id, db)
    if quote.status in ("accepted", "declined", "converted"):
        raise HTTPException(status_code=400, detail=f"Quote has already been {quote.status}")
    quote.status = "accepted"
    quote.accepted_at = _utcnow()
    quote.updated_at = _utcnow()
    send_receipt = True if body is None else bool(body.notify_customer)
    _finalize_quote_accept(db, quote, background_tasks=background_tasks,
                           send_customer_receipt=send_receipt)
    db.refresh(quote)
    return _quote_dict(quote)


@router.post("/{quote_id}/decline", dependencies=[Depends(require_role("admin", "manager"))])
def decline_quote(quote_id: int, db: Session = Depends(get_db)):
    quote = _get_quote_or_404(quote_id, db)
    if quote.status in ("accepted", "declined"):
        raise HTTPException(status_code=400, detail=f"Quote has already been {quote.status}")
    quote.status = "declined"
    quote.declined_at = _utcnow()
    quote.updated_at = _utcnow()
    from utils.opportunity_helper import advance_for_quote
    advance_for_quote(db, quote, "lost", lost_reason="Quote declined")
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


# ========================
# Convert accepted quote -> Job
# ========================

def _quote_job_vocab(quote: Quote):
    """Map a quote's service_type onto the Job/Property type vocabularies."""
    svc = (quote.service_type or "residential").lower()
    job_type = "str_turnover" if svc in ("str", "str_turnover") else (
        "commercial" if svc == "commercial" else "residential")
    prop_type = "str" if svc in ("str", "str_turnover") else (
        "commercial" if svc == "commercial" else "residential")
    return svc, job_type, prop_type


_SERVICE_TITLES = {
    "residential": "Residential Cleaning",
    "commercial": "Commercial Cleaning",
    "str": "Turnover Cleaning",
    "str_turnover": "Turnover Cleaning",
    "deep_clean": "Deep Cleaning",
    "move_in_out": "Move-In / Move-Out Cleaning",
}

_US_STATE_RE = _re.compile(r"^[A-Za-z]{2}$")
_ZIP_RE = _re.compile(r"^\d{5}(-\d{4})?$")


def _service_title(service_type: str) -> str:
    key = (service_type or "residential").strip().lower()
    return _SERVICE_TITLES.get(key, (key.replace("_", " ").title() + " Cleaning"))


def _extract_town(address: Optional[str]) -> Optional[str]:
    """Best-effort town/city from a free-text address like
    '100 Congress Street, Portland, ME 04101' -> 'Portland'. Returns None when
    nothing looks like a city."""
    if not address:
        return None
    parts = [p.strip() for p in str(address).replace("\n", ",").split(",") if p.strip()]
    if not parts:
        return None
    # Drop a trailing "ME 04101" / "ME" / "04101" chunk, then the city is the
    # last remaining part (street lines come before it).
    while parts:
        last = parts[-1]
        toks = last.split()
        if _ZIP_RE.match(last) or _US_STATE_RE.match(last) or (
                len(toks) == 2 and _US_STATE_RE.match(toks[0]) and _ZIP_RE.match(toks[1])):
            parts.pop()
            continue
        break
    if len(parts) < 2:
        # Only one part left (just a street or just a name) — not a reliable city.
        return None
    town = parts[-1]
    # A lone street ("100 Congress Street") isn't a town; require it to not
    # start with a house number.
    if town and town.split()[0].isdigit():
        return None
    return town.title()


def _resolve_town(db: Session, quote: Quote, prop: Property) -> Optional[str]:
    """Town/city for a job title: structured Property.city first, then parse the
    property or quote address, then the client's city."""
    prop_city = (getattr(prop, "city", None) or "").strip() if prop else ""
    if prop_city:
        return prop_city.title()
    for addr in (getattr(prop, "address", None), quote.address):
        town = _extract_town(addr)
        if town:
            return town
    if quote.client_id:
        client = db.query(Client).filter(Client.id == quote.client_id).first()
        client_city = (getattr(client, "city", None) or "").strip() if client else ""
        if client_city:
            return client_city.title()
    return None


def _job_title_for_quote(db: Session, quote: Quote, prop: Property) -> str:
    """Title a job by town + service, e.g. 'Portland — Residential Cleaning'.
    Falls back to just the service when no town can be resolved."""
    town = _resolve_town(db, quote, prop)
    service = _service_title(quote.service_type)
    return f"{town} — {service}" if town else service


def _resolve_property_for_quote(db: Session, quote: Quote, prop_type: str) -> Property:
    """The client's existing property, or a new one created from the quote
    address (every Job needs a Property)."""
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
    return prop


def _existing_job_for_quote(db: Session, quote: Quote) -> Optional[Job]:
    return (db.query(Job).filter(Job.quote_id == quote.id)
            .order_by(Job.id.asc()).first())


def _convert_quote_to_job(
    db: Session,
    quote: Quote,
    *,
    scheduled_date: Optional[str] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    cleaner_ids: Optional[list] = None,
) -> Job:
    """Idempotent quote → Job conversion. Returns the Job, creating it and
    flipping the quote to 'converted' only if one doesn't already exist.

    When ``scheduled_date`` + ``start_time`` + ``end_time`` are all provided,
    delegates to :func:`modules.scheduling.router.create_job` so the same
    cleaner conflict / capacity / Google Free-Busy guards fire, the Google
    Calendar event is created, and any assigned cleaners get their
    Connecteam shifts — none of which happened when the convert path
    inserted the :class:`Job` row directly.

    Without a full schedule the Job lands as "unscheduled" via a direct
    insert; the Scheduling / Job Detail page auto-promotes to "scheduled"
    once an operator saves a date.
    """
    existing = _existing_job_for_quote(db, quote)
    if existing:
        if quote.status != "converted":
            quote.status = "converted"
            quote.converted_at = _utcnow()
            quote.updated_at = _utcnow()
            db.commit()
        return existing
    svc, job_type, prop_type = _quote_job_vocab(quote)
    prop = _resolve_property_for_quote(db, quote, prop_type)

    # Fully-scheduled conversion → reuse the Scheduling create-job path so
    # the same guards + calendar side effects run. It also flips the source
    # quote to "converted" and advances the opportunity, matching what this
    # helper would have done inline.
    if scheduled_date and start_time and end_time:
        from modules.scheduling.router import create_job, JobCreate
        payload = JobCreate(
            client_id=quote.client_id,
            title=_job_title_for_quote(db, quote, prop),
            job_type=job_type,
            scheduled_date=scheduled_date,
            start_time=start_time,
            end_time=end_time,
            address=quote.address or prop.address,
            quote_id=quote.id,
            opportunity_id=quote.opportunity_id,
            property_id=prop.id,
            cleaner_ids=[str(c) for c in (cleaner_ids or [])],
            notes=quote.notes,
        )
        # create_job's org_id is a FastAPI dependency (Depends(current_org_id))
        # that only resolves through real request injection; called in-process
        # like this it arrives as the unresolved Depends sentinel and silently
        # falls back to org 1 (see resolve_org_id), so every quote outside the
        # default workspace 404'd on "Client not found" here. Pass the quote's
        # own org explicitly instead of relying on that fallback.
        job_dict = create_job(payload, db=db, org_id=quote.org_id)
        job = db.query(Job).filter(Job.id == job_dict["id"]).first()
        return job

    # Unscheduled conversion → direct-insert. No calendar sync or cleaner
    # dispatch to run yet; the operator adds the date on the Scheduling page
    # and PATCH auto-promotes at that point.
    job = Job(
        client_id=quote.client_id,
        quote_id=quote.id,
        opportunity_id=quote.opportunity_id,
        property_id=prop.id,
        job_type=job_type,
        title=_job_title_for_quote(db, quote, prop),
        address=quote.address or prop.address,
        status="unscheduled",
        cleaner_ids=[str(c) for c in cleaner_ids] if cleaner_ids else [],
        notes=quote.notes,
        # BB-MT-01: unlike the scheduled path just above (which explicitly
        # passes quote.org_id to create_job for this exact reason), this
        # direct-insert left org_id NULL — every unscheduled quote→job
        # conversion then surfaced on EVERY workspace's board/brief via the
        # NULL-tolerant _org() filter, not just the quote's own org.
        org_id=quote.org_id,
    )
    db.add(job)
    quote.status = "converted"
    quote.converted_at = _utcnow()
    quote.updated_at = _utcnow()
    from utils.opportunity_helper import advance_for_quote
    advance_for_quote(db, quote, "won", close_date=str(business_today()))
    try:
        db.commit()
    except IntegrityError:
        # Two different things raise IntegrityError here and must not be
        # confused: (a) a concurrent convert won the race and inserted the
        # job first — jobs.quote_id's unique index rejected ours, and the
        # winner is now findable by quote_id; (b) any OTHER constraint
        # violation (e.g. schema drift between a CHECK constraint and a
        # status value the app actually uses — see migration 053, where
        # status="unscheduled" above violated a CHECK constraint that had
        # never been updated for it). Silently treating (b) as (a) meant the
        # job was simply never created, the quote never flipped to
        # 'converted', and the caller got back None with no error at all —
        # for a schema-drift class of bug specifically, that's a silent
        # total failure of quote-to-job conversion. Only swallow the error
        # when a winning job can actually be found; otherwise this wasn't a
        # race, so let the real error surface instead of returning None
        # (this function's return type is Job, never Optional[Job]).
        db.rollback()
        winner = _existing_job_for_quote(db, quote)
        if winner is None:
            raise
        return winner
    db.refresh(job)
    return job


class ConvertToJobRequest(BaseModel):
    """Optional scheduling details supplied from the Convert-to-Job modal.
    All fields may be omitted, in which case the resulting Job lands as
    'unscheduled' and the operator picks the date on the Scheduling page.
    """
    scheduled_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    cleaner_ids: Optional[list] = None


@router.post("/{quote_id}/convert-to-job", dependencies=[Depends(require_role("admin", "manager"))])
def convert_quote_to_job(
    quote_id: int,
    payload: Optional[ConvertToJobRequest] = None,
    db: Session = Depends(get_db),
):
    """Create a Job from a quote. Accepts an optional payload with
    scheduled_date, start_time, end_time, cleaner_ids so the modal can
    schedule at conversion time; if the payload is absent or empty the
    Job lands as 'unscheduled' and the operator finishes on the
    Scheduling page. Every Job needs a Property, so we reuse the
    client's existing property or create one from the quote address."""
    quote = _get_quote_or_404(quote_id, db)
    p = payload or ConvertToJobRequest()
    job = _convert_quote_to_job(
        db, quote,
        scheduled_date=p.scheduled_date,
        start_time=p.start_time,
        end_time=p.end_time,
        cleaner_ids=p.cleaner_ids,
    )
    return {
        "id": job.id,
        "client_id": job.client_id,
        "quote_id": job.quote_id,
        "property_id": job.property_id,
        "title": job.title,
        "status": job.status,
        "job_type": job.job_type,
        "scheduled_date": str(job.scheduled_date) if job.scheduled_date else None,
        "start_time": str(job.start_time) if job.start_time else None,
        "end_time": str(job.end_time) if job.end_time else None,
        "cleaner_ids": job.cleaner_ids or [],
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


class PublicScheduleRequest(BaseModel):
    date: str                      # YYYY-MM-DD
    window: str = "morning"        # 'morning' | 'afternoon'
    name: Optional[str] = None
    email: Optional[str] = None


# Customer-facing arrival windows. The owner confirms the exact time; the job
# carries a concrete start/end so it lands on the calendar.
SCHEDULE_WINDOWS = {"morning": ("09:00", "12:00"), "afternoon": ("13:00", "16:00")}
AVAILABILITY_DAYS = 42  # how far ahead a customer can self-schedule


def _quote_availability(db: Session) -> list:
    """Bookable days over the next AVAILABILITY_DAYS. A day is unavailable when
    every cleaner in the roster is on time-off (so no one could do it); Sundays
    are closed. Roster is derived from real assignments, so with no cleaners on
    record every business day is offered."""
    from modules.scheduling.router import _cleaner_roster, _find_unavailable_cleaners
    roster = _cleaner_roster(db)
    today = business_today()
    out = []
    for i in range(1, AVAILABILITY_DAYS + 1):
        d = today + timedelta(days=i)
        if d.weekday() == 6:       # Sunday: closed
            continue
        available = True
        if roster:
            off = {cid for cid, _ in _find_unavailable_cleaners(
                db, cleaner_ids=roster, scheduled_date=d)}
            available = len(off) < len(roster)
        out.append({"date": d.isoformat(), "available": available})
    return out


def _quote_by_token(token: str, db: Session) -> Quote:
    quote = db.query(Quote).filter(Quote.public_token == token).first()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    return quote


def _company_info(db: Session) -> dict:
    """Customer-facing business identity: Settings rows first, env fallback.
    Powers the public quote page footer and the quote email."""
    from modules.settings.router import get_setting, quote_policies_text
    return {
        "company_name": get_setting(db, "company_name") or os.getenv("COMPANY_NAME", DEFAULT_COMPANY_NAME),
        "company_email": (get_setting(db, "company_email") or os.getenv("COMPANY_EMAIL")
                          or get_setting(db, "from_email") or os.getenv("SMTP_USER")),
        "company_phone": get_setting(db, "company_phone") or os.getenv("COMPANY_PHONE"),
        "quote_terms": get_setting(db, "quote_terms") or None,
        # Customer-facing service policies (pickup, access, 24h cancellation…).
        # Always present — falls back to a sensible professional default.
        "quote_policies": quote_policies_text(db),
        # Header band color for every customer-facing quote surface (page,
        # email, PDF). Defaults to the email's original slate.
        "brand_color": get_setting(db, "brand_color") or "#1f2937",
        # Optional logo shown on the page, email, and PDF — the biggest
        # "real business" signal. Falls back to the company name when unset.
        "company_logo_url": get_setting(db, "company_logo_url") or None,
    }


def _public_quote_dict(quote: Quote, db: Session) -> dict:
    """Client-facing serialization for the public accept page."""
    company = _company_info(db)
    # The customer opening this page IS the client on the quote — the
    # token was sent to their inbox/phone. Surface the name/email we
    # already have so the accept form prefills instead of asking them
    # to retype. Not a privacy leak: they already know their own info.
    client = None
    if quote.client_id:
        client = db.query(Client).filter(Client.id == quote.client_id).first()
    client_name = (client.name if client else None) or quote.accepted_by_name
    client_email = (client.email if client else None) or quote.accepted_by_email
    # If the stored name/email looks like a placeholder ("TEST", "Unknown",
    # a phone number), null it out so we ask instead of prefilling nonsense.
    if client_name and _PLACEHOLDER_GREETING.match(client_name.strip()):
        client_name = None
    return {
        "id": quote.id,
        "quote_number": quote.quote_number,
        "status": quote.status,
        "title": quote.title,
        "customer_message": getattr(quote, "customer_message", None),
        "company_name": company["company_name"],
        "company_email": company["company_email"],
        "company_phone": company["company_phone"],
        "terms": company["quote_terms"],
        "policies": company["quote_policies"],
        "brand_color": company["brand_color"],
        "company_logo_url": company["company_logo_url"],
        "quote_date": fmt_long_date(quote.created_at),
        "address": format_address(quote.address),
        "service_type": quote.service_type,
        "notes": quote.notes,
        # Structured "what you asked for" summary derived from the linked
        # request (intake/property). Lets the customer confirm the quote matches
        # their request before accepting; collapses when empty. See
        # build_service_details for the customer-safe field allowlist.
        "service_details": build_service_details(db, quote),
        "items": quote.items or [],
        "subtotal": quote.subtotal,
        "tax_rate": quote.tax_rate,
        "tax": quote.tax,
        # Discount was omitted here, so a discounted quote showed a Total lower
        # than Subtotal + Tax on the public page with no line explaining the
        # gap — while the email, PDF, and operator view all show it. Include it
        # so every surface the customer can see agrees.
        "discount": quote.discount,
        "total": quote.total,
        "valid_until": fmt_long_date(quote.valid_until),
        # Let the page render an "expired" state instead of letting Accept 409.
        "is_expired": _is_quote_expired(quote),
        # Front-of-house Street View photo (when enabled + a key + an address).
        # The page loads it through our proxy and hides it on error, so this is
        # a cheap "maybe" flag — no Google call happens here.
        "property_photo_url": _property_photo_url(quote, db),
        # Prefill for the accept form. Null when we don't have it — the UI
        # then asks. Never sent for placeholder-looking values.
        "client_name": client_name,
        "client_email": client_email,
    }


def _property_photo_url(quote: Quote, db: Session) -> Optional[str]:
    """Absolute URL to this quote's Street View photo proxy, or None when the
    feature is off / unconfigured / the quote has no address."""
    try:
        from services.property_media import street_view_enabled
        if quote.public_token and quote.address and street_view_enabled(db):
            return f"{app_base_url().rstrip('/')}/api/quotes/public/{quote.public_token}/property-photo"
    except Exception:
        pass
    return None


def _is_quote_expired(quote: Quote) -> bool:
    """True when the quote is past its validity window (tolerates a str
    valid_until from legacy/drifted rows)."""
    expiry = coerce_date(quote.valid_until)
    return bool(expiry and expiry < business_today())


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


def _notify_owner_quote_event_core(subject: str, lines: list, *, quote_number: str,
                                   client_name: str, total: float) -> None:
    """Primitive-only owner notification send. Takes plain values (not the ORM
    quote) so it is safe to run from a BackgroundTasks callback AFTER the request
    session has closed — lazy-loading quote.client there would raise
    DetachedInstanceError. Best-effort: never raises."""
    try:
        from integrations.email import _load_smtp_creds, send_email
        creds = _load_smtp_creds()
        owner = creds.get("from_email")
        if not owner:
            logger.info("[quotes] no owner email configured; skipping owner notification")
            return
        app_base = app_base_url()
        body_lines = lines + [
            "",
            f"Quote: {quote_number}",
            f"Customer: {client_name}",
            f"Total: ${float(total or 0):,.2f}",
            f"Open it: {app_base}/quoting",
        ]
        import html as _html
        body = "<br>".join(_html.escape(l) if l else "&nbsp;" for l in body_lines)
        send_email(to=owner, subject=subject, html_body=f"<div style='font-family:sans-serif'>{body}</div>",
                   text_body="\n".join(body_lines))
    except Exception as e:
        logger.warning(f"[quotes] owner notification failed for {quote_number}: {e}")


def _notify_owner_quote_event(db: Session, quote: Quote, subject: str, lines: list) -> None:
    """Email the business owner when a customer responds to a quote. Thin ORM
    wrapper around :func:`_notify_owner_quote_event_core` for the synchronous
    callers (request-changes, decline, schedule) that still have a live session."""
    _notify_owner_quote_event_core(
        subject, lines,
        quote_number=quote.quote_number,
        client_name=(quote.client.name if quote.client else "a customer"),
        total=float(quote.total or 0),
    )


def _send_customer_quote_confirmation_core(to_email: str, *, quote_number: str,
                                           total: float, accepted_name: str) -> None:
    """Primitive-only customer receipt send. Like the owner core, takes plain
    values so it can run from a BackgroundTasks callback after the session closes.
    Best-effort — never raises."""
    if not to_email or "@" not in to_email:
        return
    try:
        from integrations.email import _load_smtp_creds, send_email
        from services.quote_email_service import first_name_of
        creds = _load_smtp_creds()
        company = creds.get("from_name") or "Our team"
        name = first_name_of(accepted_name) or "there"
        total = f"${float(total or 0):,.2f}"
        lines = [
            f"Hi {name},",
            "",
            f"Thanks for accepting quote {quote_number} ({total}).",
            f"{company} will reach out shortly to schedule your service.",
            "",
            "Questions? Just reply to this email.",
        ]
        import html as _html
        body = "<div style='font-family:sans-serif;font-size:14px;color:#111'>" + \
            "<br>".join(_html.escape(l) if l else "&nbsp;" for l in lines) + "</div>"
        send_email(to=to_email, subject=f"Quote {quote_number} confirmed — thank you!",
                   html_body=body, text_body="\n".join(lines))
    except Exception as e:
        logger.warning(f"[quotes] customer confirmation email failed for {quote_number}: {e}")


def _send_customer_quote_confirmation(db: Session, quote: Quote, to_email: str) -> None:
    """Email the customer a receipt when they accept their quote. Thin ORM
    wrapper around the primitive core for synchronous callers."""
    _send_customer_quote_confirmation_core(
        to_email,
        quote_number=quote.quote_number,
        total=float(quote.total or 0),
        accepted_name=(quote.accepted_by_name or (quote.client.name if quote.client else "")),
    )


def _finalize_quote_accept(db: Session, quote: Quote, *, background_tasks=None,
                           send_customer_receipt: bool = True) -> None:
    """Side effects shared by the public accept link AND the admin accept endpoint.

    Precondition: the caller has already set ``quote.status = 'accepted'`` and the
    accept fields. This then, identically for both entry points:
      - logs the staff activity row (in-transaction),
      - advances the opportunity to 'won' — via auto-convert (which also creates
        the job) when a property is linked, or directly when there isn't one, so
        an accepted-but-unconverted quote still counts as won (audit items 7/10),
      - emails the owner + customer, backgrounded when a FastAPI BackgroundTasks
        is supplied so the customer's accept click doesn't block on serial SMTP.

    Commits the accept + opportunity/conversion before returning. Email inputs are
    captured up front so a backgrounded send is safe after the session closes."""
    _notify_staff_quote_event(db, quote, f"Client accepted quote {quote.quote_number}", "quote_accepted")

    # Capture everything the emails need NOW, while the ORM instance is live.
    qn = quote.quote_number
    who = quote.accepted_by_name or (quote.client.name if quote.client else "The customer")
    owner_kwargs = dict(
        quote_number=qn,
        client_name=(quote.client.name if quote.client else "a customer"),
        total=float(quote.total or 0),
    )
    customer_email = quote.accepted_by_email or (quote.client.email if quote.client else None)
    customer_kwargs = dict(
        quote_number=qn,
        total=float(quote.total or 0),
        accepted_name=(quote.accepted_by_name or (quote.client.name if quote.client else "")),
    )

    from utils.opportunity_helper import advance_for_quote
    converted = False
    if quote.property_id:
        db.commit()
        try:
            _convert_quote_to_job(db, quote)  # creates the job AND advances opp → won
            converted = True
        except Exception as e:
            logger.warning(f"[quotes] auto-convert on accept failed for {quote.id}: {e}")
    if not converted:
        # No property (or convert hiccup): still mark the deal won so pipeline
        # metrics don't undercount accepted-but-unconverted quotes.
        advance_for_quote(db, quote, "won", close_date=str(business_today()))
        db.commit()

    def _emails():
        _notify_owner_quote_event_core(
            f"✅ Quote {qn} accepted",
            [f"{who} accepted quote {qn}.",
             "You can convert it to a scheduled job from the Quoting page."],
            **owner_kwargs,
        )
        if send_customer_receipt:
            _send_customer_quote_confirmation_core(customer_email, **customer_kwargs)

    if background_tasks is not None:
        background_tasks.add_task(_emails)
    else:
        _emails()


@router.get("/public/{token}", dependencies=[Depends(rate_limit(120, 3600, "quote_view"))])
def public_view_quote(token: str, db: Session = Depends(get_db)):
    """Client-facing quote view. Marks the quote VIEWED on first open."""
    quote = _quote_by_token(token, db)
    if not quote.viewed_at:
        quote.viewed_at = _utcnow()
        if quote.status == "sent":
            quote.status = "viewed"
        _notify_staff_quote_event(db, quote, f"Client viewed quote {quote.quote_number}", "quote_viewed")
        db.commit()
        db.refresh(quote)
        # Web-push the staff: "someone's looking at your quote right now" is a
        # high-signal moment to follow up. Best-effort, no-op unless configured.
        try:
            from services.push_service import notify_staff
            who = (quote.client.name if quote.client else "A customer")
            notify_staff(
                db,
                "Quote viewed 👀",
                f"{who} just opened quote {quote.quote_number}",
                url="/billing?view=quotes",
                tag=f"quote-viewed-{quote.id}",
                org_id=getattr(quote, "org_id", None),
                category="quotes",
            )
        except Exception:
            pass
    return _public_quote_dict(quote, db)


@router.post("/public/{token}/accept", dependencies=[Depends(rate_limit(20, 3600, "quote_accept"))])
def public_accept_quote(token: str, data: PublicAcceptRequest = None,
                        background_tasks: BackgroundTasks = None, db: Session = Depends(get_db)):
    """Client accepts the quote from the public link."""
    quote = _quote_by_token(token, db)
    # Serialize concurrent accepts (double-tap / retry): lock the row so the
    # status guard and auto-convert below can't both run twice. (No-op on
    # SQLite tests; enforced on Postgres.)
    quote = db.query(Quote).filter(Quote.id == quote.id).with_for_update().first()
    # Idempotent: a double-tap (or re-open of an already-accepted/converted
    # link) must not revert status or re-fire conversion/notifications.
    if quote.status in ("accepted", "converted"):
        return {"status": quote.status, "quote_number": quote.quote_number}
    if quote.status == "declined":
        raise HTTPException(status_code=409, detail="This quote was declined and can no longer be accepted.")
    # valid_until can be a str (prod schema drift) — coerce before comparing,
    # or "date < str" raises TypeError and 500s the customer's accept click.
    expiry = coerce_date(quote.valid_until)
    if expiry and expiry < business_today():
        quote.status = "expired"
        db.commit()
        raise HTTPException(status_code=409, detail="This quote has expired. Please contact us for an updated quote.")

    quote.status = "accepted"
    quote.accepted_at = _utcnow()
    quote.updated_at = _utcnow()
    if data:
        quote.accepted_by_name = data.name or quote.accepted_by_name
        quote.accepted_by_email = data.email or quote.accepted_by_email
    # Notifications (owner + customer receipt) are backgrounded so the accept
    # click returns immediately instead of blocking on two serial SMTP sends;
    # auto-convert + opportunity-won run inline. See _finalize_quote_accept.
    _finalize_quote_accept(db, quote, background_tasks=background_tasks)
    return {"status": quote.status, "quote_number": quote.quote_number}


@router.post("/public/{token}/request-changes", dependencies=[Depends(rate_limit(20, 3600, "quote_changes"))])
def public_request_changes(token: str, data: PublicChangeRequest, db: Session = Depends(get_db)):
    """Client asks for changes instead of accepting — logged for staff."""
    quote = _quote_by_token(token, db)
    msg = (data.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Please include a message describing the changes.")
    # Persist the request on the quote (not just an activity line) and flag it so
    # the owner sees it needs attention.
    quote.requested_changes_message = msg
    quote.requested_changes_at = _utcnow()
    if quote.status in ("sent", "viewed", "draft"):
        quote.status = "changes_requested"
    quote.updated_at = _utcnow()
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


@router.post("/public/{token}/decline", dependencies=[Depends(rate_limit(20, 3600, "quote_decline"))])
def public_decline_quote(token: str, data: "PublicDeclineRequest" = None, db: Session = Depends(get_db)):
    """Client declines the quote from the public link."""
    quote = _quote_by_token(token, db)
    if quote.status == "accepted":
        raise HTTPException(status_code=409, detail="This quote was already accepted.")
    quote.status = "declined"
    quote.declined_at = _utcnow()
    quote.updated_at = _utcnow()
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
    from utils.opportunity_helper import advance_for_quote
    advance_for_quote(db, quote, "lost", lost_reason=reason or "Quote declined")
    db.commit()
    return {"status": "declined"}


@router.get("/public/{token}/pdf", dependencies=[Depends(rate_limit(60, 3600, "quote_pdf"))])
def public_quote_pdf(token: str, download: bool = False, db: Session = Depends(get_db)):
    """Stream the quote PDF from the public link so the customer can view/save it.

    The email only ever attached the PDF; this lets a customer who opened the
    link from an SMS (or wants it again later) download/print the same document.
    ``?download=1`` forces a save dialog; default opens inline in the browser.
    """
    quote = _quote_by_token(token, db)
    client = db.query(Client).filter(Client.id == quote.client_id).first()
    company = _company_info(db)
    pdf_bytes = QuotePDFService(
        company_name=company["company_name"], company_email=company["company_email"] or "",
        company_phone=company["company_phone"], brand_color=company["brand_color"],
        terms=company["quote_terms"], logo_url=company.get("company_logo_url"),
        policies=company["quote_policies"],
    ).generate_quote_pdf(
        quote_number=quote.quote_number,
        client_name=client.name if client else "",
        client_email=client.email if client else "",
        client_phone=client.phone if client else None,
        line_items=_pdf_line_items(quote), subtotal=quote.subtotal, tax_amount=quote.tax,
        discount_amount=quote.discount, total_amount=quote.total, notes=quote.notes,
        expires_at=quote.valid_until, quote_title=quote.title,
        property_photo_url=_property_photo_url(quote, db),
        quote_link=f"{app_base_url().rstrip('/')}/quote/{token}",
        address=format_address(quote.address), service_type=quote.service_type,
        customer_message=quote.customer_message,
        # Same Service Summary the public page and the emailed PDF show, so a
        # customer downloading the PDF from the link gets the identical document.
        service_details=build_service_details(db, quote),
    )
    disp = "attachment" if download else "inline"
    return StreamingResponse(
        BytesIO(pdf_bytes), media_type="application/pdf",
        headers={"Content-Disposition": f'{disp}; filename="{quote.quote_number}.pdf"'},
    )


@router.get("/public/{token}/property-photo", dependencies=[Depends(rate_limit(120, 3600, "quote_photo"))])
def public_quote_property_photo(token: str, db: Session = Depends(get_db)):
    """Stream the front-of-house Street View photo for the quote's address.

    Public (loaded by the quote page, email, and PDF). 404 when the feature is
    off, no key is set, or Google has no imagery — callers hide the image on a
    failed load, so a 404 is a normal, expected outcome."""
    from services.property_media import street_view_enabled, street_view_bytes
    quote = _quote_by_token(token, db)
    if not (quote.address and street_view_enabled(db)):
        raise HTTPException(status_code=404, detail="No photo")
    from modules.settings.router import get_setting
    img = street_view_bytes(quote.address, get_setting(db, "google_maps_api_key"))
    if not img:
        raise HTTPException(status_code=404, detail="No photo")
    return StreamingResponse(
        BytesIO(img), media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/public/{token}/availability", dependencies=[Depends(rate_limit(60, 3600, "quote_availability"))])
def public_quote_availability(token: str, db: Session = Depends(get_db)):
    """Bookable days + arrival windows for customer self-scheduling on accept."""
    _quote_by_token(token, db)  # 404s on a bad token
    return {
        "windows": [
            {"key": "morning", "label": "Morning (9am–12pm)"},
            {"key": "afternoon", "label": "Afternoon (1pm–4pm)"},
        ],
        "dates": _quote_availability(db),
    }


@router.post("/public/{token}/schedule", dependencies=[Depends(rate_limit(20, 3600, "quote_schedule"))])
def public_schedule_quote(token: str, data: PublicScheduleRequest, db: Session = Depends(get_db)):
    """Accept + self-schedule in one step: the customer picks a date and an
    arrival window; we accept the quote, convert it to a Job on that date (left
    unassigned for the owner), and push it to Google Calendar. Idempotent — if a
    job already exists for the quote (e.g. auto-converted on accept) it's re-dated
    rather than duplicated."""
    quote = _quote_by_token(token, db)
    if quote.status == "declined":
        raise HTTPException(status_code=409, detail="This quote was declined and can no longer be scheduled.")
    expiry = coerce_date(quote.valid_until)
    if expiry and expiry < business_today():
        quote.status = "expired"
        db.commit()
        raise HTTPException(status_code=409, detail="This quote has expired. Please contact us for an updated quote.")

    d = coerce_date(data.date)
    if not d or d < business_today():
        raise HTTPException(status_code=400, detail="Please choose a valid future date.")
    window = (data.window or "morning").lower()
    if window not in SCHEDULE_WINDOWS:
        raise HTTPException(status_code=400, detail="Please choose a morning or afternoon window.")
    # Re-check availability server-side so a stale page can't book a closed day.
    if not any(a["date"] == d.isoformat() and a["available"] for a in _quote_availability(db)):
        raise HTTPException(status_code=409, detail="That date is no longer available. Please pick another.")
    start, end = SCHEDULE_WINDOWS[window]

    # Accept the quote (capture who) if it isn't already.
    newly_accepted = quote.status in ("draft", "sent", "viewed")
    if newly_accepted:
        quote.status = "accepted"
        quote.accepted_at = _utcnow()
    if data.name:
        quote.accepted_by_name = data.name or quote.accepted_by_name
    if data.email:
        quote.accepted_by_email = data.email or quote.accepted_by_email
    quote.updated_at = _utcnow()
    db.commit()

    from modules.scheduling.router import (
        create_job, JobCreate, update_job, JobUpdate,
    )
    # Customer-facing self-schedule: bypass the same guards the operator's
    # UI uses. The customer has no way to react to a "double-booked cleaner"
    # or "Google Free/Busy" 409 — the message we used to surface literally
    # read "resubmit with allow_conflicts=true to book anyway" (seen on the
    # public quote page). Let the booking land; the owner gets the "quote
    # accepted & scheduled" alert immediately and can re-shuffle in Bright-
    # Space if there's a real collision.
    existing = _existing_job_for_quote(db, quote)
    try:
        if existing:
            # Re-date the already-created job (keeps one job per quote) + sync GCal.
            # org_id explicit for the same reason as the create_job call below —
            # in-process calls skip FastAPI's Depends resolution entirely.
            update_job(existing.id, JobUpdate(
                scheduled_date=d.isoformat(), start_time=start, end_time=end,
                allow_conflicts=True), db=db, org_id=quote.org_id)
            job_id = existing.id
        else:
            svc, job_type, prop_type = _quote_job_vocab(quote)
            prop = _resolve_property_for_quote(db, quote, prop_type)
            # Without org_id explicit, the Depends(current_org_id) default
            # arrives unresolved and falls back to org 1 (see resolve_org_id),
            # so this 404'd on "Client not found" for every quote outside the
            # default workspace — the customer saw "we couldn't lock that
            # slot" for a perfectly good date.
            created = create_job(JobCreate(
                client_id=quote.client_id, title=_job_title_for_quote(db, quote, prop),
                job_type=job_type, scheduled_date=d.isoformat(), start_time=start, end_time=end,
                address=quote.address or prop.address, property_id=prop.id, quote_id=quote.id,
                cleaner_ids=[], notes=quote.notes, allow_conflicts=True,
            ), db=db, org_id=quote.org_id)
            job_id = created["id"]
    except HTTPException as e:
        # Defense in depth: even with allow_conflicts=True, an unrelated
        # 400 (past date, end<=start) could bubble up. Rewrite the operator
        # phrasing so the customer never sees "resubmit with allow_conflicts=true".
        friendly = (
            "We couldn't lock that slot right now. Please pick another time "
            "or give us a call and we'll finish scheduling by hand."
        )
        raise HTTPException(status_code=e.status_code or 400, detail=friendly)

    nice_date = d.strftime("%B %d, %Y")
    win_label = "morning" if window == "morning" else "afternoon"
    who = quote.accepted_by_name or (quote.client.name if quote.client else "The customer")
    _notify_staff_quote_event(
        db, quote, f"Client self-scheduled quote {quote.quote_number} for {nice_date} ({win_label})",
        "quote_accepted")
    _notify_owner_quote_event(
        db, quote, f"📅 Quote {quote.quote_number} accepted & scheduled",
        [f"{who} accepted quote {quote.quote_number} and booked {nice_date} ({win_label}).",
         "A job was created (unassigned) and pushed to the calendar — assign a cleaner when ready."],
    )
    if newly_accepted:
        _send_customer_quote_confirmation(
            db, quote, quote.accepted_by_email or (quote.client.email if quote.client else None))

    return {
        "scheduled": True, "quote_number": quote.quote_number, "job_id": job_id,
        "date": d.isoformat(), "date_label": nice_date, "window": window,
    }


# ========================
# Quote Requests (web form intake)
#
# Backed by LeadIntake (source='quote_request') after consolidating the old
# quote_requests table into the canonical intake table. The public API shape is
# preserved (requester_name/email/phone/description/quote_id) so external
# callers don't break; internally each row is a LeadIntake.
# ========================

_QR_SOURCE = "quote_request"


def _qr_to_response(row: LeadIntake) -> dict:
    """Translate a LeadIntake row back into the quote_request response shape."""
    return {
        "id": row.id,
        "client_id": row.client_id,
        "requester_name": row.name,
        "requester_email": row.email,
        "requester_phone": row.phone,
        "service_type": row.service_type,
        "description": row.message,
        "status": row.status,
        "quote_id": row.converted_quote_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.post("/requests/", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_quote_request(request_data: QuoteRequestCreate, db: Session = Depends(get_db)):
    data = request_data.model_dump()
    pref = data.get("preferred_date")
    row = LeadIntake(
        client_id=data.get("client_id"),
        name=data["requester_name"],
        email=data.get("requester_email"),
        phone=data.get("requester_phone"),
        property_id=data.get("property_id"),
        service_type=data.get("service_type"),
        message=data.get("description"),
        preferred_date=pref.isoformat() if pref else None,
        preferred_time=data.get("preferred_time"),
        source=_QR_SOURCE,
        status="new",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"id": row.id, "status": row.status, "requester_name": row.name}


@router.get("/requests/", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_quote_requests(
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    query = db.query(LeadIntake).filter(LeadIntake.source == _QR_SOURCE)
    if status:
        query = query.filter(LeadIntake.status == status)
    rows = query.order_by(LeadIntake.created_at.desc()).offset(offset).limit(limit).all()
    return [_qr_to_response(r) for r in rows]


@router.put("/requests/{request_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_quote_request(request_id: int, request_data: QuoteRequestUpdate, db: Session = Depends(get_db)):
    row = (
        db.query(LeadIntake)
        .filter(LeadIntake.id == request_id, LeadIntake.source == _QR_SOURCE)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Quote request not found")
    updates = request_data.model_dump(exclude_unset=True)
    # Translate the public-API field names onto LeadIntake columns.
    if "quote_id" in updates:
        row.converted_quote_id = updates.pop("quote_id")
    if "description" in updates:
        row.message = updates.pop("description")
    if "preferred_date" in updates:
        pd = updates.pop("preferred_date")
        row.preferred_date = pd.isoformat() if pd else None
    for field, value in updates.items():
        setattr(row, field, value)
    row.updated_at = _utcnow()
    db.commit()
    return {"id": row.id, "status": row.status}


# ========================
# PDF & Email
# ========================

from services.quote_pdf_service import QuotePDFService
from services.quote_email_service import QuoteEmailService


def _pdf_line_items(quote: Quote) -> list:
    return [
        {
            "name": (i.get("name") or "").strip() or (i.get("description") or "").strip() or "Service",
            # Keep the sub-description separate from the name so the PDF can show
            # it as a secondary line, matching the customer web view.
            "description": (i.get("description") or "").strip() if i.get("name") else "",
            "quantity": float(i.get("qty", 1) or 0),
            "unit": None,
            "unit_price": float(i.get("unit_price", 0) or 0),
            "line_total": round(float(i.get("qty", 1) or 0) * float(i.get("unit_price", 0) or 0), 2),
        }
        for i in (quote.items or [])
    ]


@router.get("/{quote_id}/delivery-history", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def get_quote_delivery_history(quote_id: int, db: Session = Depends(get_db)):
    """Combined email + SMS delivery history, sorted newest first.

    Backed by IntegrationEvent — the same audit log the GCal sync writes to —
    after the per-channel quote_emails/quote_sms tables were retired."""
    quote = _get_quote_or_404(quote_id, db)
    rows = (
        db.query(IntegrationEvent)
        .filter(
            IntegrationEvent.entity_type == "quote",
            IntegrationEvent.entity_id == quote_id,
            IntegrationEvent.provider.in_(("email", "sms")),
            IntegrationEvent.action == "send",
        )
        .all()
    )
    history = [
        {
            "channel": r.provider,
            "recipient": _extract_recipient(r),
            "sent_at": r.created_at.isoformat() if r.created_at else None,
            "status": _ie_status(r),
            "external_id": r.external_id,
            "error": r.error_message,
        }
        for r in rows
    ]
    history.sort(key=lambda h: h["sent_at"] or "", reverse=True)
    return {
        "quote_id": quote.id,
        "quote_number": quote.quote_number,
        "total_deliveries": len(history),
        "history": history,
    }


# NOTE: the /webhooks/resend endpoint was removed — mail goes out over SMTP
# (smtplib), so Resend events never fired and QuoteEmail.delivery_status never
# advanced past "sent". Real delivered/bounced tracking is a separate future
# feature (switch sending to Resend/Gmail API), not a dead webhook.
