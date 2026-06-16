from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.db import get_db
from modules.intake.normalize import build_intake, upsert_lead
from modules.booking.pricing import estimate_price
from ratelimit import limiter

router = APIRouter()


# ---------------------------------------------------------------------------
# Maps website serviceType values to our internal service_type
# ---------------------------------------------------------------------------
BOOKING_SERVICE_MAP = {
    "airbnb-turnover": "str",
    "vrbo-turnover": "str",
    "vacation-rental": "str",
    "str-turnover": "str",
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

    class Config:
        extra = "allow"


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

    class Config:
        extra = "allow"


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

    payload = build_intake(
        name=data.name, email=data.email, phone=data.phone, address=data.address,
        state="ME", service_key=data.serviceType, bedrooms=data.bedrooms,
        bathrooms=data.bathrooms, square_footage=data.squareFeet, guests=data.guests,
        frequency=data.frequency, requested_date=data.requestedDate,
        check_in=data.checkIn, check_out=data.checkOut, property_name=data.property,
        message=message, preferred_date=data.requestedDate, source="website",
    )
    result = upsert_lead(db, payload)

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
