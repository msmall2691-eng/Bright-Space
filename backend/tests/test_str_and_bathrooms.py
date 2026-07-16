"""STR leads must not carry a fabricated instant estimate, and bathrooms must
survive as a fractional value.

- The maineclean.co site shows NO instant price for short-term-rental /
  vacation-rental / commercial requests (operator quotes by hand), so the
  landed LeadIntake must have estimate_min/max = None — not a number the
  backend engine invented. STR extras (listing URL, turnover day, pets-allowed)
  ride custom_fields.
- Homes have half-baths; 2.5 must persist as 2.5, not round to an int.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake

client = TestClient(app)


def _get_lead(intake_id):
    db = SessionLocal()
    try:
        return db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
    finally:
        db.close()


def _cleanup(intake_id):
    db = SessionLocal()
    try:
        db.query(LeadIntake).filter(LeadIntake.id == intake_id).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_str_lead_has_no_instant_estimate_and_keeps_extras():
    payload = {
        "name": "STR Host",
        "email": f"host-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550142",
        "address": "55 Spiller Road, Gorham, ME 04038",
        "serviceType": "str",
        "requestedDate": "2026-08-15",
        "bedrooms": 3,
        "bathrooms": 2.5,
        "guests": 6,
        "listingUrl": "https://www.airbnb.com/rooms/12345",
        "turnoverDay": "Saturday",
        "petsAllowed": "Dogs welcome",
        # A stale/tampered range must NOT stick to an STR lead.
        "estimateMin": 200,
        "estimateMax": 220,
    }
    r = client.post("/api/booking/submit", json=payload)
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        lead = _get_lead(intake_id)
        assert lead is not None
        assert lead.service_type == "str"
        # No instant number for STR.
        assert lead.estimate_min is None and lead.estimate_max is None
        # Fractional bath survives.
        assert lead.bathrooms == 2.5
        assert lead.bedrooms == 3 and lead.guests == 6
        # STR extras landed on custom_fields.
        cf = lead.custom_fields or {}
        assert cf.get("listing_url") == "https://www.airbnb.com/rooms/12345"
        assert cf.get("turnover_day") == "Saturday"
        assert cf.get("pets_allowed") == "Dogs welcome"
    finally:
        _cleanup(intake_id)


def test_residential_lead_keeps_half_bath_and_still_estimates():
    payload = {
        "name": "Half Bath",
        "email": f"half-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550143",
        "address": "100 Congress St, Portland, ME 04101",
        "serviceType": "standard",
        "requestedDate": "2026-08-15",
        "squareFeet": 1500,
        "bathrooms": 2.5,
        "frequency": "biweekly",
    }
    r = client.post("/api/booking/submit", json=payload)
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        lead = _get_lead(intake_id)
        assert lead is not None
        assert lead.bathrooms == 2.5           # float preserved
        # Residential still gets a canonical estimate.
        assert lead.estimate_min is not None and lead.estimate_max is not None
        assert lead.estimate_max >= lead.estimate_min > 0
    finally:
        _cleanup(intake_id)
