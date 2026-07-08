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
import hashlib
import logging
import re

from sqlalchemy import or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database.models import LeadIntake, Client, Activity, Property
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
    # Free-form structured fields off the public payload — the /book flow's
    # on-site "essentials" (bedrooms is on the columns above; the rest —
    # entry method, parking, pets detail, focus areas, special instructions —
    # ride here so the operator sees them on the Request card without a
    # schema migration for every future essentials field the site adds.
    custom_fields: Optional[dict] = None
    # Client-supplied idempotency token — a per-submission UUID from the
    # maineclean.co form. Same key on two POSTs = same Lead row. See
    # LeadIntake.idempotency_key for the DB-side guarantee.
    idempotency_key: Optional[str] = None


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
    custom_fields: Optional[dict] = None,
    idempotency_key: Optional[str] = None,
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
        # Drop empty keys and empty values so the row's custom_fields stays
        # a compact {only what was actually sent}. Callers pass a dict with
        # all six /book essentials; anything untouched by the customer is
        # filtered here rather than the column carrying explicit nulls.
        custom_fields=(
            {
                k: v for k, v in (custom_fields or {}).items()
                if k and v not in (None, "", [])
            }
            or None
        ),
        idempotency_key=(idempotency_key or "").strip() or None,
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


def _normalize_addr(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _property_key(address, city, state, zip_code) -> tuple:
    """Normalized (address, city, state, zip) match key for property dedup.
    Comparing on the tuple — not the street line alone — is what stops a
    client whose two real properties are ``123 Main St, Portland`` and
    ``123 Main St, Bath`` from getting collapsed to one row."""
    return (
        _normalize_addr(address),
        _normalize_addr(city),
        _normalize_addr(state),
        _normalize_addr(zip_code),
    )


def _upsert_property_from_intake(db: Session, client: Client, data: IntakeData) -> None:
    """Attach the booking's address to the client as a Property so the client's
    Properties list reflects where they actually want service, not just their
    stale lead-phase primary. No-op when the booking has no address or the same
    address/city/state/zip is already on file. Best-effort — never raises.

    July-2026 audit M1: a returning customer booking a new address had that
    address show correctly on the fresh Request card, but the master Client
    record (and its Properties list) kept showing wherever they'd booked
    from months ago. upsert_lead's existing fix overwrites the CLIENT's
    contact fields (email/phone/address) with the latest submission, but a
    client can legitimately have several service addresses over time — this
    adds the new one as a Property instead of overwriting/losing the old one.
    """
    if not data.address:
        return
    try:
        target = _property_key(data.address, data.city, data.state or "ME", data.zip_code)
        existing = db.query(Property).filter(Property.client_id == client.id).all()
        for p in existing:
            if _property_key(p.address, p.city, p.state, p.zip_code) == target:
                return  # already tracked
        prop = Property(
            client_id=client.id,
            org_id=getattr(client, "org_id", None),
            name=data.property_name or data.address,
            address=data.address,
            city=data.city,
            state=data.state or "ME",
            zip_code=data.zip_code,
            property_type=data.service_type or "residential",
            bedrooms=data.bedrooms,
            bathrooms=data.bathrooms,
            square_footage=data.square_footage,
        )
        db.add(prop)
    except Exception as e:  # a property write must never block the lead
        logger.warning("intake property upsert failed for client %s: %s", client.id, e)


def _recent_lead_activity_exists(db: Session, client_id: int) -> bool:
    """True when this client already has a lead_created Activity inside the
    dedup window. Callers must hold a row lock on the client (via
    ``_lock_client_for_activity_write``) so the check-then-insert pair is
    atomic — otherwise two concurrent transactions both see 'no recent'
    and each write their own entry."""
    if not client_id:
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=DEDUP_WINDOW_MINUTES)
    return db.query(Activity.id).filter(
        Activity.client_id == client_id,
        Activity.activity_type == "lead_created",
        Activity.created_at >= cutoff,
    ).first() is not None


def _lock_client_for_activity_write(db: Session, client_id: int) -> None:
    """Take a row lock on the client so the ``lead_created`` check-then-insert
    is serialized across concurrent transactions. On Postgres this is a real
    SELECT ... FOR UPDATE; on SQLite (tests) with_for_update is a no-op, which
    is fine because SQLite already serializes writers."""
    if not client_id:
        return
    try:
        db.query(Client).filter(Client.id == client_id).with_for_update().first()
    except Exception as e:  # never block the lead on a locking hiccup
        logger.warning("client %s row lock failed: %s", client_id, e)


def _stable_lock_key(s: str) -> int:
    """Stable signed 64-bit int hash of ``s``, for use as a Postgres
    advisory-lock key (pg_advisory_xact_lock takes an int8)."""
    digest = hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest()
    val = int.from_bytes(digest, byteorder="big", signed=False)
    if val >= 1 << 63:
        val -= 1 << 64
    return val


def _contact_lock_keys(email: Optional[str], phone: Optional[str]) -> list:
    """One lock key PER identifying field present — NOT one combined hash.

    ``_find_recent_duplicate`` matches on ``email OR phone``, so two
    concurrent requests that share only ONE field (e.g. the same email,
    but one submission has no phone and the other does; or the same
    phone with a corrected email) must still serialize on that shared
    field. A single key derived from ``email + "|" + phone`` sends those
    two requests to two DIFFERENT locks — they'd never contend, and both
    could pass the recency SELECT before either INSERT lands (codex P1
    on PR #533). Locking each identifier independently means any two
    requests that share a value on either field always take at least
    one lock in common.

    Returns a SORTED, deduplicated list so callers acquire locks in a
    consistent order — required to avoid an ABBA deadlock between two
    transactions that each hold one lock and want the other's.
    """
    keys = []
    e = (email or "").strip().lower()
    if e:
        keys.append(_stable_lock_key("email:" + e))
    p = normalize_phone(phone) or ""
    if p:
        keys.append(_stable_lock_key("phone:" + p))
    return sorted(set(keys))


def _lock_contact_for_upsert(db: Session, email: Optional[str], phone: Optional[str]) -> None:
    """Serialize concurrent upsert_lead calls for the same person BEFORE the
    dedup check, so two near-simultaneous /api/booking/submit and
    /api/intake/webhook calls from one maineclean.co visit can't both pass
    ``_find_recent_duplicate`` and each insert a LeadIntake row (audit M2).

    The idempotency-key short-circuit (see upsert_lead's top) already
    collapses retries and the known dual-forward pattern when the caller
    supplies a key. This advisory lock is the backstop for the residual
    race: two truly concurrent requests with no shared key (or a genuine
    race on the SAME key before either has committed) that would otherwise
    both pass the recency SELECT before either INSERT lands.

    Postgres: ``pg_advisory_xact_lock`` on a hash of EACH identifying field
    present (see ``_contact_lock_keys``) — released on commit/rollback of
    the surrounding transaction (advisory_xact is the right variant so it
    never leaks past the request). SQLite: no-op — SQLite already
    serializes writers, so the read-then-insert pair inside a single
    connection is atomic by construction.
    """
    keys = _contact_lock_keys(email, phone)
    if not keys:
        return
    try:
        dialect = db.bind.dialect.name if db.bind is not None else ""
        if dialect == "postgresql":
            for k in keys:
                db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": k})
    except Exception as e:  # never block the lead on a locking hiccup
        logger.warning("contact upsert lock failed: %s", e)


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
    # Idempotency-key short-circuit — if the caller sent one and we've seen
    # it, return that Lead. Beats the 5-minute recency SELECT because it's
    # deterministic (not timing-dependent) and works across the maineclean.co
    # Express middle layer's dual-forward pattern (see brightbase.ts +
    # routes.ts /api/intake/submit handler). The DB unique index is the last
    # word — see migration 044.
    if data.idempotency_key:
        by_key = (
            db.query(LeadIntake)
            .filter(LeadIntake.idempotency_key == data.idempotency_key)
            .first()
        )
        if by_key is not None:
            return {
                "success": True,
                "intake_id": by_key.id,
                "client_id": by_key.client_id,
                "deduped": True,
            }

    # Serialize concurrent upserts for the same contact BEFORE the recency
    # SELECT below. Backstop for the residual M2 race that the idempotency
    # key doesn't cover (no key supplied, or a genuine race on the same
    # key before either side has committed) — see _lock_contact_for_upsert.
    _lock_contact_for_upsert(db, data.email, data.phone)

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
        # Shallow-merge custom_fields. The scalar _MERGE_FIELDS loop's
        # "fill-if-missing" rule is wrong for a dict — the earlier hit
        # (e.g. an intake-submit) may already have {} on the row, but the
        # follow-up booking submit's essentials are strictly newer info the
        # operator needs. Merge with incoming keys winning; assign a fresh
        # dict so SQLAlchemy's JSON change detection actually fires.
        if data.custom_fields:
            merged = {**(recent.custom_fields or {}), **data.custom_fields}
            if merged != (recent.custom_fields or {}):
                recent.custom_fields = merged
                changed = True
        # A lightweight first hit (e.g. the contact form, no address) that
        # merges with a follow-up booking submit carrying the service
        # address must still attach that address as a Property on the
        # matched client — otherwise the property upsert below (which only
        # runs on the non-dedup path) never fires for this visit.
        if data.address and recent.client_id:
            recent_client = db.query(Client).filter(Client.id == recent.client_id).first()
            if recent_client:
                _upsert_property_from_intake(db, recent_client, data)
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
        # Overwrite a placeholder name with the real lead's.
        if data.name and data.name != "Unknown" and looks_placeholder_name(client.name):
            client.name = data.name
        # The customer just typed their current contact info on a booking
        # form — treat it as authoritative, not "back-fill only if empty".
        # This is the M1 fix from the July-2026 audit: a returning customer
        # who books from a new address/phone was leaving their master client
        # record permanently stale (Requests page shows the fresh info; the
        # Client card kept the old). Before overwriting the primary email/
        # phone, copy the OLD value into the multi-value contact tables so a
        # legacy/manual client that only had the primary populated (no
        # matching contact_emails/contact_phones row) still stays matchable
        # via its old contact.
        if data.email and data.email != client.email:
            if client.email:
                add_contact_email(db, client, client.email, source="preserved_primary")
            client.email = data.email
        if data.phone and data.phone != client.phone:
            if client.phone:
                add_contact_phone(db, client, client.phone, source="preserved_primary")
            client.phone = data.phone
        if data.address and data.address != client.address:
            client.address = data.address
        if data.city and data.city != client.city:
            client.city = data.city
        # Only update state if it moved out of the "ME" default AND the new
        # value is non-empty — don't ever downgrade a real state to blank.
        if data.state and data.state != (client.state or ""):
            client.state = data.state
        if data.zip_code and data.zip_code != (client.zip_code or ""):
            client.zip_code = data.zip_code

    # Record the NEW lead's email/phone in the canonical multi-value tables
    # so a returning customer (or a Gmail thread) matches this client
    # instead of spawning a duplicate — even if it isn't the client's
    # primary contact. (The old primary was copied above before we
    # overwrote it, so history is preserved either way.)
    add_contact_email(db, client, data.email, source=data.source)
    add_contact_phone(db, client, data.phone, source=data.source)

    # July-2026 audit M1: attach the booking's address to the client as a
    # Property, so a returning customer's new service address is on file —
    # not just overwritten into the client's single primary address field
    # (which the block above already keeps current for the LATEST address).
    # A client can have several real service addresses over time; this
    # preserves all of them instead of losing the old one on every new booking.
    _upsert_property_from_intake(db, client, data)

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
        custom_fields=data.custom_fields or {},
        idempotency_key=data.idempotency_key,
    )
    # Race backstop: if two concurrent requests both pass the idempotency
    # SELECT above and both try to insert with the same key, the unique index
    # (migration 044) makes exactly one of them win. The loser catches
    # IntegrityError here, rolls back, and returns the winner's row — the
    # customer sees a single Lead either way.
    sp = db.begin_nested()
    try:
        db.add(intake)
        db.flush()
        sp.commit()
    except IntegrityError:
        sp.rollback()
        if data.idempotency_key:
            winner = (
                db.query(LeadIntake)
                .filter(LeadIntake.idempotency_key == data.idempotency_key)
                .first()
            )
            if winner is not None:
                return {
                    "success": True,
                    "intake_id": winner.id,
                    "client_id": winner.client_id,
                    "deduped": True,
                }
        raise
    try:
        # SELECT ... FOR UPDATE on the client row serializes the
        # check-then-insert so two concurrent submissions that both matched
        # this client (e.g. one has email-only, the other phone-only contact
        # info, so the advisory lock above hashed to different keys) can't
        # both pass _recent_lead_activity_exists and each add a timeline
        # entry for the same visit.
        _lock_client_for_activity_write(db, client.id)
        if not _recent_lead_activity_exists(db, client.id):
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
