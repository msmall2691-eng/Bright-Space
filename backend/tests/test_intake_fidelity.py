"""Audit #3 Part A — capture the customer's request accurately.

The three public entry points (booking/submit, intake/submit, intake/webhook)
now share one normalizer (modules.intake.normalize). These tests pin the
acceptance criteria: a website submission with sqft/baths/frequency/estimate
produces ONE lead with all of those as structured columns (not a message blob),
frequency is saved and applied to the estimate, and a single visit that hits two
endpoints merges into one lead.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake, Client, Activity
from modules.intake.normalize import build_intake, upsert_lead

client = TestClient(app)


def _uniq_email():
    return f"fidelity-{uuid.uuid4().hex[:10]}@example.com"


def _cleanup_email(email):
    db = SessionLocal()
    try:
        client_ids = [c.id for c in db.query(Client).filter(Client.email.ilike(email)).all()]
        if client_ids:
            db.query(Activity).filter(Activity.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).delete(synchronize_session=False)
        db.query(Client).filter(Client.email.ilike(email)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


# --- The normalizer (single write path) ------------------------------------

def test_build_intake_maps_and_computes_estimate():
    data = build_intake(
        name="Megan Small", email="x@example.com", phone="2075551234",
        service_key="deep", bedrooms=3, bathrooms=2, square_footage=2000,
        frequency="biweekly", message="please be thorough",
    )
    assert data.service_type == "residential"      # 'deep' maps to residential
    assert data.square_footage == 2000 and data.bathrooms == 2
    assert data.frequency == "biweekly"
    # Estimate computed from the structured fields (contact form used to save none)
    assert data.estimate_min is not None and data.estimate_max is not None
    assert data.estimate_max >= data.estimate_min > 0


def test_frequency_changes_the_estimate():
    """Frequency must actually feed the estimator (it was hard-coded None)."""
    one_time = build_intake(name="A", email="a@example.com", service_key="residential",
                            square_footage=2000, bathrooms=2, frequency=None)
    biweekly = build_intake(name="A", email="a@example.com", service_key="residential",
                            square_footage=2000, bathrooms=2, frequency="biweekly")
    # A recurring cadence is discounted vs a one-time clean.
    assert biweekly.estimate_max < one_time.estimate_max


def test_upsert_persists_all_structured_columns():
    email = _uniq_email()
    try:
        db = SessionLocal()
        data = build_intake(
            name="Struct Test", email=email, phone="2075559000",
            service_key="residential", bedrooms=3, bathrooms=2,
            square_footage=2000, frequency="biweekly", message="note only",
        )
        res = upsert_lead(db, data)
        assert res["deduped"] is False
        lead = db.query(LeadIntake).filter(LeadIntake.id == res["intake_id"]).first()
        # Zero nulls for the fields the customer provided.
        assert lead.square_footage == 2000
        assert lead.bathrooms == 2
        assert lead.bedrooms == 3
        assert lead.frequency == "biweekly"
        assert lead.estimate_min is not None and lead.estimate_max is not None
        assert lead.message == "note only"   # message holds ONLY the free text
        # A timeline activity was written for the client.
        act = db.query(Activity).filter(
            Activity.client_id == lead.client_id,
            Activity.activity_type == "lead_created",
        ).first()
        assert act is not None
        db.close()
    finally:
        _cleanup_email(email)


def test_cross_entrypoint_dedup_merges_into_one_lead():
    """Same email hitting /submit then /webhook within the window = ONE lead,
    with missing fields filled in from the second hit."""
    email = _uniq_email()
    try:
        # 1) Contact form: name + email, no sqft.
        r1 = client.post("/api/intake/submit", json={
            "name": "Dedup Test", "email": email, "message": "first touch",
        })
        assert r1.status_code == 201, r1.text
        id1 = r1.json()["intake_id"]

        # 2) Webhook for the same person with the structured details.
        r2 = client.post("/api/intake/webhook", json={
            "name": "Dedup Test", "email": email, "serviceType": "residential",
            "sqft": 1800, "bathrooms": 2, "frequency": "weekly",
        })
        assert r2.status_code == 201, r2.text
        assert r2.json().get("deduped") is True
        assert r2.json()["intake_id"] == id1   # merged, not a new row

        db = SessionLocal()
        leads = db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).all()
        assert len(leads) == 1                  # exactly one lead for this visit
        lead = leads[0]
        assert lead.square_footage == 1800      # back-filled from the webhook
        assert lead.frequency == "weekly"
        db.close()
    finally:
        _cleanup_email(email)


def test_booking_submit_saves_frequency():
    """booking/submit used to hard-code frequency=None, dropping cadence."""
    email = _uniq_email()
    try:
        r = client.post("/api/booking/submit", json={
            "name": "Booking Freq", "email": email, "phone": "2075557777",
            "address": "1 Main St", "serviceType": "residential",
            "requestedDate": "2026-07-01", "squareFeet": 2000, "bathrooms": 2,
            "frequency": "biweekly", "notes": "side door",
        })
        assert r.status_code == 201, r.text
        intake_id = r.json()["bookingId"]
        db = SessionLocal()
        lead = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
        assert lead.frequency == "biweekly"     # cadence saved
        assert lead.square_footage == 2000
        assert lead.estimate_min is not None    # estimate computed + stored
        assert lead.message == "side door"      # only the free-text note
        db.close()
    finally:
        _cleanup_email(email)
