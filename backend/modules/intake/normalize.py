"""Single canonical intake path for public website leads.

Before this module, three public endpoints — POST /api/booking/submit,
POST /api/intake/submit and POST /api/intake/webhook — each mapped the website
payload differently. The structured answers a customer typed (square footage,
bathrooms, frequency, estimate) were dropped at the API boundary or flattened
into the free-text ``message`` blob, even though the LeadIntake model has columns
for all of them. Dedup only worked inside one endpoint, so a single visit that
hit two endpoints produced duplicate leads.

Every entry point now:
  1. builds an :class:`IntakeData` via :func:`build_intake` (service-type mapping,
     phone normalization, and ALWAYS computing the canonical estimate), then
  2. persists via :func:`upsert_lead` (cross-entrypoint dedup keyed on
     email/phone, client match/create, all structured columns saved, and a
     ``lead_received`` timeline Activity).
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
import logging
import re

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import LeadIntake, Client, Activity
from utils.contacts import (
    find_client_by_contact, normalize_phone, add_contact_email, add_contact_phone,
)

logger = logging.getLogger(__name__)

# A single visit on maineclean.co is observed to POST to two endpoints in rapid
# succession; merge anything from the same person within this window into one lead.
DEDUP_WINDOW_MINUTES = 5

# Raw website service keys -> canonical service_type. (Consolidates the two
# near-identical maps that lived in booking/router.py and intake/router.py.)
SERVICE_TYPE_MAP = {
    "standard": "residential",
    "deep": "residential",
    "move-in-out": "residential",
    "move-in": "residential",
    "move-out": "residential",
    "residential": "residential",
    "residential-cleaning": "residential",
    "str": "str",
    "vacation-rental": "str",
    "airbnb": "str",
    "airbnb-turnover": "str",
    "commercial": "commercial",
    "office": "commercial",
    "commercial-cleaning": "commercial",
}

# Names we overwrite when a real website lead lands on a placeholder client, so
# the Quoting dropdown shows the real person rather than a stale test/import name.
_PLACEHOLDER_NAMES = (
    "brightbase webhook test", "test client", "unknown", "(unknown)", "n/a", "",
)


def canonical_service_type(service_key: Optional[str]) -> str:
    """Map a raw website service key to the canonical service_type."""
    return SERVICE_TYPE_MAP.get((service_key or "").strip().lower(), "residential")


# Common synonyms collapsed to one canonical source value so "Website" and
# "website" (or "contact form") don't fragment the source filter / stats.
_SOURCE_SYNONYMS = {
    "web": "website", "webform": "website", "web form": "website",
    "contact form": "website", "site": "website", "maineclean.co": "website",
    "www": "website", "online": "website",
    "phone call": "phone", "call": "phone",
    "text": "sms", "text message": "sms",
    "e-mail": "email", "gmail": "email",
}


def normalize_source(source: Optional[str]) -> str:
    """Canonicalize a lead source: lowercase, trim, collapse spaces, map
    synonyms. Defaults to 'website' (the public form is the main entrypoint)."""
    s = re.sub(r"\s+", " ", (source or "").strip().lower())
    if not s:
        return "website"
    return _SOURCE_SYNONYMS.get(s, s)


def looks_placeholder_name(name: Optional[str]) -> bool:
    if not name:
        return True
    n = name.strip().lower()
    if n in _PLACEHOLDER_NAMES:
        return True
    # All-digits / phone-only "names" (e.g. "+12075551234")
    return bool(re.fullmatch(r"\+?\d[\d\s().-]{5,}", n))


def _to_int(v) -> Optional[int]:
    """Coerce a possibly-float count (e.g. 2.5 baths from the webhook) to the
    Integer columns on LeadIntake, without 500-ing on bad input."""
    if v is None or v == "":
        return None
    try:
        return int(round(float(v)))
    except (ValueError, TypeError):
        return None


@dataclass
class IntakeData:
    """Normalized superset of everything the website can tell us about a lead."""
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: str = "ME"
    zip_code: Optional[str] = None
    service_type: str = "residential"          # canonical (mapped)
    bedrooms: Optional[int] = None
    bathrooms: Optional[int] = None
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
    source: str = "website"


def build_intake(
    *,
    name: Optional[str],
    email: Optional[str] = None,
    phone: Optional[str] = None,
    address: Optional[str] = None,
    city: Optional[str] = None,
    state: Optional[str] = "ME",
    zip_code: Optional[str] = None,
    service_key: Optional[str] = None,
    bedrooms=None,
    bathrooms=None,
    square_footage=None,
    guests=None,
    frequency: Optional[str] = None,
    requested_date: Optional[str] = None,
    check_in: Optional[str] = None,
    check_out: Optional[str] = None,
    estimate_min: Optional[float] = None,
    estimate_max: Optional[float] = None,
    property_name: Optional[str] = None,
    message: Optional[str] = None,
    preferred_date: Optional[str] = None,
    source: Optional[str] = "website",
    pet_hair: Optional[str] = None,
    condition: Optional[str] = None,
) -> IntakeData:
    """Normalize a raw public payload into :class:`IntakeData`.

    Maps the service type, normalizes the phone, and ALWAYS computes the
    canonical estimate from the structured fields when the caller didn't supply
    one — so every path (including the contact form, which used to save no price)
    stores estimate_min/estimate_max. The estimate engine gets the RAW service
    key so deep-clean / move-in-out multipliers are detected.
    """
    if estimate_min is None or estimate_max is None:
        try:
            from modules.booking.pricing import estimate_price
            est = estimate_price(
                service_type=service_key or "residential",
                bedrooms=_to_int(bedrooms),
                bathrooms=bathrooms,          # float ok for pricing (e.g. 2.5)
                square_footage=_to_int(square_footage),
                frequency=frequency,
                message=message,
                pet_hair=pet_hair,
                condition=condition,
            )
            estimate_min = est.get("estimate_min")
            estimate_max = est.get("estimate_max")
        except Exception as e:  # never let pricing failure drop a lead
            logger.warning("intake estimate computation failed: %s", e)

    return IntakeData(
        name=(name or "").strip() or "Unknown",
        email=(email or "").strip() or None,
        phone=normalize_phone(phone),
        address=address,
        city=city,
        state=state or "ME",
        zip_code=zip_code,
        service_type=canonical_service_type(service_key),
        bedrooms=_to_int(bedrooms),
        bathrooms=_to_int(bathrooms),
        square_footage=_to_int(square_footage),
        guests=_to_int(guests),
        frequency=frequency,
        requested_date=requested_date,
        check_in=check_in,
        check_out=check_out,
        estimate_min=estimate_min,
        estimate_max=estimate_max,
        property_name=property_name,
        message=message,
        preferred_date=preferred_date or requested_date,
        source=normalize_source(source),
    )


# Fields back-filled (fill-if-missing) onto an existing recent lead on dedup.
_MERGE_FIELDS = (
    "address", "city", "state", "zip_code", "service_type", "bedrooms",
    "bathrooms", "square_footage", "guests", "frequency", "requested_date",
    "check_in", "check_out", "estimate_min", "estimate_max", "property_name",
    "preferred_date",
)


def _find_recent_duplicate(db: Session, email: Optional[str], phone: Optional[str]):
    """Most recent lead from the same email/phone inside the dedup window."""
    if not (email or phone):
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=DEDUP_WINDOW_MINUTES)
    filters = []
    if email:
        filters.append(LeadIntake.email.ilike(email))
    if phone:
        filters.append(LeadIntake.phone == phone)
    return (
        db.query(LeadIntake)
        .filter(LeadIntake.created_at >= cutoff)
        .filter(or_(*filters))
        .order_by(LeadIntake.created_at.desc())
        .first()
    )


def _lead_summary(data: IntakeData) -> str:
    """Compact one-line summary for the timeline, e.g.
    'New residential lead · 2000 sqft · 2 bath · biweekly · $120–$135'."""
    bits = [f"New {data.service_type} lead"]
    if data.square_footage:
        bits.append(f"{data.square_footage} sqft")
    if data.bathrooms:
        bits.append(f"{data.bathrooms} bath")
    if data.frequency:
        bits.append(data.frequency)
    if data.estimate_min is not None and data.estimate_max is not None:
        bits.append(f"${data.estimate_min:.0f}–${data.estimate_max:.0f}")
    return " · ".join(bits)


def upsert_lead(db: Session, data: IntakeData) -> dict:
    """The single write path for public leads.

    Cross-entrypoint dedup (so one visit hitting two endpoints = one lead),
    client match/create with placeholder-name and contact back-fill, persistence
    of EVERY structured column, and a ``lead_received`` timeline Activity.
    Returns ``{success, intake_id, client_id, deduped}``.
    """
    recent = _find_recent_duplicate(db, data.email, data.phone)
    if recent:
        changed = False
        for f in _MERGE_FIELDS:
            val = getattr(data, f, None)
            if val not in (None, "") and not getattr(recent, f, None):
                setattr(recent, f, val)
                changed = True
        # Keep the longest free-text message (the richer note wins).
        if data.message and (not recent.message or len(data.message) > len(recent.message or "")):
            recent.message = data.message
            changed = True
        if changed:
            db.commit()
            db.refresh(recent)
        return {"success": True, "intake_id": recent.id, "client_id": recent.client_id, "deduped": True}

    client = find_client_by_contact(db, email=data.email, phone=data.phone)
    if not client:
        client = Client(
            name=data.name, email=data.email, phone=data.phone,
            address=data.address, city=data.city, state=data.state or "ME",
            zip_code=data.zip_code, status="lead", source=data.source,
        )
        db.add(client)
        db.flush()  # assign client.id without committing
    else:
        # Overwrite a placeholder name with the real lead's; back-fill contacts
        # so future lookups still match this client.
        if data.name and data.name != "Unknown" and looks_placeholder_name(client.name):
            client.name = data.name
        if data.email and not client.email:
            client.email = data.email
        if data.phone and not client.phone:
            client.phone = data.phone
        if data.address and not client.address:
            client.address = data.address

    # Record the lead's email/phone in the canonical multi-value tables so a
    # returning customer (or a Gmail thread) matches this client instead of
    # spawning a duplicate — even if it isn't the client's primary contact.
    add_contact_email(db, client, data.email, source=data.source)
    add_contact_phone(db, client, data.phone, source=data.source)

    intake = LeadIntake(
        name=data.name or client.name, email=data.email, phone=data.phone,
        address=data.address, city=data.city, state=data.state or "ME",
        zip_code=data.zip_code, service_type=data.service_type,
        bedrooms=data.bedrooms, bathrooms=data.bathrooms,
        square_footage=data.square_footage, guests=data.guests,
        frequency=data.frequency, requested_date=data.requested_date,
        check_in=data.check_in, check_out=data.check_out,
        estimate_min=data.estimate_min, estimate_max=data.estimate_max,
        property_name=data.property_name, message=data.message,
        preferred_date=data.preferred_date, source=data.source, client_id=client.id,
    )
    db.add(intake)
    db.flush()
    try:
        db.add(Activity(
            client_id=client.id,
            activity_type="lead_created",
            actor="website",
            summary=_lead_summary(data),
            extra_data={"intake_id": intake.id, "source": data.source},
        ))
    except Exception as e:  # a timeline write must never block the lead
        logger.warning("lead_received activity write failed: %s", e)

    # Pipeline: every lead becomes a deal in the "new" column.
    from utils.opportunity_helper import ensure_opportunity
    opp = ensure_opportunity(
        db, client_id=client.id, org_id=getattr(client, "org_id", None), stage="new",
        title=client.name, service_type=data.service_type,
        amount=data.estimate_max or data.estimate_min,
    )
    if opp:
        intake.opportunity_id = opp.id

    db.commit()
    db.refresh(intake)
    return {"success": True, "intake_id": intake.id, "client_id": client.id, "deduped": False}
