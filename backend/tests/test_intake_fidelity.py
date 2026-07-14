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
from database.models import LeadIntake, Client, Activity, ContactEmail, ContactPhone, Opportunity, Property
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
            # upsert_lead's canonical-contacts path also writes ContactEmail/
            # ContactPhone rows for the client — never cleaned up here
            # before, so deleting the Client without them violated their
            # client_id FKs on Postgres, aborting this whole cleanup
            # transaction and leaving every row from the test uncleaned.
            db.query(ContactEmail).filter(ContactEmail.client_id.in_(client_ids)).delete(synchronize_session=False)
            db.query(ContactPhone).filter(ContactPhone.client_id.in_(client_ids)).delete(synchronize_session=False)
            # upsert_lead also auto-creates/advances an Opportunity for the
            # client, and can auto-create a Property for a booking address —
            # same FK-on-delete problem as above.
            db.query(Opportunity).filter(Opportunity.client_id.in_(client_ids)).delete(synchronize_session=False)
            db.query(Property).filter(Property.client_id.in_(client_ids)).delete(synchronize_session=False)
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


def test_webhook_intake_captures_city():
    """WebhookPayload used to have no `city` field at all — Pydantic's
    extra="ignore" silently dropped it even if the site sent one, so a lead
    that only had a city (no full street address) ended up with just
    LeadIntake.state's "ME" column default, which the quote form's
    combineAddress then rendered as a bare, misleading "ME" (reported:
    Requests -> Create Quote showed "ME" as the whole Service Address)."""
    email = _uniq_email()
    try:
        r = client.post("/api/intake/webhook", json={
            "name": "City Field Test", "email": email,
            "city": "Waterboro", "zip": "04061", "serviceType": "residential",
        })
        assert r.status_code == 201, r.text

        db = SessionLocal()
        lead = db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).first()
        assert lead.city == "Waterboro"
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


# --- Audit July-2026 M2: idempotency key collapses dual-forward -----------

def test_idempotency_key_collapses_two_posts_into_one_lead():
    """Two POSTs with the same idempotency_key = one Lead row.

    Pins the July-2026 audit's M2 fix. The maineclean.co Express middle layer
    forwards a single booking to Bright-Space more than once (see brightbase.ts
    + routes.ts /api/intake/submit handler). Before this fix the 5-minute
    recency SELECT missed on concurrent inserts, so ops saw two identical
    Leads in Billing → Leads for one customer submission.
    """
    email = _uniq_email()
    key = f"idem-{uuid.uuid4().hex}"
    try:
        # First submit — creates the row.
        r1 = client.post("/api/booking/submit", json={
            "name": "Idem Test", "email": email, "phone": "2075558811",
            "address": "1 Test Rd", "serviceType": "residential",
            "requestedDate": "2026-08-01", "squareFeet": 1500, "bathrooms": 2,
            "frequency": "biweekly", "idempotencyKey": key,
        })
        assert r1.status_code == 201, r1.text
        first_id = r1.json()["bookingId"]

        # Second submit — same key, different address (simulating a stale
        # forward). Must return the same row, not create a second one.
        r2 = client.post("/api/booking/submit", json={
            "name": "Idem Test", "email": email, "phone": "2075558811",
            "address": "2 OTHER Rd", "serviceType": "residential",
            "requestedDate": "2026-08-01", "squareFeet": 1500, "bathrooms": 2,
            "frequency": "biweekly", "idempotencyKey": key,
        })
        assert r2.status_code == 201, r2.text
        assert r2.json()["bookingId"] == first_id

        db = SessionLocal()
        rows = db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).all()
        assert len(rows) == 1, (
            f"expected 1 Lead for idempotent double-post, got {len(rows)}"
        )
        assert rows[0].idempotency_key == key
        db.close()
    finally:
        _cleanup_email(email)


# --- Audit July-2026 M1: matched-Client refresh ---------------------------

def test_returning_customer_booking_refreshes_stale_client_fields():
    """A returning customer's new booking address/phone updates the Client.

    Pins the July-2026 audit's M1 fix. Before this, the matched-Client branch
    was fill-if-null, so a customer whose master record had an old address
    stayed permanently stale even as new bookings arrived with fresh info.
    The multi-value client_emails / client_phones tables still record history.
    """
    email = _uniq_email()
    try:
        # First lead — sets the client's initial contact info.
        db = SessionLocal()
        data1 = build_intake(
            name="Return Test", email=email, phone="2075550001",
            address="OLD 1 Old St", city="Old City", state="ME", zip_code="00001",
            service_key="residential", bedrooms=2, bathrooms=1, square_footage=1000,
            frequency="biweekly",
        )
        upsert_lead(db, data1)
        db.commit()
        client_row = db.query(Client).filter(Client.email.ilike(email)).one()
        assert client_row.address == "OLD 1 Old St"
        assert client_row.phone == "+12075550001"
        db.close()

        # Second lead — same customer, new address + phone + zip. This time we
        # need a fresh recency window so the idempotency SELECT doesn't hit.
        # We use a new email that ALSO points to the same client via the
        # client_emails helper. Simpler: bypass the recent-dup window by
        # inserting the second row directly and letting client match do its
        # thing on phone.
        # (In production this is time-separated by hours/days; here we clear
        # the recent-lead's created_at to simulate that gap.)
        db = SessionLocal()
        recent = (
            db.query(LeadIntake)
            .filter(LeadIntake.email.ilike(email))
            .order_by(LeadIntake.created_at.desc())
            .first()
        )
        from datetime import datetime, timedelta, timezone
        recent.created_at = datetime.now(timezone.utc) - timedelta(hours=2)
        db.commit()
        db.close()

        db = SessionLocal()
        data2 = build_intake(
            name="Return Test", email=email, phone="2079998888",
            address="NEW 155 Keystone Dr", city="New Town", state="ME",
            zip_code="04061", service_key="residential", bedrooms=2,
            bathrooms=1, square_footage=1000, frequency="biweekly",
        )
        upsert_lead(db, data2)
        db.commit()

        client_row = db.query(Client).filter(Client.email.ilike(email)).one()
        # Client fields overwritten by the newer booking's values (M1 fix).
        assert client_row.address == "NEW 155 Keystone Dr", client_row.address
        assert client_row.phone == "+12079998888", client_row.phone
        assert client_row.zip_code == "04061"
        assert client_row.city == "New Town"
        db.close()
    finally:
        _cleanup_email(email)


def test_overwriting_client_primary_preserves_old_email_in_history():
    """A legacy client with only Client.email populated (no contact_emails row)
    must keep its old email in the multi-value table when a new booking
    overwrites the primary. Otherwise a later Gmail thread using the old
    address can't match this client anymore.

    Pins the July-2026 audit review's follow-up (P2 on PR #507).
    """
    from database.models import Client, ContactEmail

    new_email = _uniq_email()
    old_email = _uniq_email()
    # Unique phone so find_client_by_contact matches THIS legacy row and not
    # some leftover from an earlier test on a shared SQLite CI DB.
    unique_phone_digits = "207555" + f"{uuid.uuid4().int % 10000:04d}"
    unique_phone_e164 = "+1" + unique_phone_digits
    try:
        db = SessionLocal()
        # Simulate a legacy client: primary email on Client, but no matching
        # contact_emails row for this address (pre-multi-value migration state).
        legacy = Client(
            name="Legacy Cust", email=old_email, phone=unique_phone_e164,
            address="10 Old Rd", city="Old City", state="ME",
            zip_code="00001", status="lead", source="import",
        )
        db.add(legacy)
        db.commit()
        legacy_id = legacy.id

        # Sanity: no contact_emails row for this specific email yet.
        assert db.query(ContactEmail).filter(
            ContactEmail.client_id == legacy_id,
            ContactEmail.email.ilike(old_email),
        ).count() == 0
        db.close()

        # New booking arrives with a DIFFERENT email but same phone (so
        # find_client_by_contact matches this legacy client).
        db = SessionLocal()
        data = build_intake(
            name="Legacy Cust", email=new_email, phone=unique_phone_digits,
            address="20 New Rd", city="New City", state="ME", zip_code="00002",
            service_key="residential", bedrooms=2, bathrooms=1,
        )
        upsert_lead(db, data)
        db.commit()

        c = db.query(Client).filter(Client.id == legacy_id).one()
        # Primary now the new email.
        assert c.email == new_email
        # Old email preserved in contact_emails so future Gmail/manual lookups
        # by that address still resolve to this client.
        old_row = (
            db.query(ContactEmail)
            .filter(ContactEmail.client_id == legacy_id,
                    ContactEmail.email.ilike(old_email))
            .first()
        )
        assert old_row is not None, (
            "old primary email must be copied to contact_emails BEFORE overwrite"
        )
        # New email also in the history (via the standing add_contact_email).
        new_row = (
            db.query(ContactEmail)
            .filter(ContactEmail.client_id == legacy_id,
                    ContactEmail.email.ilike(new_email))
            .first()
        )
        assert new_row is not None
        db.close()
    finally:
        _cleanup_email(new_email)
        _cleanup_email(old_email)
