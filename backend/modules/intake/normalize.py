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
     email/phone, all structured columns saved).

Requests are an INBOX (Twenty-style): :func:`upsert_lead` creates ONLY a
LeadIntake row. It does not create or mutate a Client, Property, or
Opportunity — staff convert a request into a customer explicitly, and that
conversion is the single place client/property dedup happens. This is what
keeps a returning customer, a typo'd email, or a second phone number from
each spawning a duplicate client + property.
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

from database.models import LeadIntake
from utils.contacts import normalize_phone

logger = logging.getLogger(__name__)

# A single visit on maineclean.co is observed to POST to two endpoints in rapid
# succession; merge anything from the same person within this window into one lead.
DEDUP_WINDOW_MINUTES = 5

# Same NAME + same service ADDRESS but DIFFERENT contact info (a customer who
# filled the form on their phone with one email, then again on a laptop with
# another) won't match the contact-based dedup above — nothing links them. We
# still collapse those into one lead, but only inside a wider window: a repeat
# customer legitimately booking the same address weeks later is a NEW job, not
# a duplicate, so this must not reach back indefinitely. Matches older than
# this are surfaced as "possible duplicates" on the Requests page for the
# operator to merge/archive by hand instead of being auto-merged.
NAME_ADDR_DEDUP_WINDOW_MINUTES = 24 * 60

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


def _to_float(v) -> Optional[float]:
    """Coerce to float for the fractional columns (bathrooms — half-baths are
    real, e.g. 2.5). Never 500s on bad input."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


# Services the customer-facing site quotes by hand (STR / vacation-rental /
# commercial) — it shows NO instant number for these, so Bright-Space must not
# fabricate one either. A leftover auto-computed estimate on an STR lead is
# exactly the "STR quotes showing a price" bug. Keyed on the CANONICAL type.
_CUSTOM_QUOTE_CANONICAL = {"str", "commercial"}


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
    requested_service: Optional[str] = None    # raw service the customer picked (deep, move-in-out, …)
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None
    square_footage: Optional[int] = None
    guests: Optional[int] = None
    condition: Optional[str] = None            # maintenance | moderate | heavy
    pet_hair: Optional[str] = None             # none | some | heavy
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
    canonical = canonical_service_type(service_key)
    is_custom_quote = canonical in _CUSTOM_QUOTE_CANONICAL
    # Auto-compute the canonical estimate ONLY for services the site prices
    # instantly (residential). STR / commercial are quoted by hand — the
    # pricing engine itself now returns None for those (see estimate_price),
    # and this branch also skips the call as a defensive second layer — so
    # the Requests page and quote composer show "custom", not a fabricated
    # number the customer never saw.
    if not is_custom_quote and (estimate_min is None or estimate_max is None):
        try:
            from modules.booking.pricing import estimate_price
            est = estimate_price(
                service_type=service_key or "residential",
                bedrooms=_to_int(bedrooms),
                bathrooms=_to_float(bathrooms),   # float ok for pricing (e.g. 2.5)
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
    elif is_custom_quote:
        # Defensive: if an upstream caller passed a stale/derived range on a
        # custom-quote service, drop it so nothing downstream shows a price.
        estimate_min = None
        estimate_max = None

    return IntakeData(
        name=(name or "").strip() or "Unknown",
        email=(email or "").strip() or None,
        phone=normalize_phone(phone),
        address=address,
        city=city,
        state=state or "ME",
        zip_code=zip_code,
        service_type=canonical,
        requested_service=(service_key or "").strip().lower() or None,
        bedrooms=_to_int(bedrooms),
        bathrooms=_to_float(bathrooms),
        square_footage=_to_int(square_footage),
        guests=_to_int(guests),
        condition=(condition or "").strip().lower() or None,
        pet_hair=(pet_hair or "").strip().lower() or None,
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
    "address", "city", "state", "zip_code", "service_type", "requested_service",
    "bedrooms", "bathrooms", "square_footage", "guests", "condition", "pet_hair",
    "frequency", "requested_date",
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
        # Match on the normalized phone. Stored phones are normalized at
        # build_intake time, but normalizing the lookup too makes the recency
        # dedup robust to any caller that passes a raw/differently-formatted
        # number (defense in depth against a second lead for the same person).
        filters.append(LeadIntake.phone == (normalize_phone(phone) or phone))
    return (
        db.query(LeadIntake)
        .filter(LeadIntake.created_at >= cutoff)
        .filter(or_(*filters))
        .order_by(LeadIntake.created_at.desc())
        .first()
    )


def _normalize_addr(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _normalize_name(s: Optional[str]) -> str:
    """Loose name key for the name+address dedup — lowercased, whitespace
    collapsed, punctuation dropped. Deliberately NOT trying to defeat a
    middle initial ("Lillie" vs "Lillie J"): the ADDRESS is the strong
    signal here, so the name only has to be in the same ballpark and we
    require an exact-ish match to avoid collapsing two real housemates."""
    return re.sub(r"[^a-z0-9 ]", "", (s or "").strip().lower())


def _find_recent_name_address_duplicate(db: Session, data: "IntakeData"):
    """Most recent NON-archived lead with the same normalized name AND full
    service-address key inside NAME_ADDR_DEDUP_WINDOW_MINUTES, when contact-
    based dedup found nothing (different/typo'd email+phone on the same
    request).

    Requires BOTH a name and a street address — name alone is far too weak
    (two unrelated "John Smith"s), and address alone would merge a landlord's
    two tenants. Matching uses the FULL _property_key (street+city+state+zip),
    NOT the street line alone, so "123 Main St, Portland" and "123 Main St,
    Bath" — two genuinely different properties — are never collapsed.
    Archived/cancelled leads are excluded so a new request never resurrects a
    dead one. The window is compared in Python against a small candidate set
    so we don't depend on DB-specific lower()/trim()."""
    norm_name = _normalize_name(data.name)
    if not norm_name or not _normalize_addr(data.address):
        return None
    target_key = _property_key(data.address, data.city, data.state, data.zip_code)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=NAME_ADDR_DEDUP_WINDOW_MINUTES)
    candidates = (
        db.query(LeadIntake)
        .filter(LeadIntake.created_at >= cutoff)
        .filter(LeadIntake.status != "archived")
        .order_by(LeadIntake.created_at.desc())
        .all()
    )
    for c in candidates:
        if (_normalize_name(c.name) == norm_name
                and _property_key(c.address, c.city, c.state, c.zip_code) == target_key):
            return c
    return None


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


def upsert_lead(db: Session, data: IntakeData) -> dict:
    """The single write path for public leads — INBOX-ONLY (Twenty-style).

    A new inbound request lands as a ``LeadIntake`` row and NOTHING else. It
    does NOT create a Client, a Property, or an Opportunity, and it never
    mutates an existing client. Requests are a triage inbox: staff convert a
    request into a customer explicitly (see the intake router's
    ``convert-to-client`` / ``convert-to-quote`` endpoints), and that
    conversion is the single place where we match/create a Client and dedup
    against the existing book of business.

    Auto-creating a Client + Property + Opportunity on every website
    submission was the primary source of duplicate clients and properties —
    a returning customer, a typo'd email, or a second phone number each
    spawned a fresh record. Keeping requests inbox-only removes that source
    at the root while leaving the operator in control of what becomes a client.

    LEAD-level dedup still runs, so one website visit that hits two public
    endpoints collapses into a single request:
      * idempotency-key short-circuit (deterministic, cross-endpoint),
      * a per-contact advisory lock (the concurrent-race backstop), and
      * a 5-minute recency merge that back-fills missing fields.

    ``client_id`` in the return value is whatever the matched request already
    had (normally ``None`` for a brand-new inbound request) — it is only set
    once staff link/convert the request.
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

    # Contact-based match first (email/phone within 5 min); if that misses,
    # fall back to same-name+same-address within a wider window (the customer
    # who resubmitted with a different email). name_addr_merge flags the
    # latter so we can record WHY two different-contact rows collapsed.
    recent = _find_recent_duplicate(db, data.email, data.phone)
    name_addr_merge = False
    if not recent:
        recent = _find_recent_name_address_duplicate(db, data)
        name_addr_merge = recent is not None
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
        # Name+address merge: the two rows have DIFFERENT contact info by
        # definition, so preserve both. Back-fill any contact field the
        # original was missing, and when the new submission carries a
        # genuinely different email/phone, keep the operator's record of it in
        # an audit note on the request itself (internal_notes) instead of
        # dropping it. Requests are inbox-only (see this module's header — no
        # Client is created on submit), so the trail lives on the LeadIntake,
        # which is exactly where a triaging operator reads it.
        if name_addr_merge:
            alt = []
            if data.email:
                if not recent.email:
                    recent.email = data.email
                    changed = True
                elif recent.email.strip().lower() != data.email.strip().lower():
                    alt.append(f"alt email: {data.email}")
            if data.phone:
                if not recent.phone:
                    recent.phone = data.phone
                    changed = True
                elif recent.phone != data.phone:
                    alt.append(f"alt phone: {data.phone}")
            stamp = datetime.now(timezone.utc).strftime("%b %d")
            trail = f"[Auto-merged {stamp}] Duplicate submission (same name + address)."
            if alt:
                trail += " " + "; ".join(alt) + "."
            recent.internal_notes = ((recent.internal_notes or "").rstrip() + "\n" + trail).strip()
            changed = True

        if changed:
            db.commit()
            db.refresh(recent)
        return {"success": True, "intake_id": recent.id, "client_id": recent.client_id, "deduped": True}

    # Brand-new request: persist EVERY structured column the customer gave us,
    # but leave client_id NULL — no Client/Property/Opportunity is created.
    # Stamp the default workspace so the row shows in that workspace's inbox
    # rather than leaking into every tenant via the `org_id IS NULL` scope.
    from modules.auth.router import _default_org_id
    intake = LeadIntake(
        name=data.name, email=data.email, phone=data.phone,
        address=data.address, city=data.city, state=data.state or "ME",
        zip_code=data.zip_code, service_type=data.service_type,
        requested_service=data.requested_service,
        bedrooms=data.bedrooms, bathrooms=data.bathrooms,
        square_footage=data.square_footage, guests=data.guests,
        condition=data.condition, pet_hair=data.pet_hair,
        frequency=data.frequency, requested_date=data.requested_date,
        check_in=data.check_in, check_out=data.check_out,
        estimate_min=data.estimate_min, estimate_max=data.estimate_max,
        property_name=data.property_name, message=data.message,
        preferred_date=data.preferred_date, source=data.source, client_id=None,
        custom_fields=data.custom_fields or {},
        idempotency_key=data.idempotency_key,
        org_id=_default_org_id(db),
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

    db.commit()
    db.refresh(intake)

    # Web-push the staff about the brand-new request (best-effort, no-op unless
    # VAPID is configured). Only fires on a genuinely new lead — the deduped/
    # merged returns above skip it, so a customer double-submitting the form
    # doesn't buzz twice.
    try:
        from services.push_service import notify_staff
        who = (data.name or "").strip() or "New request"
        svc = (data.requested_service or data.service_type or "").strip()
        body = f"{svc} · {data.city or data.address}".strip(" ·") if (svc or data.city or data.address) else "New quote request"
        notify_staff(
            db,
            f"📥 New request — {who}",
            body,
            url="/requests",
            tag=f"intake-{intake.id}",
            org_id=intake.org_id,
        )
    except Exception:
        pass

    return {"success": True, "intake_id": intake.id, "client_id": intake.client_id, "deduped": False}
