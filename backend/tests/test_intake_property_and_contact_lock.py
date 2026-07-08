"""Audit M1 + concurrency-hardening regression tests.

M1: when a returning customer books via maineclean.co with a new service
address, that address must land on their Client as a Property so the master
record reflects where they actually want service — not just their stale
lead-phase primary from months ago. (upsert_lead's Client-field refresh
already keeps email/phone/address current for the LATEST submission; this
is the complementary fix so OLDER addresses aren't lost when a client has
more than one property.)

Also pins the activity-dedup guard that rides along with the same race-
condition class: a client that matches on two different fields (e.g. one
submission has email-only, another has phone-only) must still get only
ONE 'New residential lead' timeline entry per booking window, even if the
contact-level advisory lock hashed the two submissions to different keys.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from database.db import SessionLocal
from database.models import Activity, Client, LeadIntake, Property
from modules.intake.normalize import build_intake, upsert_lead


def _uniq_email():
    return f"m1-{uuid.uuid4().hex[:10]}@example.com"


def _cleanup(email):
    db = SessionLocal()
    try:
        client_ids = [c.id for c in db.query(Client).filter(Client.email.ilike(email)).all()]
        if client_ids:
            db.query(Activity).filter(Activity.client_id.in_(client_ids)).delete(synchronize_session=False)
            db.query(Property).filter(Property.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).delete(synchronize_session=False)
        db.query(Client).filter(Client.email.ilike(email)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _age_last_intake(db, email, hours=1):
    """Push the most recent LeadIntake for this email outside the 5-minute
    dedup window so the next upsert_lead call takes the non-dedup branch,
    simulating a booking that arrives well after the first."""
    row = (
        db.query(LeadIntake)
        .filter(LeadIntake.email.ilike(email))
        .order_by(LeadIntake.created_at.desc())
        .first()
    )
    row.created_at = datetime.now(timezone.utc) - timedelta(hours=hours)
    db.commit()


def test_returning_customer_new_address_lands_as_property():
    email = _uniq_email()
    try:
        db = SessionLocal()
        first = build_intake(
            name="Repeat Customer", email=email, phone="2075550101",
            service_key="residential", address="123 Ocean Ave", city="Kennebunk",
            state="ME", zip_code="04043", square_footage=1600, bathrooms=2,
        )
        upsert_lead(db, first)
        c = db.query(Client).filter(Client.email.ilike(email)).first()
        assert c is not None
        original_props = db.query(Property).filter(Property.client_id == c.id).count()

        _age_last_intake(db, email)

        second = build_intake(
            name="Repeat Customer", email=email, phone="2075559999",
            service_key="residential", address="155 Keystone Dr",
            city="Waterboro", state="ME", zip_code="04061",
            square_footage=2000, bathrooms=2,
        )
        upsert_lead(db, second)

        props = db.query(Property).filter(Property.client_id == c.id).all()
        addresses = {(p.address or "").lower() for p in props}
        assert "155 keystone dr" in addresses, (
            "M1: the new booking's address should have been added as a Property "
            f"on the returning customer's client. Got: {addresses}"
        )
        assert len(props) > original_props
    finally:
        _cleanup(email)


def test_property_upsert_fires_even_on_dedup_path():
    """A lightweight /intake/submit landing first WITHOUT an address, then a
    /booking/submit within the 5-minute dedup window WITH the service
    address, must still attach the address as a Property. The property
    upsert only running on the non-dedup branch would leave the returning-
    customer service address missing from the master client record."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        first = build_intake(
            name="Late Address", email=email, phone="2075550505",
            service_key="residential",
        )
        r1 = upsert_lead(db, first)
        assert r1["deduped"] is False
        c = db.query(Client).filter(Client.email.ilike(email)).first()
        assert c is not None
        assert db.query(Property).filter(Property.client_id == c.id).count() == 0

        second = build_intake(
            name="Late Address", email=email, phone="2075550505",
            service_key="residential", address="42 Late Rd", city="Portland",
            state="ME", zip_code="04101",
        )
        r2 = upsert_lead(db, second)
        assert r2["deduped"] is True  # merged into the first lead

        props = db.query(Property).filter(Property.client_id == c.id).all()
        addresses = {(p.address or "").lower() for p in props}
        assert "42 late rd" in addresses, (
            f"property upsert must fire on the dedup path too, got {addresses}"
        )
    finally:
        _cleanup(email)


def test_property_dedup_respects_city():
    """Same street line, two cities → two properties, not one collapsed row."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        p1 = build_intake(
            name="Two Cities", email=email, phone="2075550606",
            service_key="residential", address="123 Main St", city="Portland",
            state="ME", zip_code="04101",
        )
        upsert_lead(db, p1)
        c = db.query(Client).filter(Client.email.ilike(email)).first()

        _age_last_intake(db, email)

        p2 = build_intake(
            name="Two Cities", email=email, phone="2075550606",
            service_key="residential", address="123 Main St", city="Bath",
            state="ME", zip_code="04530",
        )
        upsert_lead(db, p2)

        cities = {
            (p.city or "").lower()
            for p in db.query(Property).filter(Property.client_id == c.id).all()
        }
        assert "portland" in cities and "bath" in cities, (
            f"same street in two cities should be two properties, got cities={cities}"
        )
    finally:
        _cleanup(email)


def test_same_address_does_not_spawn_duplicate_property():
    email = _uniq_email()
    try:
        db = SessionLocal()
        payload = build_intake(
            name="Same Addr", email=email, phone="2075550202",
            service_key="residential", address="42 Pine St", city="Portland",
            state="ME", zip_code="04101", square_footage=1500, bathrooms=1,
        )
        upsert_lead(db, payload)
        c = db.query(Client).filter(Client.email.ilike(email)).first()
        first_count = db.query(Property).filter(Property.client_id == c.id).count()

        _age_last_intake(db, email)

        upsert_lead(db, build_intake(
            name="Same Addr", email=email, phone="2075550202",
            service_key="residential", address="42 Pine St ", city="portland",
            state="ME", zip_code="04101", square_footage=1500, bathrooms=1,
        ))
        second_count = db.query(Property).filter(Property.client_id == c.id).count()
        assert second_count == first_count, (
            "normalizing on whitespace + case should have matched the "
            "existing property; got duplicate rows."
        )
    finally:
        _cleanup(email)


def test_lead_activity_not_double_logged_on_contact_variance():
    """Two submissions that resolve to the SAME client via different contact
    fields (one has email, the other only phone) must still produce only
    ONE 'New residential lead' timeline entry — the activity-level guard,
    not just the contact-lock, has to hold."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        p1 = build_intake(
            name="Contact Variance", email=email, phone="2075550303",
            service_key="residential", address="7 Maple Rd",
            state="ME", zip_code="04101", square_footage=1800, bathrooms=2,
        )
        upsert_lead(db, p1)

        # Second submission has no email — different advisory-lock key —
        # but matches the same client via phone.
        p2 = build_intake(
            name="Contact Variance", email=None, phone="2075550303",
            service_key="residential", address="7 Maple Rd",
            state="ME", zip_code="04101", square_footage=1800, bathrooms=2,
        )
        upsert_lead(db, p2)

        c = db.query(Client).filter(Client.email.ilike(email)).first()
        lead_activities = db.query(Activity).filter(
            Activity.client_id == c.id,
            Activity.activity_type == "lead_created",
        ).all()
        assert len(lead_activities) == 1, (
            f"expected one lead_created activity per booking window, "
            f"got {len(lead_activities)}"
        )
    finally:
        _cleanup(email)


def test_contact_lock_keys_are_stable_and_bounded():
    """_contact_lock_keys must return deterministic signed 64-bit ints (or
    an empty list for no contact info) so they're safe to pass to
    pg_advisory_xact_lock."""
    from modules.intake.normalize import _contact_lock_keys

    k1 = _contact_lock_keys("Same@Example.com", "2075551234")
    k2 = _contact_lock_keys("same@example.com", "(207) 555-1234")
    assert k1 == k2, "normalization (case + phone format) must not change the keys"
    assert len(k1) == 2  # one key for email, one for phone
    for k in k1:
        assert isinstance(k, int)
        assert -(1 << 63) <= k < (1 << 63)

    assert _contact_lock_keys(None, None) == []
    assert _contact_lock_keys("", "") == []


def test_contact_lock_keys_share_a_key_on_partial_overlap():
    """Codex P1 on PR #533: two requests that share ONLY email (one has no
    phone, the other does) must still share at least one lock key —
    otherwise they'd serialize on nothing and both race past the recency
    SELECT. Same for two requests that share only phone with a corrected
    email."""
    from modules.intake.normalize import _contact_lock_keys

    email_only = _contact_lock_keys("same@example.com", None)
    email_and_phone = _contact_lock_keys("same@example.com", "2075551234")
    assert set(email_only) & set(email_and_phone), (
        "requests sharing only email must share a lock key"
    )

    phone_only = _contact_lock_keys(None, "2075559999")
    corrected_email_same_phone = _contact_lock_keys("new@example.com", "2075559999")
    assert set(phone_only) & set(corrected_email_same_phone), (
        "requests sharing only phone must share a lock key"
    )

    # Genuinely unrelated contacts share nothing.
    unrelated = _contact_lock_keys("nobody@example.com", "2075550000")
    assert not (set(email_only) & set(unrelated))
    assert not (set(phone_only) & set(unrelated))
