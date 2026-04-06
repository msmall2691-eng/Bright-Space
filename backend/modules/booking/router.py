from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.db import get_db
from database.models import LeadIntake, Client

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


@router.post("/submit", status_code=201)
def submit_booking(data: BookingSubmit, db: Session = Depends(get_db)):
    """
    Public endpoint — called from maineclean.co booking/quote request form.
    Creates a LeadIntake + Client record and returns a booking confirmation.
    """
    service_type = BOOKING_SERVICE_MAP.get(data.serviceType, "residential")

    # Find or create client
    client = None
    if data.email:
        client = db.query(Client).filter(Client.email == data.email).first()
    if not client and data.phone:
        client = db.query(Client).filter(Client.phone == data.phone).first()

    if not client:
        client = Client(
            name=data.name,
            email=data.email,
            phone=data.phone,
            address=data.address,
            state="ME",
            status="lead",
            source="website",
        )
        db.add(client)
        db.flush()

    # Build message from extra details
    parts = []
    if data.notes:
        parts.append(data.notes)
    if data.message:
        parts.append(data.message)
    if data.turnover:
        parts.append(f"Turnover type: {data.turnover}")
    if data.guests:
        parts.append(f"Guests: {data.guests}")
    message = " | ".join(parts) if parts else None

    intake = LeadIntake(
        name=data.name,
        email=data.email,
        phone=data.phone,
        address=data.address,
        state="ME",
        service_type=service_type,
        bedrooms=data.bedrooms,
        bathrooms=data.bathrooms,
        square_footage=data.squareFeet,
        guests=data.guests,
        frequency=None,
        requested_date=data.requestedDate,
        check_in=data.checkIn,
        check_out=data.checkOut,
        property_name=data.property,
        message=message,
        preferred_date=data.requestedDate,
        source="website",
        client_id=client.id,
    )
    db.add(intake)
    db.commit()
    db.refresh(intake)

    return {
        "success": True,
        "bookingId": intake.id,
        "requestedDate": data.requestedDate,
        "message": "Your booking request has been submitted! We'll review and confirm within 1 business day.",
    }


@router.post("/validate-address")
def validate_address(data: AddressValidate):
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
