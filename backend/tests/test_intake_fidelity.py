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
    """Frequency must actually feed the estimator (it was hard-coded None).

    In the client-aligned labor-hour model biweekly is the baseline (1.0),
    weekly is 0.85, monthly 1.15, and one-time is 1.50 — so a recurring
    cadence prices below one-time. Compare biweekly vs an explicit one-time
    to prove both that the frequency is wired through AND that the discount
    direction is correct.
    """
    one_time = build_intake(name="A", email="a@example.com", service_key="residential",
                            square_footage=2000, bathrooms=2, frequency="one-time")
    biweekly = build_intake(name="A", email="a@example.com", service_key="residential",
                            square_footage=2000, bathrooms=2, frequency="biweekly")
    assert biweekly.estimate_max < one_time.estimate_max


def test_booking_essentials_land_in_custom_fields():
    """The /book flow ships six on-site "essentials" (entry method,
    parking notes, pets detail, focus areas, special instructions —
    bedrooms is already a column). They ride custom_fields=... into
    build_intake and must land on the LeadIntake row so the Requests
    page can render them next to the estimate."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        data = build_intake(
            name="Book Essentials", email=email, phone="2075559111",
            service_key="residential", bedrooms=3, bathrooms=2,
            square_footage=2000, frequency="biweekly",
            custom_fields={
                "entry_method": "lockbox",
                "parking_notes": "Driveway on the right",
                "pets_detail": "Friendly golden",
                "focus_areas": ["kitchen", "bathrooms"],
                "special_instructions": "Alarm code 4231",
                # Empties should be filtered out — the row shouldn't
                # carry noise the customer didn't actually set.
                "": "ignored",
                "was_null": None,
            },
        )
        assert data.custom_fields == {
            "entry_method": "lockbox",
            "parking_notes": "Driveway on the right",
            "pets_detail": "Friendly golden",
            "focus_areas": ["kitchen", "bathrooms"],
            "special_instructions": "Alarm code 4231",
        }
        res = upsert_lead(db, data)
        lead = db.query(LeadIntake).filter(LeadIntake.id == res["intake_id"]).first()
        assert lead.custom_fields["entry_method"] == "lockbox"
        assert lead.custom_fields["focus_areas"] == ["kitchen", "bathrooms"]
        assert lead.custom_fields["special_instructions"] == "Alarm code 4231"
        db.close()
    finally:
        _cleanup_email(email)


def test_booking_essentials_merge_on_dedup():
    """Cross-entrypoint dedup: a customer hits /api/intake/submit first
    (contact form, no essentials), then /api/booking/submit within the
    5-minute window (the /book flow, with essentials). The second call
    hits the recent-duplicate branch and would return early — this test
    pins that its custom_fields still land on the row via a shallow merge."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        first = build_intake(
            name="Merge Test", email=email, phone="2075550001",
            service_key="residential", bathrooms=2, square_footage=2000,
        )
        r1 = upsert_lead(db, first)
        assert r1["deduped"] is False

        second = build_intake(
            name="Merge Test", email=email, phone="2075550001",
            service_key="residential", bathrooms=2, square_footage=2000,
            custom_fields={
                "entry_method": "lockbox",
                "special_instructions": "Alarm code 4231",
            },
        )
        r2 = upsert_lead(db, second)
        assert r2["deduped"] is True
        assert r2["intake_id"] == r1["intake_id"]

        lead = db.query(LeadIntake).filter(LeadIntake.id == r1["intake_id"]).first()
        assert lead.custom_fields["entry_method"] == "lockbox"
        assert lead.custom_fields["special_instructions"] == "Alarm code 4231"

        # And a subsequent hit with more essentials should merge, not
        # replace — the earlier ones must survive.
        third = build_intake(
            name="Merge Test", email=email, phone="2075550001",
            service_key="residential", bathrooms=2, square_footage=2000,
            custom_fields={"parking_notes": "Driveway on the right"},
        )
        r3 = upsert_lead(db, third)
        assert r3["deduped"] is True
        lead = db.query(LeadIntake).filter(LeadIntake.id == r1["intake_id"]).first()
        assert lead.custom_fields["entry_method"] == "lockbox"
        assert lead.custom_fields["special_instructions"] == "Alarm code 4231"
        assert lead.custom_fields["parking_notes"] == "Driveway on the right"
        db.close()
    finally:
        _cleanup_email(email)


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


def test_booking_submit_fires_customer_and_owner_alerts():
    """Every booking landing fires two best-effort side effects: a Twilio SMS
    to the owner, and a confirmation email to the customer. Neither can be
    allowed to block the customer-facing HTTP response, so the test verifies
    they're INVOKED (the actual sending is stubbed here — real SMTP/Twilio
    aren't reachable from CI and don't need to be)."""
    from unittest.mock import patch
    email = _uniq_email()
    try:
        with patch("modules.booking.router._send_booking_owner_alert") as sms, \
             patch("modules.booking.router._send_booking_customer_confirmation") as mail:
            r = client.post("/api/booking/submit", json={
                "name": "Alert Test", "email": email, "phone": "2075557888",
                "address": "1 Main St", "serviceType": "residential",
                "requestedDate": "2026-07-01", "squareFeet": 2000, "bathrooms": 2,
                "frequency": "biweekly",
            })
            assert r.status_code == 201, r.text
            assert sms.called
            assert mail.called
            # Both get the same intake_id / estimate range so their bodies stay in sync.
            sms_args = sms.call_args.args + tuple(sms.call_args.kwargs.values())
            mail_args = mail.call_args.args + tuple(mail.call_args.kwargs.values())
            # Both should have been given a non-None intake_id.
            assert any(isinstance(a, int) and a > 0 for a in sms_args)
            assert any(isinstance(a, int) and a > 0 for a in mail_args)
    finally:
        _cleanup_email(email)


def test_booking_alerts_use_canonical_estimate_when_client_omits_it():
    """Codex P2 on #500: when the customer's booking payload doesn't
    include an estimate range (or ships an implausible one and it gets
    dropped), build_intake() recomputes and stores the canonical range
    on the intake row. Both alerts must see that recomputed value —
    otherwise the receipt promises an estimate line but omits it while
    the operator's Requests row shows one. Pins the fix."""
    from unittest.mock import patch
    email = _uniq_email()
    try:
        with patch("modules.booking.router._send_booking_owner_alert") as sms, \
             patch("modules.booking.router._send_booking_customer_confirmation") as mail:
            r = client.post("/api/booking/submit", json={
                "name": "Est Test", "email": email, "phone": "2075557999",
                "address": "1 Main St", "serviceType": "residential",
                "requestedDate": "2026-07-01", "squareFeet": 2000, "bathrooms": 2,
                "frequency": "biweekly",
                # No estimateMin / estimateMax — build_intake() recomputes.
            })
            assert r.status_code == 201, r.text
            # Both helpers should have received the recomputed range —
            # NOT None (the pre-normalize local vars) — as positional args 3+4.
            for helper in (sms, mail):
                mn, mx = helper.call_args.args[-2], helper.call_args.args[-1]
                assert mn is not None, f"{helper} got None estimate_min"
                assert mx is not None, f"{helper} got None estimate_max"
                assert mn <= mx
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
