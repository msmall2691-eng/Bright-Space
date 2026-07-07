import logging
import os

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict
from typing import Optional

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
    """
    to_email = (data.email or "").strip()
    if not to_email or "@" not in to_email:
        return
    try:
        from integrations.email import _load_smtp_creds, send_email
        from services.quote_email_service import first_name_of, customer_display_name
        creds = _load_smtp_creds()
        company = creds.get("from_name") or "The Maine Cleaning Co."
        first = first_name_of(data.name) or customer_display_name(data.name) or "there"
        est_line = ""
        if estimate_min is not None and estimate_max is not None:
            est_line = f"Estimate: ${int(estimate_min)}–${int(estimate_max)}."
        lines = [
            f"Hi {first},",
            "",
            f"Thanks for booking with {company}! We got your request for {data.serviceType} on {data.requestedDate}.",
            f"Service address: {data.address}",
            est_line,
            "",
            "We'll review it and confirm by call or text within 1 business day. "
            "Once we've confirmed, you'll get a Google Calendar invite that adds the "
            "cleaning to your phone automatically — no app to install.",
            "",
            "Questions in the meantime? Just reply to this email.",
        ]
        # Drop the est_line placeholder if no estimate came through.
        lines = [l for l in lines if l is not None and l != ""] or lines
        import html as _html
        body = "<div style='font-family:sans-serif;font-size:14px;color:#111'>" + \
            "<br>".join(_html.escape(l) if l else "&nbsp;" for l in lines) + "</div>"
        send_email(
            to=to_email,
            subject=f"Booking request received — {data.requestedDate}",
            html_body=body,
            text_body="\n".join(lines),
        )
        logger.info("[booking] customer confirmation email sent for intake=%s", intake_id)
    except Exception as e:
        logger.warning("[booking] customer confirmation email failed for intake %s: %s", intake_id, e)


def _send_booking_owner_alert(
    db: Session,
    data: "BookingSubmit",
    intake_id: int,
    estimate_min: Optional[float],
    estimate_max: Optional[float],
) -> None:
    """Text the owner as soon as a website booking lands.

    Owner phone comes from Settings → General ("owner_alert_phone") first,
    then falls back to the OWNER_ALERT_PHONE env var. Uses the same
    integrations.twilio_client the quote-SMS path uses, so the same
    TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
    configuration covers this path — no extra env work needed to enable.
    """
    to_number = None
    try:
        from database.models import AppSetting
        row = db.query(AppSetting).filter(AppSetting.key == "owner_alert_phone").first()
        if row and (row.value or "").strip():
            to_number = row.value.strip()
    except Exception:
        pass
    to_number = to_number or (os.getenv("OWNER_ALERT_PHONE") or "").strip() or None
    if not to_number:
        logger.info("[booking] owner SMS skipped — no owner_alert_phone / OWNER_ALERT_PHONE set")
        return

    # Compact one-message summary. Twilio segments beyond 160 chars, so
    # keep it terse but include the levers an operator wants at a glance.
    est = ""
    if estimate_min is not None and estimate_max is not None:
        est = f" · ${int(estimate_min)}–${int(estimate_max)}"
    body = (
        f"New booking #{intake_id}: {data.name} — "
        f"{data.serviceType} on {data.requestedDate}{est}\n"
        f"{data.address}\n"
        f"{data.phone}\n"
        f"See details in Bright-Space Requests."
    )

    from integrations.twilio_client import send_sms
    send_sms(to=to_number, body=body)
    logger.info("[booking] owner SMS sent for intake=%s", intake_id)


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
    requestedDate: str
    # Optional fields
    property: Optional[str] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[int] = None
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
    # Client-supplied UUID for cross-endpoint dedup. Same key on two POSTs
    # (retry / dual-forward from the maineclean.co Express middle layer /
    # user tapped Submit twice) collapses to one Lead. Accept both camel and
    # snake so callers in either style work.
    idempotencyKey: Optional[str] = None
    idempotency_key: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class AddressValidate(BaseModel):
    address: str


class BookingResponse(BaseModel):
    success: bool
    bookingId: int
    requestedDate: str
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
    bathrooms: Optional[int] = None
    squareFeet: Optional[int] = None
    frequency: Optional[str] = None
    message: Optional[str] = None
    # The website's calculator collects these two — forward them so BrightBase
    # prices identically instead of ignoring pet hair / home condition.
    petHair: Optional[str] = None          # "none" | "some" | "heavy"
    condition: Optional[str] = None        # "maintenance" | "moderate" | "heavy"

    model_config = ConfigDict(extra="allow")


class InstantQuoteResponse(BaseModel):
    estimate_min: int
    estimate_max: int
    currency: str
    breakdown: dict


@router.post("/submit", status_code=201, response_model=BookingResponse)
@limiter.limit("20/hour")
def submit_booking(request: Request, data: BookingSubmit, db: Session = Depends(get_db)):
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

    # Use the post-normalize estimate so both alerts match what the operator
    # sees on the Requests row. When the customer's payload didn't include a
    # range (or included an implausible one), build_intake() recomputed the
    # canonical range and it now lives on payload.estimate_min/max — passing
    # the pre-normalize local vars here would silently drop the estimate line
    # from the receipt even though the request row shows one.
    alert_estimate_min = payload.estimate_min if payload.estimate_min is not None else estimate_min
    alert_estimate_max = payload.estimate_max if payload.estimate_max is not None else estimate_max

    # Ping the owner by SMS as soon as a booking lands. Twilio-only; if the
    # env isn't configured or the send fails the booking still succeeds —
    # the customer-facing response must never depend on the alert path.
    try:
        _send_booking_owner_alert(db, data, result["intake_id"], alert_estimate_min, alert_estimate_max)
    except Exception as e:
        logger.warning("booking owner SMS failed: %s", e)

    # Email the customer a receipt so they know we got it and know what
    # comes next (the Google Calendar invite once we approve). Same
    # best-effort contract as the owner SMS.
    try:
        _send_booking_customer_confirmation(data, result["intake_id"], alert_estimate_min, alert_estimate_max)
    except Exception as e:
        logger.warning("booking customer email failed: %s", e)

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
    service_type = BOOKING_SERVICE_MAP.get((data.serviceType or "").lower(), "residential")
    return estimate_price(
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
