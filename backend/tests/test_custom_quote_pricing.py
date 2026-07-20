"""Custom-quote services must never get a fabricated instant estimate — at the
ENGINE level, not just at the intake layer.

The old estimate_price() ran the labor formula on defaults (2000 sqft, 1 bath)
for STR / commercial and returned a ~$230–250 "placeholder" range. Only
build_intake() suppressed it, so every other caller leaked the number: the
public /instant-quote endpoint, the AI quote-prefill, the owner SMS. Now the
engine itself returns estimate_min/max = None (with breakdown.custom_quote =
True) for those services, so no caller can show a price the customer never saw.
"""
from fastapi.testclient import TestClient

from main import app
from modules.booking.pricing import estimate_price

client = TestClient(app)


# ── Engine ──────────────────────────────────────────────────────────────────

def test_estimate_price_str_returns_none():
    out = estimate_price(service_type="str", bedrooms=3, bathrooms=2.5)
    assert out["estimate_min"] is None
    assert out["estimate_max"] is None
    assert out["breakdown"]["custom_quote"] is True
    # The computed dollars are nulled too, so a caller rendering the breakdown
    # can't leak them either.
    assert out["breakdown"]["final_mid"] is None
    assert out["breakdown"]["raw"] is None


def test_estimate_price_commercial_returns_none():
    for svc in ("commercial", "commercial-cleaning", "airbnb-turnover", "vacation-rental"):
        out = estimate_price(service_type=svc, square_footage=2400)
        assert out["estimate_min"] is None, svc
        assert out["estimate_max"] is None, svc
        assert out["breakdown"]["custom_quote"] is True, svc


def test_estimate_price_residential_and_deep_still_priced():
    res = estimate_price(service_type="residential", bathrooms=2,
                         square_footage=1500, frequency="biweekly")
    assert res["estimate_min"] is not None and res["estimate_max"] is not None
    assert res["estimate_max"] >= res["estimate_min"] > 0
    assert res["breakdown"]["custom_quote"] is False

    deep = estimate_price(service_type="deep", bathrooms=2,
                          square_footage=1500, frequency="biweekly")
    assert deep["estimate_min"] is not None and deep["estimate_max"] is not None
    # Deep is the same home at a >1x multiplier — must price above standard.
    assert deep["estimate_min"] > res["estimate_min"]


# ── Public /instant-quote endpoint ──────────────────────────────────────────

def test_instant_quote_endpoint_str_is_custom_quote():
    r = client.post("/api/booking/instant-quote", json={
        "serviceType": "str", "bedrooms": 3, "bathrooms": 2,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["custom_quote"] is True
    assert body["estimate_min"] is None
    assert body["estimate_max"] is None
    assert body["breakdown"]["custom_quote"] is True


def test_str_owner_alert_carries_no_estimate(monkeypatch):
    """The owner SMS/email for an STR booking must not resurrect the
    customer's submitted (suppressed) estimate — the Requests row shows
    "Custom quote", so the alert must not show $200–220."""
    import uuid
    import modules.booking.router as booking_router
    from database.db import SessionLocal
    from database.models import LeadIntake

    captured = {}

    def fake_alert(db, data, intake_id, emin, emax):
        captured["est"] = (emin, emax)
        return True

    monkeypatch.setattr(booking_router, "_send_booking_owner_alert", fake_alert)
    r = client.post("/api/booking/submit", json={
        "name": "Alert Leak",
        "email": f"leak-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550166",
        "address": "9 Cove Rd, Portland, ME 04101",
        "serviceType": "str",
        "requestedDate": "2026-09-05",
        # Stale/tampered range — must not reach the owner alert.
        "estimateMin": 200,
        "estimateMax": 220,
    })
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        assert captured["est"] == (None, None)
    finally:
        db = SessionLocal()
        try:
            db.query(LeadIntake).filter(LeadIntake.id == intake_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()


def test_instant_quote_endpoint_residential_still_returns_numbers():
    r = client.post("/api/booking/instant-quote", json={
        "serviceType": "standard", "squareFeet": 1500,
        "bathrooms": 2.5, "frequency": "biweekly",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["custom_quote"] is False
    assert body["estimate_min"] is not None and body["estimate_max"] is not None
    assert body["estimate_max"] >= body["estimate_min"] > 0
