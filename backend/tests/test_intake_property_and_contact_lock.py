"""Inbox-only intake + conversion-layer dedup + concurrency-lock regressions.

Inbound requests are an INBOX (Twenty-style): upsert_lead creates ONLY a
LeadIntake row — no Client, Property, or Opportunity — so a returning
customer, a typo'd email, or a second phone number can't spawn a duplicate
client/property just by submitting the website form.

Client/property dedup now happens at CONVERSION, the single place a request
becomes a customer (modules.intake.router._resolve_client_for_intake /
_resolve_property_for_intake). These tests pin that:
  * a request creates nothing but itself,
  * converting a request reuses an existing client matched on email/phone,
  * each distinct service address lands as its own Property, and
  * the same address (whitespace/case variants) never spawns a duplicate.

Also keeps the contact-advisory-lock key tests, which still guard the
concurrent-submission race in upsert_lead.
"""
import uuid
from datetime import datetime, timedelta, timezone

from database.db import SessionLocal
from database.models import (
    Activity, Client, LeadIntake, Property, Opportunity, ContactEmail, ContactPhone,
)
from modules.intake.normalize import build_intake, upsert_lead


def _uniq_email():
    return f"m1-{uuid.uuid4().hex[:10]}@example.com"


def _cleanup(*emails):
    db = SessionLocal()
    try:
        for email in emails:
            client_ids = [c.id for c in db.query(Client).filter(Client.email.ilike(email)).all()]
            # Delete lead rows first (they FK to clients) — match by the lead's
            # own email AND by client_id, since a converted request can carry a
            # different email than its resolved client.
            db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).delete(synchronize_session=False)
            if client_ids:
                db.query(LeadIntake).filter(LeadIntake.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(Activity).filter(Activity.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(Property).filter(Property.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(Opportunity).filter(Opportunity.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(ContactEmail).filter(ContactEmail.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(ContactPhone).filter(ContactPhone.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(Client).filter(Client.id.in_(client_ids)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _age_intake(intake_id, hours=1):
    """Push a lead's created_at outside the 5-minute recency window so the next
    upsert_lead is treated as a genuinely separate visit (not merged into it)."""
    db = SessionLocal()
    try:
        row = db.query(LeadIntake).filter(LeadIntake.id == intake_id).one()
        row.created_at = datetime.now(timezone.utc) - timedelta(hours=hours)
        db.commit()
    finally:
        db.close()


def _convert(db, intake_id, org_id=1):
    """Run the staff conversion path (dedup-or-create client + property)."""
    from modules.intake.router import (
        _resolve_client_for_intake, _resolve_property_for_intake,
    )
    intake = db.query(LeadIntake).filter(LeadIntake.id == intake_id).one()
    client, created = _resolve_client_for_intake(db, intake, org_id)
    prop = _resolve_property_for_intake(db, client, intake)
    db.commit()
    return client, prop, created


def test_new_request_is_inbox_only():
    """A website submission creates a LeadIntake and NOTHING else — no client,
    property, opportunity, or timeline activity."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        res = upsert_lead(db, build_intake(
            name="Inbox Only", email=email, phone="2075550101",
            service_key="residential", address="123 Ocean Ave", city="Kennebunk",
            state="ME", zip_code="04043", square_footage=1600, bathrooms=2,
        ))
        assert res["deduped"] is False
        assert res["client_id"] is None
        assert db.query(Client).filter(Client.email.ilike(email)).first() is None
        assert db.query(Property).filter(Property.address == "123 Ocean Ave").first() is None
        db.close()
    finally:
        _cleanup(email)


def test_returning_customer_new_address_adds_property_on_same_client():
    """Convert a first request (client A, address 1), then a second request
    from the same person at a new address — it reuses client A and adds the
    new address as a SECOND property, not a duplicate client."""
    email = _uniq_email()
    email2 = _uniq_email()
    try:
        db = SessionLocal()
        r1 = upsert_lead(db, build_intake(
            name="Repeat Customer", email=email, phone="2075550101",
            service_key="residential", address="123 Ocean Ave", city="Kennebunk",
            state="ME", zip_code="04043", square_footage=1600, bathrooms=2,
        ))
        c1, _p, created1 = _convert(db, r1["intake_id"])
        cid = c1.id
        assert created1 is True
        db.close()

        _age_intake(r1["intake_id"])  # second request is a separate visit
        db = SessionLocal()
        r2 = upsert_lead(db, build_intake(
            name="Repeat Customer", email=email2, phone="2075550101",
            service_key="residential", address="155 Keystone Dr",
            city="Waterboro", state="ME", zip_code="04061",
            square_footage=2000, bathrooms=2,
        ))
        c2, _p2, created2 = _convert(db, r2["intake_id"])
        assert created2 is False and c2.id == cid, "returning customer must reuse the client"

        props = db.query(Property).filter(Property.client_id == cid).all()
        addresses = {(p.address or "").lower() for p in props}
        assert "123 ocean ave" in addresses and "155 keystone dr" in addresses, addresses
        assert len(props) == 2
        db.close()
    finally:
        _cleanup(email, email2)


def test_property_dedup_respects_city():
    """Same street line, two cities → two properties under the client, not one
    collapsed row."""
    email = _uniq_email()
    email2 = _uniq_email()
    try:
        db = SessionLocal()
        r1 = upsert_lead(db, build_intake(
            name="Two Cities", email=email, phone="2075550606",
            service_key="residential", address="123 Main St", city="Portland",
            state="ME", zip_code="04101",
        ))
        c1, _p, _ = _convert(db, r1["intake_id"])
        cid = c1.id
        db.close()

        _age_intake(r1["intake_id"])  # second request is a separate visit
        db = SessionLocal()
        r2 = upsert_lead(db, build_intake(
            name="Two Cities", email=email2, phone="2075550606",
            service_key="residential", address="123 Main St", city="Bath",
            state="ME", zip_code="04530",
        ))
        _convert(db, r2["intake_id"])

        cities = {
            (p.city or "").lower()
            for p in db.query(Property).filter(Property.client_id == cid).all()
        }
        assert "portland" in cities and "bath" in cities, cities
        db.close()
    finally:
        _cleanup(email, email2)


def test_same_address_does_not_spawn_duplicate_property():
    """Converting two requests at the same address (whitespace + case variants)
    reuses the one property — no duplicate row."""
    email = _uniq_email()
    email2 = _uniq_email()
    try:
        db = SessionLocal()
        r1 = upsert_lead(db, build_intake(
            name="Same Addr", email=email, phone="2075550202",
            service_key="residential", address="42 Pine St", city="Portland",
            state="ME", zip_code="04101", square_footage=1500, bathrooms=1,
        ))
        c1, _p, _ = _convert(db, r1["intake_id"])
        cid = c1.id
        first_count = db.query(Property).filter(Property.client_id == cid).count()
        db.close()

        _age_intake(r1["intake_id"])  # second request is a separate visit
        db = SessionLocal()
        r2 = upsert_lead(db, build_intake(
            name="Same Addr", email=email2, phone="2075550202",
            service_key="residential", address="42 Pine St ", city="portland",
            state="ME", zip_code="04101", square_footage=1500, bathrooms=1,
        ))
        _convert(db, r2["intake_id"])
        second_count = db.query(Property).filter(Property.client_id == cid).count()
        assert second_count == first_count, (
            "normalizing on whitespace + case should have matched the existing "
            "property; got a duplicate row."
        )
        db.close()
    finally:
        _cleanup(email, email2)


def test_convert_reuses_existing_client_matched_by_phone():
    """Two requests that share only a phone number convert into ONE client."""
    email = _uniq_email()
    email2 = _uniq_email()
    try:
        db = SessionLocal()
        r1 = upsert_lead(db, build_intake(
            name="Contact Variance", email=email, phone="2075550303",
            service_key="residential", address="7 Maple Rd",
            state="ME", zip_code="04101", square_footage=1800, bathrooms=2,
        ))
        c1, _p, _ = _convert(db, r1["intake_id"])
        cid = c1.id
        db.close()

        _age_intake(r1["intake_id"])  # second request is a separate visit
        db = SessionLocal()
        # Second request: no email, same phone.
        r2 = upsert_lead(db, build_intake(
            name="Contact Variance", email=None, phone="2075550303",
            service_key="residential", address="7 Maple Rd",
            state="ME", zip_code="04101", square_footage=1800, bathrooms=2,
        ))
        c2, _p2, created2 = _convert(db, r2["intake_id"])
        assert created2 is False and c2.id == cid
        # Exactly one client for this person.
        assert db.query(Client).filter(
            Client.phone.like("%2075550303")
        ).count() == 1
        db.close()
    finally:
        _cleanup(email, email2)


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
