import logging
import os
from datetime import datetime, timezone
from html import escape as _esc

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict
from typing import Optional, Union

from database.db import get_db
from modules.intake.normalize import build_intake, upsert_lead
from modules.booking.pricing import estimate_price
from ratelimit import limiter

logger = logging.getLogger(__name__)
router = APIRouter()


def _send_booking_customer_confirmation(
    data: "BookingSubmit",
    intake_id: int,
    estimate_min: Optional[float],
    estimate_max: Optional[float],
) -> None:
    """Email the customer a booking receipt right after they submit.

    Best-effort — SMTP not configured or a send failure both log a
    warning and return without raising, so the customer-facing HTTP
    response never depends on this path.

    Rendering lives in services.booking_email_service so this router
    isn't full of HTML string-building. The service also formats the
    requested_date properly — the old inline version pasted the raw
    ISO timestamp (`2026-07-07T22:18:23.208Z`) into the subject line
    and body, which is what the customer actually saw.
    """
    to_email = (data.email or "").strip()
    if not to_email or "@" not in to_email:
        return
    try:
        from integrations.email import _load_smtp_creds, send_email
        from services.booking_email_service import build_booking_confirmation_email
        creds = _load_smtp_creds()
        company = creds.get("from_name") or "The Maine Cleaning Co."
        subject, html_body, text_body = build_booking_confirmation_email(
            customer_name=data.name,
            service_type=data.serviceType,
            requested_date=data.requestedDate,
            address=data.address,
            company_name=company,
            company_phone=os.getenv("TWILIO_PHONE_NUMBER") or os.getenv("COMPANY_PHONE"),
            company_email=creds.get("from_email") or os.getenv("SMTP_USER"),
            company_website=os.getenv("COMPANY_WEBSITE_URL", "https://maineclean.co"),
            estimate_min=estimate_min,
            estimate_max=estimate_max,
        )
        send_email(to=to_email, subject=subject, html_body=html_body, text_body=text_body)
        logger.info("[booking] customer confirmation email sent for intake=%s", intake_id)
    except Exception as e:
        logger.warning("[booking] customer confirmation email failed for intake %s: %s", intake_id, e)


def _send_booking_customer_sms(data: "BookingSubmit", intake_id: int) -> None:
    """Text the customer a confirmation as soon as their website booking lands.

    This is a transactional confirmation of the customer's OWN request (not
    marketing), so it's fine to send without a separate opt-in. Twilio lives
    only in Bright-Space (maineclean.co has no SMS), so this is the right home
    for it — same TWILIO_* config the owner SMS path already uses.

    Best-effort and self-contained: a missing phone, unconfigured Twilio, or a
    Twilio send failure all log and return without raising, so submit_booking's
    201 never depends on this path (same contract as the customer email above).
    """
    to_number = (data.phone or "").strip()
    if not to_number:
        logger.info("[booking] customer SMS skipped — no phone on intake=%s", intake_id)
        return
    try:
        from integrations import twilio_client
        # Mirror the owner-SMS "not configured" detection: without the TWILIO_*
        # creds send_sms would raise, so short-circuit quietly (info, not
        # warning) — an unconfigured deploy shouldn't log noise on every booking.
        if not all([
            twilio_client._TWILIO_ACCOUNT_SID,
            twilio_client._TWILIO_AUTH_TOKEN,
            twilio_client._TWILIO_PHONE_NUMBER,
        ]):
            logger.info("[booking] customer SMS skipped — Twilio not configured (intake=%s)", intake_id)
            return
        from services.booking_email_service import format_requested_date, service_label
        first = (data.name or "").strip().split(" ")[0] or "there"
        svc = service_label(data.serviceType)
        # STR/commercial and dateless contact-form inquiries legitimately carry
        # no date — say "your request" instead of pasting a fabricated/empty one.
        if data.requestedDate:
            body = (
                f"Hi {first}, thanks! We got your {svc} request for "
                f"{format_requested_date(data.requestedDate)}. "
                f"We'll confirm within 1 business day. — The Maine Cleaning Co."
            )
        else:
            body = (
                f"Hi {first}, thanks! We got your {svc} request. "
                f"We'll confirm within 1 business day. — The Maine Cleaning Co."
            )
        # Self-service edit/cancel link only when present. Appended after the
        # one-segment base so a no-manageUrl booking stays a single SMS segment.
        if data.manageUrl:
            body += f" Manage/cancel: {data.manageUrl}"
        # NEVER log `body` — it can carry the capability-token manage URL.
        twilio_client.send_sms(to=to_number, body=body)
        logger.info("[booking] customer confirmation SMS sent for intake=%s", intake_id)
    except Exception as e:
        logger.warning("[booking] customer confirmation SMS failed for intake %s: %s", intake_id, e)


def _owner_notify_setting(db: Session, key: str, env_var: str) -> Optional[str]:
    """Owner-notification destination: the Settings row first (operator can
    edit it in BrightBase without a redeploy), then the env var as the
    deploy-time fallback. Shared by the owner SMS (owner_alert_phone /
    OWNER_ALERT_PHONE) and owner email (owner_alert_email / OWNER_ALERT_EMAIL)
    paths so the two channels can't drift on lookup rules."""
    value = None
    try:
        from database.models import AppSetting
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        if row and (row.value or "").strip():
            value = row.value.strip()
    except Exception:
        pass
    return value or (os.getenv(env_var) or "").strip() or None


def _send_owner_sms(db: Session, body: str, intake_id: int) -> bool:
    """Text the owner. Uses the same integrations.twilio_client the quote-SMS
    path uses, so the same TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
    TWILIO_PHONE_NUMBER configuration covers this path — no extra env work
    needed to enable.

    Returns True only when a message was actually handed to Twilio, so
    callers can tell "nothing configured" apart from success and escalate
    when no owner channel worked at all. Raises on send failure — callers
    wrap in try/except (best-effort contract).
    """
    to_number = _owner_notify_setting(db, "owner_alert_phone", "OWNER_ALERT_PHONE")
    if not to_number:
        logger.info("[booking] owner SMS skipped — no owner_alert_phone / OWNER_ALERT_PHONE set")
        return False
    from integrations.twilio_client import send_sms
    send_sms(to=to_number, body=body)
    logger.info("[booking] owner SMS sent for intake=%s", intake_id)
    return True


def _send_owner_email(db: Session, subject: str, lines: list, intake_id: int) -> bool:
    """Email the owner a booking-event summary (new booking / update / cancel).

    Recipient comes from Settings ("owner_alert_email") first, then the
    OWNER_ALERT_EMAIL env var — the same settings-then-env pattern as the
    owner SMS phone. Deliberately plain (short lines, no template): this is
    an internal operator ping, not the branded customer receipt in
    services.booking_email_service.

    Same return/raise contract as _send_owner_sms: True = actually sent,
    False = not configured, raises = send failed.
    """
    to_email = _owner_notify_setting(db, "owner_alert_email", "OWNER_ALERT_EMAIL")
    if not to_email:
        logger.info("[booking] owner email skipped — no owner_alert_email / OWNER_ALERT_EMAIL set")
        return False
    from integrations.email import send_email
    text_lines = [str(l) for l in lines if l]
    html_body = (
        '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">'
        + "<br>".join(_esc(l) for l in text_lines)
        + "</div>"
    )
    send_email(to=to_email, subject=subject, html_body=html_body, text_body="\n".join(text_lines))
    logger.info("[booking] owner email sent for intake=%s", intake_id)
    return True


def _send_booking_owner_alert(
    db: Session,
    data: "BookingSubmit",
    intake_id: int,
    estimate_min: Optional[float],
    estimate_max: Optional[float],
) -> bool:
    """Text the owner as soon as a website booking lands. Returns True when
    the SMS was actually sent (see _send_owner_sms)."""
    # Compact one-message summary. Twilio segments beyond 160 chars, so
    # keep it terse but include the levers an operator wants at a glance.
    est = ""
    if estimate_min is not None and estimate_max is not None:
        est = f" · ${int(estimate_min)}–${int(estimate_max)}"
    body = (
        f"New booking #{intake_id}: {data.name} — "
        f"{data.serviceType} on {data.requestedDate or 'no date requested'}{est}\n"
        f"{data.address}\n"
        f"{data.phone}\n"
        f"See details in Bright-Space Requests."
    )
    return _send_owner_sms(db, body, intake_id)


# ---------------------------------------------------------------------------
# Maps website serviceType values to our internal service_type
# ---------------------------------------------------------------------------
BOOKING_SERVICE_MAP = {
    "airbnb-turnover": "str",
    "vrbo-turnover": "str",
    "vacation-rental": "str",
    "str-turnover": "str",
    "str": "str",   # bare "str" is what the maineclean.co bookingMutation sends
    "residential-cleaning": "residential",
    "residential": "residential",
    "standard": "residential",
    "deep": "residential",
    "deep-cleaning": "residential",
    "move-in-out": "residential",
    "commercial-cleaning": "commercial",
    "commercial": "commercial",
}


class BookingSubmit(BaseModel):
    """Matches the payload from maineclean.co booking form."""
    name: str
    email: str
    phone: str
    address: str
    serviceType: str
    # Optional: the maineclean.co Express layer forwards contact-form and
    # estimate intakes here too, and those may legitimately carry no date —
    # it used to fabricate "today" for them, which materialized general
    # inquiries as same-day residential jobs. None = "no date requested".
    requestedDate: Optional[str] = None
    # Optional fields
    property: Optional[str] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None   # half-baths (2.5) are real
    guests: Optional[int] = None
    frequency: Optional[str] = None
    checkIn: Optional[str] = None
    checkOut: Optional[str] = None
    turnover: Optional[str] = None
    squareFeet: Optional[int] = None
    notes: Optional[str] = None
    message: Optional[str] = None
    # Mirror InstantQuoteRequest so the saved lead's estimate matches the
    # quote the customer just saw — without these, build_intake's pricing
    # call would drop the pet/condition surcharges.
    petHair: Optional[str] = None
    condition: Optional[str] = None
    # The customer-facing calculator on maineclean.co computes a range and
    # sends it here. Honor those numbers — otherwise Bright-Space would
    # recompute with its own engine and store a value that differs from
    # what the customer was quoted.
    estimateMin: Optional[float] = None
    estimateMax: Optional[float] = None
    # Six /book "essentials" the site collects so cleaners come prepared.
    # Not on the LeadIntake column list; stored on LeadIntake.custom_fields
    # so operators see them next to the request without a per-field schema
    # migration for every future essentials addition.
    entryMethod: Optional[str] = None       # owner-home / lockbox / hidden-key / gate-code / other
    parkingNotes: Optional[str] = None
    petsDetail: Optional[str] = None
    focusAreas: Optional[list] = None        # ["kitchen", "bathrooms", ...]
    specialInstructions: Optional[str] = None
    # STR / vacation-rental extras the maineclean.co intake collects for
    # turnover-cleaning leads. Stored on custom_fields (same catch-all as the
    # essentials) so the operator sees the listing + turnover cadence next to
    # the request without a per-field schema migration. guests/bedrooms/
    # bathrooms ride the native columns above.
    listingUrl: Optional[str] = None         # Airbnb / VRBO listing link
    turnoverDay: Optional[str] = None        # e.g. "Saturday", "Flexible", "Same-day"
    petsAllowed: Optional[str] = None        # does the rental allow pets (affects hair/effort)
    # Preferred arrival window the site's /book flow now collects — one of
    # morning/afternoon/evening/flexible. Stored on custom_fields (same
    # catch-all) so the operator sees the customer's time preference, and the
    # convert-to-job modal can pre-fill the crew's start/end from it.
    arrivalWindow: Optional[str] = None      # "morning" | "afternoon" | "evening" | "flexible"
    # Up to 3 customer-attached photos of the space, as base64 data-URI
    # strings ("data:image/jpeg;base64,…"). Inlined on custom_fields so the
    # Requests card can show thumbnails without a media-storage dependency.
    # Filtered to valid data:image/ URIs and capped at 3 in submit_booking.
    photos: Optional[list] = None
    # Client-supplied UUID for cross-endpoint dedup. Same key on two POSTs
    # (retry / dual-forward from the maineclean.co Express middle layer /
    # user tapped Submit twice) collapses to one Lead. Accept both camel and
    # snake so callers in either style work.
    idempotencyKey: Optional[str] = None
    idempotency_key: Optional[str] = None
    # Customer self-service edit/cancel link the maineclean.co Express layer
    # mints and forwards ("https://maineclean.co/booking/manage/<token>"). The
    # <token> is a capability credential — anyone holding the URL can edit or
    # cancel the booking — so we thread it into the customer confirmation SMS
    # but NEVER log the full URL (only the intake id).
    manageUrl: Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class AddressValidate(BaseModel):
    address: str


class BookingResponse(BaseModel):
    success: bool
    bookingId: int
    requestedDate: Optional[str] = None  # None when the intake carried no date
    message: str


class AddressValidateResponse(BaseModel):
    eligible: bool
    distanceMiles: Optional[int] = None
    message: str


class InstantQuoteRequest(BaseModel):
    """Payload for the public instant-quote calculator on maineclean.co.
    Mirrors the same field shape as BookingSubmit so the website can use
    the form's existing state, but everything except service_type is
    optional — the calculator returns a sensible range with whatever info
    the user has typed so far."""
    serviceType: Optional[str] = "residential"
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None   # half-baths (2.5) are real
    squareFeet: Optional[int] = None
    frequency: Optional[str] = None
    message: Optional[str] = None
    # The website's calculator collects these two — forward them so BrightBase
    # prices identically instead of ignoring pet hair / home condition.
    petHair: Optional[str] = None          # "none" | "some" | "heavy"
    condition: Optional[str] = None        # "maintenance" | "moderate" | "heavy"

    model_config = ConfigDict(extra="ignore")


class InstantQuoteResponse(BaseModel):
    # Null for custom-quote services (STR / commercial) — the site shows those
    # customers "we'll quote this by hand", never a number, and the engine
    # returns None so this endpoint can't leak a fabricated range either.
    estimate_min: Optional[int] = None
    estimate_max: Optional[int] = None
    currency: str
    breakdown: dict
    # Explicit top-level flag (mirrors breakdown["custom_quote"]) so the
    # website doesn't have to dig into the breakdown to know why the
    # estimates are null.
    custom_quote: bool = False


def _enrich_lead_specs(intake_id: int, address: str) -> None:
    """Best-effort: fill MISSING sqft/beds/baths on a freshly-landed lead from
    public property data (RentCast), keyed on the service address — so an STR
    or contact-form lead that didn't type its specs still shows them on the
    Requests page and pre-fills a quote.

    Runs in a BackgroundTask with its own DB session so it never adds latency
    to, or can fail, the customer-facing submit. No-op unless the operator has
    turned on property enrichment and set a RentCast key in Settings (the same
    integration the quote composer's property-lookup already uses). Never
    overwrites anything the customer actually told us.
    """
    from database.db import SessionLocal
    from database.models import LeadIntake
    db = SessionLocal()
    try:
        from services.property_media import enrichment_enabled, property_specs
        from modules.settings.router import get_setting
        if not enrichment_enabled(db):
            return
        row = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
        if row is None or (row.square_footage and row.bedrooms and row.bathrooms):
            return
        specs = property_specs(address, get_setting(db, "rentcast_api_key"))
        if not specs:
            return
        changed = False
        if not row.square_footage and specs.get("square_footage"):
            row.square_footage = specs["square_footage"]; changed = True
        if not row.bedrooms and specs.get("bedrooms"):
            row.bedrooms = specs["bedrooms"]; changed = True
        if not row.bathrooms and specs.get("bathrooms") is not None:
            row.bathrooms = specs["bathrooms"]; changed = True
        if changed:
            db.commit()
            logger.info("[booking] enriched lead %s specs from address", intake_id)
    except Exception as e:
        logger.warning("[booking] lead spec enrichment failed for %s: %s", intake_id, e)
    finally:
        db.close()


@router.post("/submit", status_code=201, response_model=BookingResponse)
@limiter.limit("20/hour")
def submit_booking(request: Request, data: BookingSubmit, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Public endpoint — called from maineclean.co booking/quote request form.

    Routes through the single canonical intake path (modules.intake.normalize),
    which persists every structured field, computes the estimate (now including
    the customer's frequency, which used to be hard-coded to None so the cadence
    AND its discount were dropped), and dedupes against the other public
    endpoints so one visit doesn't create two leads.
    """
    # Free-text message keeps only the customer's note(s) plus turnover (which
    # has no dedicated column); guests etc. are stored as structured fields.
    parts = []
    if data.notes:
        parts.append(data.notes)
    if data.message:
        parts.append(data.message)
    if data.turnover:
        parts.append(f"Turnover type: {data.turnover}")
    message = " | ".join(parts) if parts else None

    # Trust the customer-facing quote but not a tampered payload. Drop
    # anything that isn't a plausible positive range (negative, inverted,
    # or absurdly large — the canonical engine tops out well under $10k
    # even for oversized deep-clean one-time jobs) and let build_intake's
    # fallback recompute from the structured fields instead. 0 is also
    # treated as missing because the client sends 0 for custom-quote
    # services (STR / commercial).
    _MAX_PLAUSIBLE_ESTIMATE = 10000
    estimate_min = data.estimateMin if data.estimateMin else None
    estimate_max = data.estimateMax if data.estimateMax else None
    if estimate_min is not None and (estimate_min < 0 or estimate_min > _MAX_PLAUSIBLE_ESTIMATE):
        estimate_min = None
    if estimate_max is not None and (estimate_max < 0 or estimate_max > _MAX_PLAUSIBLE_ESTIMATE):
        estimate_max = None
    if (
        estimate_min is not None
        and estimate_max is not None
        and estimate_min > estimate_max
    ):
        estimate_min = estimate_max = None

    # /book essentials — passed through as custom_fields on the LeadIntake row
    # so they show up on the Requests page next to the estimate/date. Any that
    # arrive empty are dropped inside build_intake so the JSON stays compact.
    essentials = {
        "entry_method":         data.entryMethod,
        "parking_notes":        data.parkingNotes,
        "pets_detail":          data.petsDetail,
        "focus_areas":          data.focusAreas,
        "special_instructions": data.specialInstructions,
        # STR extras — dropped inside build_intake if empty, so residential
        # leads don't grow blank keys.
        "listing_url":          data.listingUrl,
        "turnover_day":         data.turnoverDay,
        "pets_allowed":         data.petsAllowed,
        # Arrival window — dropped inside build_intake if empty.
        "arrival_window":       data.arrivalWindow,
        # Inline photo data-URIs. Keep only well-formed image data URIs and
        # cap at 3 so a tampered/oversized payload can't bloat the JSON row —
        # NEVER log the contents (they can be large + are customer property).
        "photos": [
            p for p in (data.photos or [])
            if isinstance(p, str) and p.startswith("data:image/")
        ][:3] or None,
    }

    payload = build_intake(
        name=data.name, email=data.email, phone=data.phone, address=data.address,
        state="ME", service_key=data.serviceType, bedrooms=data.bedrooms,
        bathrooms=data.bathrooms, square_footage=data.squareFeet, guests=data.guests,
        frequency=data.frequency, requested_date=data.requestedDate,
        check_in=data.checkIn, check_out=data.checkOut, property_name=data.property,
        message=message, preferred_date=data.requestedDate, source="website",
        pet_hair=data.petHair, condition=data.condition,
        estimate_min=estimate_min, estimate_max=estimate_max,
        custom_fields=essentials,
        idempotency_key=data.idempotency_key or data.idempotencyKey,
    )
    result = upsert_lead(db, payload)

    # Best-effort: look the address up and back-fill any specs the customer
    # didn't provide (esp. STR leads, which skip the sqft/bath calculator).
    # Fire-and-forget after the response so it never slows the customer down.
    if data.address:
        background_tasks.add_task(_enrich_lead_specs, result["intake_id"], data.address)

    # Use the post-normalize estimate so both alerts match what the operator
    # sees on the Requests row. When the customer's payload didn't include a
    # range (or included an implausible one), build_intake() recomputed the
    # canonical range and it now lives on payload.estimate_min/max — passing
    # the pre-normalize local vars here would silently drop the estimate line
    # from the receipt even though the request row shows one.
    if payload.service_type in ("str", "commercial"):
        # Custom-quote services: the lead deliberately stores NO estimate, so
        # don't resurrect the customer's (possibly stale/tampered) submitted
        # numbers into the owner/customer alerts either — the fallback below
        # would put a price on an STR booking that the Requests row shows as
        # "Custom quote".
        alert_estimate_min = alert_estimate_max = None
    else:
        alert_estimate_min = payload.estimate_min if payload.estimate_min is not None else estimate_min
        alert_estimate_max = payload.estimate_max if payload.estimate_max is not None else estimate_max

    # Ping the owner by SMS as soon as a booking lands. Twilio-only; if the
    # env isn't configured or the send fails the booking still succeeds —
    # the customer-facing response must never depend on the alert path.
    owner_sms_sent = False
    try:
        owner_sms_sent = _send_booking_owner_alert(db, data, result["intake_id"], alert_estimate_min, alert_estimate_max)
    except Exception as e:
        logger.warning("booking owner SMS failed: %s", e)

    # Also email the owner — the SMS is easy to miss (or Twilio may be down /
    # unconfigured), and the email has room for the full detail the 160-char
    # SMS trims. Same best-effort contract.
    owner_email_sent = False
    try:
        from services.booking_email_service import format_requested_date, service_label
        est_line = None
        if alert_estimate_min is not None and alert_estimate_max is not None:
            est_line = f"Estimate: ${int(alert_estimate_min)}–${int(alert_estimate_max)}"
        elif payload.service_type in ("str", "commercial"):
            est_line = "Estimate: custom quote (priced by hand)"
        # format_requested_date(None) renders customer-facing copy ("your
        # requested date") — the owner ping should say plainly that no date
        # was asked for (contact-form inquiries land here dateless).
        date_label = (
            format_requested_date(data.requestedDate)
            if data.requestedDate else "no date requested"
        )
        owner_email_sent = _send_owner_email(
            db,
            subject=(
                f"New booking request from {data.name} — "
                f"{service_label(data.serviceType)} on {date_label}"
            ),
            lines=[
                f"New booking request #{result['intake_id']}",
                f"Name: {data.name}",
                f"Service: {service_label(data.serviceType)}",
                f"Requested date: {date_label}",
                f"Address: {data.address}",
                f"Phone: {data.phone}",
                f"Email: {data.email}",
                est_line,
                "See details in Bright-Space Requests.",
            ],
            intake_id=result["intake_id"],
        )
    except Exception as e:
        logger.warning("booking owner email failed: %s", e)

    if not owner_sms_sent and not owner_email_sent:
        # Neither owner channel went out — the operator has NO signal that a
        # customer just booked. ERROR (not warning) so it's greppable and
        # alertable; the individual causes are in the warnings/infos above.
        logger.error(
            "[booking] owner NOT notified of new booking intake=%s — "
            "SMS and email both failed or unconfigured", result["intake_id"],
        )

    # Email the customer a receipt so they know we got it and know what
    # comes next (the Google Calendar invite once we approve). Same
    # best-effort contract as the owner SMS.
    try:
        _send_booking_customer_confirmation(data, result["intake_id"], alert_estimate_min, alert_estimate_max)
    except Exception as e:
        logger.warning("booking customer email failed: %s", e)

    # Also text the customer a confirmation with their self-service manage link.
    # Twilio-only (maineclean.co has no SMS); same best-effort contract — the
    # helper swallows its own errors, and this guard is a belt-and-suspenders so
    # the 201 can never depend on the SMS path.
    try:
        _send_booking_customer_sms(data, result["intake_id"])
    except Exception as e:
        logger.warning("booking customer SMS failed: %s", e)

    return BookingResponse(
        success=True,
        bookingId=result["intake_id"],
        requestedDate=data.requestedDate,
        message="Your booking request has been submitted! We'll review and confirm within 1 business day.",
    )


@router.post("/validate-address", response_model=AddressValidateResponse)
@limiter.limit("20/hour")
def validate_address(request: Request, data: AddressValidate):
    """
    Validates whether an address is within the Maine Cleaning Co. service area.
    Simple distance-based check — Maine-based addresses are eligible.
    """
    addr = data.address.lower()

    # Check for Maine indicators
    maine_indicators = [
        "me ", "me,", "maine", "04", "portland", "scarborough", "south portland",
        "cape elizabeth", "falmouth", "westbrook", "gorham", "windham",
        "standish", "yarmouth", "freeport", "brunswick", "bath", "biddeford",
        "saco", "old orchard", "kennebunk", "wells", "ogunquit", "kittery",
        "lewiston", "auburn", "bangor",
    ]

    eligible = any(indicator in addr for indicator in maine_indicators)

    if eligible:
        return {
            "eligible": True,
            "distanceMiles": 15,
            "message": "Great news! Your address is within our service area.",
        }
    else:
        return {
            "eligible": False,
            "distanceMiles": None,
            "message": "We're not sure this address is in our service area. Please call us to confirm.",
        }


@router.post("/instant-quote", response_model=InstantQuoteResponse)
@limiter.limit("20/hour")
def instant_quote(request: Request, data: InstantQuoteRequest):
    """Public — called from the maineclean.co booking form to show a live
    price range as the customer fills it in. Stateless: doesn't write
    anything to the DB. The actual quote is finalized by the operator
    inside BrightBase after the booking lands as a LeadIntake.

    Same pricing engine is used to populate estimate_min/max on every
    new LeadIntake (POST /api/booking/submit), so the customer-facing
    range and the operator-facing range agree by construction."""
    est = estimate_price(
        # Pass the RAW service type so the engine can detect deep-clean /
        # move-in-out (the x1.5 / x1.65 multipliers). The mapped value above
        # flattens those to "residential" and silently dropped the multiplier.
        # estimate_price() does its own alias mapping for the base rate.
        service_type=data.serviceType or "residential",
        bedrooms=data.bedrooms,
        bathrooms=data.bathrooms,
        square_footage=data.squareFeet,
        frequency=data.frequency,
        message=data.message,
        pet_hair=data.petHair,
        condition=data.condition,
    )
    # STR / commercial come back with null estimates (hand-priced) — surface
    # the reason as a top-level flag so the site renders "custom quote"
    # instead of an empty price.
    return {**est, "custom_quote": bool(est["breakdown"].get("custom_quote"))}


class BookingUpdate(BaseModel):
    """Edit / cancellation of an existing website booking from maineclean.co.

    The site keys the customer's booking to the same idempotencyKey UUID it
    minted on submit, so an update can find the Lead without ever exposing
    internal row ids to the public internet. Only fields the customer
    actually changed are sent; None means "leave alone", not "clear".
    """
    idempotencyKey: str
    requestedDate: Optional[str] = None       # "YYYY-MM-DD"
    specialInstructions: Optional[str] = None
    entryMethod: Optional[str] = None
    parkingNotes: Optional[str] = None
    petsDetail: Optional[str] = None
    # /submit sends focus areas as a list (BookingSubmit.focusAreas); the
    # maineclean.co update forwarder does the same, but its own DB stores a
    # comma-joined string — accept both shapes so neither side can 422.
    focusAreas: Optional[Union[str, list]] = None
    arrivalWindow: Optional[str] = None       # morning/afternoon/evening/flexible
    bedrooms: Optional[int] = None
    cancel: Optional[bool] = None

    model_config = ConfigDict(extra="ignore")


# Update fields that have no dedicated LeadIntake column ride custom_fields —
# the SAME keys /submit writes its "essentials" under, so the Requests card
# renders the updated value in place of the original.
_UPDATE_CUSTOM_FIELDS = (
    # (BookingUpdate attr, custom_fields key, human label for the change log)
    ("specialInstructions", "special_instructions", "special instructions"),
    ("entryMethod",         "entry_method",         "entry method"),
    ("parkingNotes",        "parking_notes",        "parking notes"),
    ("petsDetail",          "pets_detail",          "pets"),
    ("focusAreas",          "focus_areas",          "focus areas"),
    ("arrivalWindow",       "arrival_window",       "arrival window"),
)


@router.post("/update")
@limiter.limit("30/hour")
def update_booking(request: Request, data: BookingUpdate, db: Session = Depends(get_db)):
    """Public — maineclean.co posts here when a customer edits or cancels a
    booking they already submitted. Looked up by idempotency key (the token
    the site stored at submit time), never by internal id.

    Applies the changed fields to the LeadIntake, appends a "[Customer
    update …]" line to the lead's internal notes so the operator sees WHAT
    changed even after the fields are overwritten, logs a timeline Activity
    on the client, and pings the owner by SMS + email (both best-effort —
    the customer-facing response never depends on the alert paths).
    """
    from database.models import Activity, LeadIntake
    from services.booking_email_service import format_requested_date, service_label

    key = (data.idempotencyKey or "").strip()
    lead = (
        db.query(LeadIntake).filter(LeadIntake.idempotency_key == key).first()
        if key else None
    )
    if lead is None:
        raise HTTPException(status_code=404, detail="No matching booking")

    cancelled = bool(data.cancel)
    old_date = lead.requested_date
    changes: list = []

    # ── Native columns ────────────────────────────────────────────────
    if data.requestedDate is not None and str(data.requestedDate).strip():
        # Keep the stored value a plain "YYYY-MM-DD" — truncation also
        # tolerates the ISO-timestamp leakage we've seen from the site
        # ("2026-07-07T22:18:23.208Z" → "2026-07-07").
        new_date = str(data.requestedDate).strip()[:10]
        if new_date != (lead.requested_date or ""):
            changes.append(f"date {lead.requested_date or 'unset'} → {new_date}")
            lead.requested_date = new_date
            lead.preferred_date = new_date
    if data.bedrooms is not None and data.bedrooms != lead.bedrooms:
        changes.append(f"bedrooms {lead.bedrooms if lead.bedrooms is not None else 'unset'} → {data.bedrooms}")
        lead.bedrooms = data.bedrooms

    # ── Column-less fields → custom_fields (same keys as /submit) ─────
    cf = dict(lead.custom_fields or {})
    for attr, cf_key, label in _UPDATE_CUSTOM_FIELDS:
        val = getattr(data, attr)
        if val is None:
            continue
        if cf_key == "focus_areas":
            # /submit stores focus_areas as a LIST and the Requests card
            # .join()s it — normalize either accepted shape (list from the
            # forwarder, comma-separated string from legacy callers) to the
            # same list so the card doesn't crash on a string.
            if isinstance(val, list):
                val = [str(p).strip() for p in val if str(p).strip()]
            else:
                val = [p.strip() for p in str(val).split(",") if p.strip()]
            if not val:
                continue
        else:
            val = str(val).strip()
            if not val:
                continue
        if cf.get(cf_key) != val:
            changes.append(f"{label}: {', '.join(val) if isinstance(val, list) else val}")
            cf[cf_key] = val
    if cf != (lead.custom_fields or {}):
        lead.custom_fields = cf  # reassign — in-place mutation of JSON doesn't flush

    if cancelled:
        # "archived" is the model's closed/dead value (new/reviewed/quoted/
        # converted/archived — see LeadIntake.status); the Requests list
        # already hides archived rows from "All". No new enum value: the
        # status set is a convention shared with the intake router's counts.
        lead.status = "archived"

    # ── Operator-visible audit line on the lead itself ────────────────
    # The field updates above overwrite in place; this note preserves what
    # the customer changed (and when) so the operator isn't left guessing.
    stamp = datetime.now(timezone.utc).strftime("%b %-d")
    detail = "; ".join(changes) if changes else "no field changes"
    note = f"[Customer update {stamp}] " + ("CANCELLED by customer" + (f" — {detail}" if changes else "") if cancelled else detail)
    lead.internal_notes = ((lead.internal_notes or "").rstrip() + "\n" + note).strip()

    # ── Client timeline Activity (mirrors normalize.py's lead_created) ─
    try:
        if lead.client_id:
            db.add(Activity(
                client_id=lead.client_id,
                activity_type="lead_cancelled" if cancelled else "lead_updated",
                actor="website",
                summary=(
                    f"Customer cancelled booking request #{lead.id}"
                    if cancelled else
                    f"Customer updated booking request #{lead.id}: {detail}"
                ),
                extra_data={"intake_id": lead.id, "changes": changes, "source": "website"},
            ))
    except Exception as e:  # a timeline write must never block the update
        logger.warning("[booking] update activity write failed for intake %s: %s", lead.id, e)

    db.commit()

    # ── Owner alerts (best-effort, after commit so they describe reality) ─
    verb = "CANCELED" if cancelled else "updated"
    try:
        sms_body = (
            f"Booking #{lead.id} {verb}: {lead.name}\n"
            + (f"{detail}\n" if not cancelled or changes else "")
            + "See details in Bright-Space Requests."
        )
        _send_owner_sms(db, sms_body, lead.id)
    except Exception as e:
        logger.warning("[booking] update owner SMS failed for intake %s: %s", lead.id, e)
    try:
        _send_owner_email(
            db,
            subject=(
                f"Booking {verb.lower()} — {lead.name} "
                f"({service_label(lead.requested_service or lead.service_type)} "
                f"on {format_requested_date(lead.requested_date)})"
            ),
            lines=[
                f"Booking request #{lead.id} was {verb.lower()} by the customer.",
                f"Name: {lead.name}",
                f"Service: {service_label(lead.requested_service or lead.service_type)}",
                (f"Date change: {old_date or 'unset'} → {lead.requested_date}"
                 if lead.requested_date != old_date else
                 f"Requested date: {format_requested_date(lead.requested_date)}"),
                f"Changes: {detail}" if changes else None,
                f"Address: {lead.address}" if lead.address else None,
                f"Phone: {lead.phone}" if lead.phone else None,
                "See details in Bright-Space Requests.",
            ],
            intake_id=lead.id,
        )
    except Exception as e:
        logger.warning("[booking] update owner email failed for intake %s: %s", lead.id, e)

    return {"ok": True, "leadId": lead.id, "status": "cancelled" if cancelled else "updated"}
