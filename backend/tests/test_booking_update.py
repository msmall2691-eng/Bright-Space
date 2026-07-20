"""POST /api/booking/update — customer edits/cancels a website booking.

maineclean.co keys the customer's booking to the idempotencyKey UUID it minted
on submit, so the update path can find the Lead without exposing internal ids.
Covers: happy-path field update (requested_date + custom-fields essentials +
the audit note), the cancel path (status → "archived", the model's closed
value), and 404 on an unknown key.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import LeadIntake

client = TestClient(app)


def _submit_booking(**overrides):
    key = str(uuid.uuid4())
    payload = {
        "name": "Update Tester",
        "email": f"upd-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550188",
        "address": "12 Pine St, Portland, ME 04101",
        "serviceType": "standard",
        "requestedDate": "2026-08-10",
        "squareFeet": 1500,
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


def test_update_booking_changes_date_and_essentials():
    intake_id, key = _submit_booking()
    try:
        r = client.post("/api/booking/update", json={
            "idempotencyKey": key,
            "requestedDate": "2026-08-20",
            "specialInstructions": "Please use the side door",
            "bedrooms": 4,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {"ok": True, "leadId": intake_id, "status": "updated"}

        lead = _get_lead(intake_id)
        assert lead.requested_date == "2026-08-20"
        assert lead.preferred_date == "2026-08-20"
        assert lead.bedrooms == 4
        # Column-less essentials land on custom_fields under the same keys
        # /submit writes, so the Requests card shows the new value.
        assert (lead.custom_fields or {}).get("special_instructions") == "Please use the side door"
        # And the operator can see WHAT changed via the audit note.
        assert "[Customer update" in (lead.internal_notes or "")
        assert "2026-08-20" in lead.internal_notes
        # Not a cancellation — status untouched.
        assert lead.status != "archived"
    finally:
        _cleanup(intake_id)


def test_update_booking_tolerates_iso_timestamp_date():
    intake_id, key = _submit_booking()
    try:
        # The site has leaked full ISO timestamps into requestedDate before —
        # the stored value must stay a plain YYYY-MM-DD.
        r = client.post("/api/booking/update", json={
            "idempotencyKey": key,
            "requestedDate": "2026-09-01T22:18:23.208Z",
        })
        assert r.status_code == 200, r.text
        assert _get_lead(intake_id).requested_date == "2026-09-01"
    finally:
        _cleanup(intake_id)


def test_cancel_booking_archives_lead():
    intake_id, key = _submit_booking()
    try:
        r = client.post("/api/booking/update", json={
            "idempotencyKey": key,
            "cancel": True,
        })
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "cancelled"

        lead = _get_lead(intake_id)
        # "archived" is the LeadIntake convention for a closed/dead lead
        # (new/reviewed/quoted/converted/archived) — no new enum value.
        assert lead.status == "archived"
        assert "CANCELLED by customer" in (lead.internal_notes or "")
    finally:
        _cleanup(intake_id)


def test_update_booking_unknown_key_404():
    r = client.post("/api/booking/update", json={
        "idempotencyKey": str(uuid.uuid4()),
        "cancel": True,
    })
    assert r.status_code == 404
    assert r.json()["detail"] == "No matching booking"


def test_update_booking_accepts_focus_areas_list_and_string():
    # The maineclean.co forwarder sends focusAreas as a LIST (same shape as
    # /submit); legacy callers may send a comma-joined string. Both must
    # normalize to the list /submit stores (the Requests card .join()s it).
    intake_id, key = _submit_booking()
    try:
        r = client.post("/api/booking/update", json={
            "idempotencyKey": key,
            "focusAreas": ["kitchen", "bathrooms"],
        })
        assert r.status_code == 200, r.text
        assert (_get_lead(intake_id).custom_fields or {}).get("focus_areas") == ["kitchen", "bathrooms"]

        r = client.post("/api/booking/update", json={
            "idempotencyKey": key,
            "focusAreas": "windows, baseboards",
        })
        assert r.status_code == 200, r.text
        assert (_get_lead(intake_id).custom_fields or {}).get("focus_areas") == ["windows", "baseboards"]
    finally:
        _cleanup(intake_id)


def test_submit_booking_accepts_missing_requested_date():
    # Contact-form inquiries forwarded from maineclean.co carry no date at
    # all now (the Express layer used to fabricate "today", which turned
    # general questions into same-day residential jobs). The submit path must
    # accept a dateless payload and store requested_date as NULL.
    key = str(uuid.uuid4())
    r = client.post("/api/booking/submit", json={
        "name": "Dateless Inquirer",
        "email": f"nodate-{uuid.uuid4().hex[:8]}@example.com",
        "phone": "+12075550189",
        "address": "9 Elm St, Portland, ME 04101",
        "serviceType": "standard",
        "message": "General inquiry (contact form): what do you charge?",
        "idempotencyKey": key,
    })
    assert r.status_code == 201, r.text
    intake_id = r.json()["bookingId"]
    try:
        assert r.json()["requestedDate"] is None
        assert _get_lead(intake_id).requested_date is None
    finally:
        _cleanup(intake_id)
