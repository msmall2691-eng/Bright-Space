"""arrivalWindow + photos on the public booking path (cross-repo field contract).

maineclean.co's /book flow now forwards two new fields to POST /api/booking/submit
(and arrivalWindow again on POST /api/booking/update):

  - arrivalWindow: one of morning/afternoon/evening/flexible — stored on
    LeadIntake.custom_fields under snake_case ``arrival_window`` so it renders
    next to the other on-site essentials and the convert-to-job modal can seed
    the crew window from it.
  - photos: up to 3 base64 data-URI strings — stored inline on custom_fields
    under ``photos``, filtered to valid ``data:image/`` URIs and capped at 3 so a
    tampered payload can't bloat the row.

Covers: both fields land under the exact snake_case keys on submit, photos are
filtered/capped, and an update changes arrival_window in place.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake

client = TestClient(app)

# A short but well-formed image data URI (1x1 gif) — realistic enough to pass
# the ``data:image/`` guard without embedding a large blob in the test.
_VALID_PHOTO = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="


def _submit_booking(**overrides):
    key = str(uuid.uuid4())
    payload = {
        "name": "Arrival Tester",
        "email": f"arr-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550177",
        "address": "44 Oak St, Portland, ME 04101",
        "serviceType": "standard",
        "requestedDate": "2026-08-12",
        "squareFeet": 1400,
        "bathrooms": 2,
        "idempotencyKey": key,
    }
    payload.update(overrides)
    r = client.post("/api/booking/submit", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["bookingId"], key


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


def test_submit_stores_arrival_window_and_photos():
    intake_id, _ = _submit_booking(
        arrivalWindow="afternoon",
        # One valid photo, one non-image data URI (dropped), one non-string
        # (dropped) — only the valid image URI should survive.
        photos=[_VALID_PHOTO, "data:text/plain;base64,aGVsbG8=", 12345],
    )
    try:
        cf = _get_lead(intake_id).custom_fields or {}
        # Exact snake_case keys so they render beside the other essentials.
        assert cf.get("arrival_window") == "afternoon"
        assert cf.get("photos") == [_VALID_PHOTO]
    finally:
        _cleanup(intake_id)


def test_submit_caps_photos_at_three():
    intake_id, _ = _submit_booking(photos=[_VALID_PHOTO] * 5)
    try:
        assert len(((_get_lead(intake_id).custom_fields or {}).get("photos") or [])) == 3
    finally:
        _cleanup(intake_id)


def test_submit_without_new_fields_leaves_keys_absent():
    # A residential lead that sends neither field must not grow empty keys —
    # build_intake drops None/[] before persisting.
    intake_id, _ = _submit_booking()
    try:
        cf = _get_lead(intake_id).custom_fields or {}
        assert "arrival_window" not in cf
        assert "photos" not in cf
    finally:
        _cleanup(intake_id)


def test_update_changes_arrival_window():
    intake_id, key = _submit_booking(arrivalWindow="morning")
    try:
        r = client.post("/api/booking/update", json={
            "idempotencyKey": key,
            "arrivalWindow": "evening",
        })
        assert r.status_code == 200, r.text
        lead = _get_lead(intake_id)
        assert (lead.custom_fields or {}).get("arrival_window") == "evening"
        # Operator audit trail records the change.
        assert "arrival window" in (lead.internal_notes or "")
    finally:
        _cleanup(intake_id)
