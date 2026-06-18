"""The maineclean.co intake webhook must compute the canonical backend estimate.

Regression for two compounding bugs that made the canonical-estimate path dead:
  1. estimate_price() was called with kwargs it doesn't accept (sqft=, pet_hair=,
     condition=) → TypeError every call → swallowed → estimate always None.
  2. Its dict return ({estimate_min, estimate_max, …}) was unpacked into a
     2-tuple, which would bind the string KEYS and then crash on the f-string.

So ops never saw the authoritative number the webhook promised. The fix routes
the webhook through the SAME engine the public booking form uses, correctly.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake

client = TestClient(app)


def _cleanup(intake_id):
    db = SessionLocal()
    try:
        db.query(LeadIntake).filter(LeadIntake.id == intake_id).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_webhook_computes_canonical_estimate():
    # Unique email so the 5-minute dedup window can't return a prior lead.
    payload = {
        "name": "Canonical Test",
        "email": f"canon-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550100",
        "serviceType": "residential",
        "sqft": 2000,
        "bathrooms": 3,
        "frequency": "biweekly",
        "estimateMin": 195,
        "estimateMax": 245,
    }
    r = client.post("/api/intake/webhook", json=payload)
    assert r.status_code == 201, r.text
    intake_id = r.json().get("intake_id")
    assert intake_id

    db = SessionLocal()
    try:
        lead = db.query(LeadIntake).filter(LeadIntake.id == intake_id).first()
        assert lead is not None
        # The canonical estimate now lands in its own columns (not flattened into
        # the message blob) — proving the engine ran and the data is structured.
        assert lead.estimate_min is not None and lead.estimate_max is not None, lead.message
        assert lead.estimate_max >= lead.estimate_min > 0
        # The customer's structured answers are persisted as columns, not prose.
        assert lead.square_footage == 2000
        assert lead.bathrooms == 3
        assert lead.frequency == "biweekly"
    finally:
        db.close()
        _cleanup(intake_id)


def test_estimate_price_returns_dict_not_tuple():
    """Pin the return contract so the unpack-as-tuple bug can't silently return."""
    from modules.booking.pricing import estimate_price
    out = estimate_price(service_type="residential", bathrooms=3, square_footage=2000, frequency="biweekly")
    assert isinstance(out, dict)
    assert isinstance(out["estimate_min"], (int, float))
    assert isinstance(out["estimate_max"], (int, float))
    assert out["estimate_max"] >= out["estimate_min"] > 0
