from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from pydantic import BaseModel, ConfigDict
from typing import Optional
import logging

from database.db import get_db
from modules.auth.router import require_role, current_org_id, resolve_org_id
from database.models import LeadIntake, Client, Quote
from modules.intake.normalize import build_intake, upsert_lead, _property_key
from utils.contacts import find_client_by_contact, add_contact_email, add_contact_phone
from ratelimit import limiter

router = APIRouter()
logger = logging.getLogger(__name__)


class IntakeSubmit(BaseModel):
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = "ME"
    zip_code: Optional[str] = None
    service_type: Optional[str] = "residential"
    # Full structured superset the website can send (the LeadIntake model has
    # columns for all of these; the schema used to silently drop most of them).
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None
    square_footage: Optional[int] = None
    guests: Optional[int] = None
    frequency: Optional[str] = None
    requested_date: Optional[str] = None
    check_in: Optional[str] = None
    check_out: Optional[str] = None
    estimate_min: Optional[float] = None
    estimate_max: Optional[float] = None
    property_name: Optional[str] = None
    message: Optional[str] = None
    preferred_date: Optional[str] = None
    source: Optional[str] = "website"
    # Up to 3 customer-attached photos of the space, as base64 data-URI
    # strings ("data:image/jpeg;base64,…"). Stored inline on custom_fields
    # (filtered + capped in submit_intake) so the Requests card can show
    # thumbnails without a media-storage dependency. Matches booking/submit.
    photos: Optional[list] = None
    # Client-supplied UUID for cross-endpoint dedup. Same key on two POSTs
    # (retry / dual-forward / user tapped Submit twice) = one Lead row.
    # Accept both camel and snake so callers in either style work — the
    # maineclean.co InstantEstimate form uses camelCase.
    idempotencyKey: Optional[str] = None
    idempotency_key: Optional[str] = None


class ManualIntakeCreate(BaseModel):
    """Staff-facing "+ New Request" form — manually adding a lead that came in
    by phone, walk-in, referral, etc. Distinct from IntakeSubmit/`/submit`,
    which is public, rate-limited, and defaults source="website"."""
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = "ME"
    zip_code: Optional[str] = None
    service_type: Optional[str] = "residential"
    message: Optional[str] = None


class IntakeUpdate(BaseModel):
    status: Optional[str] = None
    client_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    priority: Optional[str] = None
    assigned_to: Optional[str] = None
    internal_notes: Optional[str] = None
    custom_fields: Optional[dict] = None


def intake_to_dict(i: LeadIntake, quote=None) -> dict:
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
        "requested_service": getattr(i, "requested_service", None),
        "bedrooms": i.bedrooms,
        "bathrooms": getattr(i, "bathrooms", None),
        "square_footage": i.square_footage,
        "guests": getattr(i, "guests", None),
        "condition": getattr(i, "condition", None),
        "pet_hair": getattr(i, "pet_hair", None),
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
        "custom_fields": getattr(i, "custom_fields", None) or {},
        "client_id": i.client_id,
        "opportunity_id": getattr(i, "opportunity_id", None),
        # The quote this lead became — lets the UI link a quoted/converted lead
        # straight to its quote instead of dead-ending on the request.
        "converted_quote_id": getattr(i, "converted_quote_id", None),
        # Read-receipt passthrough: whether the customer has opened the quote we
        # sent for this request, so the Requests list can show "Opened" without a
        # second round-trip. Populated by get_intakes' batch quote load; None
        # when the lead has no quote yet or it hasn't been opened.
        "quote_status": getattr(quote, "status", None) if quote else None,
        "quote_viewed_at": (
            quote.viewed_at.isoformat() if quote and getattr(quote, "viewed_at", None) else None
        ),
        "created_at": i.created_at.isoformat() if i.created_at else None,
    }


def _resolve_client_for_intake(db: Session, intake: LeadIntake, org_id: int):
    """Return ``(client, created)`` for the Client this request should belong
    to, deduping against the existing book of business — this is the ONE place
    a request turns into a customer, now that inbound requests are inbox-only
    and never auto-create a client (see modules.intake.normalize.upsert_lead).

    Resolution order:
      1. An already-linked client (intake.client_id) — staff set it, trust it.
      2. An existing client matched on email/phone (find_client_by_contact,
         which also searches the multi-value contact tables) — reuse it instead
         of minting a duplicate for a returning customer.
      3. Otherwise create a fresh 'lead' client stamped with the caller's
         workspace.
    The request is linked to the resolved client, and the request's email/phone
    are recorded in the client's multi-value contact tables so a future request
    from the same person matches this client instead of spawning a duplicate.
    ``created`` is True only in case 3.
    """
    resolved_org = intake.org_id or resolve_org_id(org_id, db)
    client = None
    if intake.client_id:
        client = db.query(Client).filter(Client.id == intake.client_id).first()
    if client is None:
        match = find_client_by_contact(db, email=intake.email, phone=intake.phone)
        # Only reuse a match in the SAME workspace (or a legacy NULL-org client).
        # find_client_by_contact scans clients globally; without this guard a
        # customer who shares an email/phone with another tenant's client would
        # attach this request to — and then mutate — that foreign workspace's
        # record (and redirect the user to a client their scoped routes can't
        # read). A cross-org match falls through and creates a client in the
        # caller's own workspace instead.
        if match is not None and getattr(match, "org_id", None) in (None, resolved_org):
            client = match
    created = False
    if client is None:
        client = Client(
            name=intake.name, email=intake.email, phone=intake.phone,
            address=intake.address, city=intake.city, state=intake.state,
            zip_code=intake.zip_code, status="lead", source=intake.source,
            org_id=resolved_org,
        )
        db.add(client)
        db.flush()
        created = True
    # Record this request's contact points on the (possibly pre-existing)
    # client so the next request from the same person dedups to it.
    add_contact_email(db, client, intake.email, source=intake.source)
    add_contact_phone(db, client, intake.phone, source=intake.source)
    intake.client_id = client.id
    return client, created


_NO_ADDRESS = "(no address on file)"


def _resolve_property_for_intake(db: Session, client: Client, intake: LeadIntake,
                                 create_if_no_address: bool = True):
    """Attach the request's address to the client as a Property, reusing an
    existing one at the same normalized address (street+city+state+zip) instead
    of creating a duplicate. Back-fills size onto a reused property.

    When the request has no usable address:
      * with ``create_if_no_address=False`` (convert-to-client) → return None,
        so a contact-only lead doesn't get a fake-address property; and
      * with ``create_if_no_address=True`` (convert-to-quote, which needs a
        property for the quote/job) → reuse the client's existing placeholder
        property if one exists, else create a single "(no address on file)"
        one — so repeated no-address conversions don't each mint a new fake.
    """
    from database.models import Property

    has_address = bool((intake.address or "").strip())
    existing = db.query(Property).filter(Property.client_id == client.id).all()

    if has_address:
        target = _property_key(intake.address, intake.city, intake.state, intake.zip_code)
        prop = next(
            (p for p in existing
             if _property_key(p.address, p.city, p.state, p.zip_code) == target),
            None,
        )
    else:
        if not create_if_no_address:
            return None
        # Reuse the client's existing placeholder property rather than adding
        # another synthetic-address row on every contact-only conversion.
        prop = next(
            (p for p in existing if not (p.address or "").strip() or p.address == _NO_ADDRESS),
            None,
        )

    if prop:
        if intake.bedrooms and not prop.bedrooms:
            prop.bedrooms = intake.bedrooms
        if intake.bathrooms and not prop.bathrooms:
            prop.bathrooms = intake.bathrooms
        if intake.square_footage and not prop.square_footage:
            prop.square_footage = intake.square_footage
        return prop

    prop = Property(
        client_id=client.id,
        org_id=getattr(client, "org_id", None),
        name=intake.property_name or intake.address or f"{intake.name}'s property",
        address=intake.address if has_address else _NO_ADDRESS,
        city=intake.city, state=intake.state, zip_code=intake.zip_code,
        property_type=intake.service_type or "residential",
        bedrooms=intake.bedrooms, bathrooms=intake.bathrooms,
        square_footage=intake.square_footage,
    )
    db.add(prop)
    db.flush()
    return prop


@router.post("/submit", status_code=201)  # PUBLIC: leads from maineclean.co contact form
@limiter.limit("30/hour")
def submit_intake(request: Request, data: IntakeSubmit, db: Session = Depends(get_db)):
    """Public endpoint — called from maineclean.co contact/quote form.

    Goes through the single canonical intake path (see modules.intake.normalize):
    every structured field is persisted, the estimate is computed, and a visit
    that also hits /booking/submit or /webhook within 5 minutes merges into one
    lead instead of creating duplicates.
    """
    # Inline photo data-URIs → custom_fields.photos. Keep only well-formed
    # image data URIs and cap at 3 so a tampered/oversized payload can't bloat
    # the row — and NEVER log the contents (large + customer property).
    photos = [
        p for p in (data.photos or [])
        if isinstance(p, str) and p.startswith("data:image/")
    ][:3] or None
    payload = build_intake(
        name=data.name, email=data.email, phone=data.phone, address=data.address,
        city=data.city, state=data.state, zip_code=data.zip_code,
        service_key=data.service_type, bedrooms=data.bedrooms,
        bathrooms=data.bathrooms, square_footage=data.square_footage,
        guests=data.guests, frequency=data.frequency,
        requested_date=data.requested_date, check_in=data.check_in,
        check_out=data.check_out, estimate_min=data.estimate_min,
        estimate_max=data.estimate_max, property_name=data.property_name,
        message=data.message, preferred_date=data.preferred_date, source=data.source,
        custom_fields={"photos": photos} if photos else None,
        idempotency_key=data.idempotency_key or data.idempotencyKey,
    )
    return upsert_lead(db, payload)


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def get_intakes(
    status: Optional[str] = None,
    source: Optional[str] = None,
    service_type: Optional[str] = None,
    priority: Optional[str] = None,
    include_archived: bool = False,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
):
    """List intakes with filtering by status, source, service_type, priority.

    Archived leads are hidden from the default ("All") view — archiving is meant
    to get a request off the screen — and only reappear when the operator picks
    the Archived filter (status=archived) or passes include_archived=true. The
    old behavior returned archived rows in "All", so archiving didn't visibly do
    anything."""
    # MT-2: scope to the caller's workspace; tolerate legacy + public-submitted
    # NULL-org leads (the contact form has no logged-in user).
    q = db.query(LeadIntake).filter(or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)))
    if status:
        q = q.filter(LeadIntake.status == status)
    elif not include_archived:
        q = q.filter(LeadIntake.status != "archived")
    if source:
        q = q.filter(LeadIntake.source == source)
    if service_type:
        q = q.filter(LeadIntake.service_type == service_type)
    if priority:
        q = q.filter(LeadIntake.priority == priority)
    rows = q.order_by(LeadIntake.created_at.desc()).offset(offset).limit(limit).all()
    # Batch-load the linked quotes in one query (avoids an N+1) so each row can
    # report whether the customer has opened its quote.
    quote_ids = {r.converted_quote_id for r in rows if getattr(r, "converted_quote_id", None)}
    quotes_by_id = {}
    if quote_ids:
        for qt in db.query(Quote).filter(Quote.id.in_(quote_ids)).all():
            quotes_by_id[qt.id] = qt
    return [intake_to_dict(i, quotes_by_id.get(getattr(i, "converted_quote_id", None))) for i in rows]


@router.post("", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def create_intake(data: ManualIntakeCreate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Staff manually adds a lead (the Requests page's "+ New Request" button).

    Goes through the same canonical intake path as the public form
    (build_intake + upsert_lead) so it gets the same dedup and estimate
    computation — just authenticated, unlimited, and tagged source="manual"
    instead of "website". Like a website request it lands as an inbox row and
    does NOT auto-create a client/property; staff convert it explicitly.
    """
    payload = build_intake(
        name=data.name, email=data.email, phone=data.phone, address=data.address,
        city=data.city, state=data.state, zip_code=data.zip_code,
        service_key=data.service_type, message=data.message, source="manual",
    )
    result = upsert_lead(db, payload)
    intake = db.query(LeadIntake).filter(LeadIntake.id == result["intake_id"]).first()
    # A manual entry has a known author — stamp it to the caller's workspace
    # (upsert_lead defaults public rows to the default org; override that here
    # so a manager in another workspace sees their own manual request).
    if intake and not result.get("deduped"):
        intake.org_id = resolve_org_id(org_id, db)
        db.commit()
        db.refresh(intake)
    return intake_to_dict(intake)


@router.get("/stats", dependencies=[Depends(require_role("admin", "manager"))])
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


@router.get("/{intake_id}", dependencies=[Depends(require_role("admin", "manager"))])
def get_intake(intake_id: int, db: Session = Depends(get_db),
               org_id: int = Depends(current_org_id)):
    """One request, enriched with the LABELS of its linked records so the detail
    page can render clickable related-record cards (client / opportunity / quote)
    without a second round-trip. The base fields come from the shared
    intake_to_dict; ``linked`` carries just enough to render + navigate.

    Declared AFTER /stats so the static path wins; intake_id is int-typed so it
    never captures /stats regardless."""
    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")

    quote = None
    if getattr(intake, "converted_quote_id", None):
        quote = db.query(Quote).filter(Quote.id == intake.converted_quote_id).first()

    linked = {"client": None, "opportunity": None, "quote": None}
    if intake.client_id:
        c = db.query(Client).filter(Client.id == intake.client_id).first()
        if c:
            linked["client"] = {"id": c.id, "name": c.name, "status": c.status}
    if getattr(intake, "opportunity_id", None):
        from database.models import Opportunity
        o = db.query(Opportunity).filter(Opportunity.id == intake.opportunity_id).first()
        if o:
            linked["opportunity"] = {
                "id": o.id, "title": getattr(o, "title", None),
                "stage": getattr(o, "stage", None), "amount": getattr(o, "amount", None),
            }
    if quote:
        linked["quote"] = {
            "id": quote.id, "number": getattr(quote, "quote_number", None) or quote.id,
            "status": quote.status, "total": getattr(quote, "total", None),
        }

    return {**intake_to_dict(intake, quote), "linked": linked}


@router.patch("/{intake_id}", dependencies=[Depends(require_role("admin", "manager"))])
def update_intake(intake_id: int, data: IntakeUpdate, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")
    updates = data.model_dump(exclude_none=True)
    for field, value in updates.items():
        setattr(intake, field, value)
    db.commit()
    db.refresh(intake)
    return intake_to_dict(intake)


@router.delete("/{intake_id}", dependencies=[Depends(require_role("admin", "manager"))])
def delete_intake(intake_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")
    db.delete(intake)
    db.commit()
    return {"success": True}



@router.post("/{intake_id}/convert-to-client", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def convert_intake_to_client(intake_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Triage a request into a Client without creating a quote (Twenty-style
    "convert lead → contact"). Reuses an existing client/property when one
    matches (dedup) instead of minting duplicates, links the request, opens a
    pipeline deal, and marks the request reviewed.

    Idempotent: converting an already-linked request just returns its client.
    """
    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")

    client, created = _resolve_client_for_intake(db, intake, org_id)
    # A contact-only request (no address) becomes a Client with no property —
    # property_id comes back null instead of a synthetic "(no address)" row.
    prop = _resolve_property_for_intake(db, client, intake, create_if_no_address=False)
    if intake.status in (None, "new"):
        intake.status = "reviewed"

    # Open (or reuse) the client's active pipeline deal now that staff have
    # promoted this request to a customer.
    from utils.opportunity_helper import ensure_opportunity
    opp = ensure_opportunity(
        db, client_id=client.id, org_id=client.org_id, stage="new",
        title=client.name, service_type=intake.service_type,
        amount=intake.estimate_max or intake.estimate_min,
    )
    if opp:
        intake.opportunity_id = opp.id

    db.commit()
    return {
        "success": True,
        "client_id": client.id,
        "property_id": prop.id if prop else None,
        "created_client": created,
        "matched_existing": not created,
        "intake_id": intake.id,
    }


@router.post("/{intake_id}/convert-to-quote", status_code=201, dependencies=[Depends(require_role("admin", "manager"))])
def convert_intake_to_quote(intake_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Convert an intake to a quote with sensible defaults."""
    from database.models import Quote

    intake = db.query(LeadIntake).filter(
        LeadIntake.id == intake_id,
        or_(LeadIntake.org_id == resolve_org_id(org_id, db), LeadIntake.org_id.is_(None)),  # MT-2 tenant scope
    ).first()
    if not intake:
        raise HTTPException(status_code=404, detail="Intake not found")

    # Idempotent: a double-click on "Create Quote", a duplicate LeadIntake
    # from the pre-fix M2 dedup bug, or a stale browser tab resubmitting
    # would otherwise each mint an independent Quote for the same request
    # (the July-2026 audit's M3 finding — a stray extra quote with its own
    # hand-typed price). If this intake was already converted, return the
    # existing quote instead of creating a second one.
    if intake.converted_quote_id:
        from modules.quoting.router import _quote_dict
        existing_quote = db.query(Quote).filter(Quote.id == intake.converted_quote_id).first()
        if existing_quote:
            return _quote_dict(existing_quote)

    # Resolve (dedup-or-create) the client — inbound requests are inbox-only,
    # so this is where a request first becomes a customer. Reuses an existing
    # client matched on email/phone instead of minting a duplicate.
    client, _ = _resolve_client_for_intake(db, intake, org_id)
    client_id = client.id

    # Skip re-appending components already baked into intake.address (the
    # maineclean.co /book flow POSTs the whole "street, city, ME, zip" string
    # into address and leaves city/zip_code NULL — a blind join here would
    # append a second ", ME" and, on the older " ".join, produce "…, 04061 ME"
    # with no separator). Audit July-2026 L1/L3.
    from utils.address import combine_address
    address = combine_address(intake.address, intake.city, intake.state, intake.zip_code)

    # Carry the customer's structured request onto a Property so the quote (and
    # later the job) start from real data instead of re-typing. Reuses an
    # existing property at the same normalized address; otherwise creates one.
    prop = _resolve_property_for_intake(db, client, intake)

    # Seed the first line item's price from the website "instant quote" estimate
    # (midpoint of the range) so the operator starts from the customer's number
    # instead of $0. This MUST match the operator's Create-Quote seed
    # (frontend Quoting.jsx openQuoteForm): round the midpoint to the nearest
    # $5 and bake in NO tax, so the seeded total equals the $5-rounded midpoint
    # and stays inside the [min, max] range the customer was shown. The old
    # version rounded to cents and hard-coded 5.5% tax, which pushed the total
    # above estimate_max and off the $5 grid — a quote the customer never saw.
    def _round5(n: float) -> int:
        return int(n / 5 + 0.5) * 5  # half-up on the $5 grid, mirrors JS Math.round
    est = None
    if intake.estimate_min is not None and intake.estimate_max is not None:
        est = _round5((intake.estimate_min + intake.estimate_max) / 2)
    elif intake.estimate_max is not None:
        est = _round5(intake.estimate_max)
    elif intake.estimate_min is not None:
        est = _round5(intake.estimate_min)
    unit_price = float(est or 0)
    tax_rate = 0.0
    subtotal = round(unit_price, 2)
    tax = round(subtotal * tax_rate / 100, 2)
    total = round(subtotal + tax, 2)

    import secrets
    from modules.quoting.router import _assign_quote_number, _quote_dict

    quote = Quote(
        client_id=client_id,
        intake_id=intake_id,
        property_id=prop.id,
        org_id=intake.org_id or resolve_org_id(org_id, db),  # MT-2: inherit the lead's workspace
        # Temporary unique placeholder; replaced with QT-YYYY-#### after flush.
        quote_number=f"PENDING-{secrets.token_hex(8)}",
        address=address or None,
        service_type=intake.service_type or "residential",
        items=[{
            "name": f"{(intake.service_type or 'residential').title()} Cleaning",
            "qty": 1,
            "unit_price": unit_price,
            "description": "Estimated from website instant quote" if est else "",
        }],
        subtotal=subtotal,
        tax_rate=tax_rate,
        tax=tax,
        total=total,
        status="draft",
        notes=intake.message or "",
        valid_until=None,
    )
    db.add(quote)
    db.flush()
    _assign_quote_number(quote)
    intake.status = "quoted"
    intake.converted_quote_id = quote.id
    # Pipeline: advance the lead's deal to "quoted" and link the quote.
    from utils.opportunity_helper import ensure_opportunity, advance_opportunity
    opp = ensure_opportunity(
        db, client_id=client_id, org_id=intake.org_id,
        title=quote.title or (intake.service_type or "Quote"),
        amount=quote.total, service_type=intake.service_type,
    )
    if opp:
        quote.opportunity_id = opp.id
        intake.opportunity_id = opp.id
        advance_opportunity(db, opp, "quoted", amount=quote.total)
    db.commit()
    db.refresh(quote)
    return _quote_dict(quote)


# ---------------------------------------------------------------------------
# Webhook endpoint - accepts the maineclean.co InstantEstimate payload format
# Set CRM_WEBHOOK_URL=https://your-brightbase-backend.com/api/intake/webhook
# ---------------------------------------------------------------------------

class WebhookPayload(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    zip: Optional[str] = None
    serviceType: Optional[str] = None
    frequency: Optional[str] = None
    sqft: Optional[int] = None
    bathrooms: Optional[float] = None
    petHair: Optional[str] = None
    condition: Optional[str] = None
    estimateMin: Optional[float] = None
    estimateMax: Optional[float] = None
    notes: Optional[str] = None
    source: Optional[str] = "website"
    service: Optional[str] = None
    squareFeet: Optional[int] = None
    message: Optional[str] = None
    propertyType: Optional[str] = None
    # Client-supplied UUID for cross-endpoint dedup (see IntakeSubmit).
    idempotencyKey: Optional[str] = None
    idempotency_key: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


@router.post("/webhook", status_code=201)  # PUBLIC: maineclean.co InstantEstimate webhook posts here
@limiter.limit("30/hour")
def webhook_intake(request: Request, data: WebhookPayload, db: Session = Depends(get_db)):
    """
    Accepts the maineclean.co InstantEstimate payload OR CRM-forward payload.

    Maps the webhook's field names onto the canonical intake path, which computes
    the authoritative backend estimate (so the website and webhook can never
    disagree on the rate card). The customer's structured answers land in their
    own columns; ``message`` keeps only the free-text note. Any drift from the
    site-reported estimate is recorded in internal_notes for ops to review.
    """
    if not data.name and not data.email and not data.phone:
        return {"success": False, "error": "No contact info provided"}

    service_key = data.serviceType or data.service or data.propertyType or ""
    sqft = data.sqft or data.squareFeet
    notes_text = data.notes or data.message or ""

    payload = build_intake(
        name=data.name, email=data.email, phone=data.phone, address=data.address,
        city=data.city, zip_code=data.zip, service_key=service_key, bathrooms=data.bathrooms,
        square_footage=sqft, frequency=data.frequency, message=notes_text or None,
        source=data.source or "website",
        pet_hair=data.petHair, condition=data.condition,
        idempotency_key=data.idempotency_key or data.idempotencyKey,
    )
    result = upsert_lead(db, payload)

    # Record drift between the site's reported estimate and our canonical one so
    # ops can spot a stale rate card on the website — without polluting message.
    site_min, site_max = data.estimateMin, data.estimateMax
    if (
        not result.get("deduped")
        and payload.estimate_min is not None and payload.estimate_max is not None
        and site_min and site_max
        and (abs(float(site_min) - float(payload.estimate_min)) > 10
             or abs(float(site_max) - float(payload.estimate_max)) > 10)
    ):
        intake = db.query(LeadIntake).filter(LeadIntake.id == result["intake_id"]).first()
        if intake:
            intake.internal_notes = (
                f"Site reported ${site_min:.0f}-${site_max:.0f} vs canonical "
                f"${payload.estimate_min:.0f}-${payload.estimate_max:.0f} (review pricing)"
            )
            db.commit()
    return result
