"""Audit M1 + L3 regression tests.

M1: when a returning customer books via maineclean.co with a new service
address, that address must land on their Client as a Property so the master
record reflects where they actually want service — not just their stale
lead-phase primary from months ago.

L3: a single visit that races two upsert_lead calls (or produces a re-fired
intake within the dedup window) must not double-log "New residential lead"
on the client timeline. The activity write is now gated on
_recent_lead_activity_exists.
"""
import uuid

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


def test_returning_customer_new_address_lands_as_property():
    email = _uniq_email()
    try:
        db = SessionLocal()
        # First booking with the customer's old address establishes the client.
        first = build_intake(
            name="Repeat Customer", email=email, phone="2075550101",
            service_key="residential", address="123 Ocean Ave", city="Kennebunk",
            state="ME", zip_code="04043", square_footage=1600, bathrooms=2,
        )
        upsert_lead(db, first)
        c = db.query(Client).filter(Client.email.ilike(email)).first()
        assert c is not None
        original_props = db.query(Property).filter(Property.client_id == c.id).count()

        # Second booking, well outside the dedup window (simulate months later
        # by directly bypassing _find_recent_duplicate: just use a different
        # email/phone signature to force the non-dedup path, matching by
        # ContactEmail instead). Use the same email so find_client_by_contact
        # still matches.
        second = build_intake(
            name="Repeat Customer", email=email, phone="2075559999",
            service_key="residential", address="155 Keystone Dr",
            city="Waterboro", state="ME", zip_code="04061",
            square_footage=2000, bathrooms=2,
        )
        # Force past the LeadIntake dedup window by aging the first intake.
        from datetime import datetime, timedelta, timezone
        old = db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).first()
        old.created_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.commit()

        upsert_lead(db, second)

        props = db.query(Property).filter(Property.client_id == c.id).all()
        addresses = {(p.address or "").lower() for p in props}
        assert "155 keystone dr" in addresses, (
            "M1: the new booking's address should have been added as a Property "
            f"on the returning customer's client. Got: {addresses}"
        )
        # We should have strictly more properties than before.
        assert len(props) > original_props
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

        # Age the first intake past the dedup window, then re-submit the exact
        # same address — no new property should be created.
        from datetime import datetime, timedelta, timezone
        old = db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).first()
        old.created_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.commit()

        upsert_lead(db, build_intake(
            name="Same Addr", email=email, phone="2075550202",
            service_key="residential", address="42 Pine St ", city="portland",
            state="ME", zip_code="04101", square_footage=1500, bathrooms=1,
        ))
        second_count = db.query(Property).filter(Property.client_id == c.id).count()
        assert second_count == first_count, (
            "M1: normalizing on whitespace + case should have matched the "
            "existing property; got duplicate rows."
        )
    finally:
        _cleanup(email)


def test_lead_activity_not_double_logged_on_race():
    """L3: even if two nearly-simultaneous submissions both pass
    _find_recent_duplicate (before either has committed) and both write a
    LeadIntake for the same client, the client timeline must only carry ONE
    'New residential lead' entry per booking window."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        p1 = build_intake(
            name="Race Test", email=email, phone="2075550303",
            service_key="residential", address="7 Maple Rd",
            state="ME", zip_code="04101", square_footage=1800, bathrooms=2,
        )
        upsert_lead(db, p1)

        # Simulate a second write that raced the first: force a fresh
        # LeadIntake by using a different email/phone signature so the
        # LeadIntake-level dedup doesn't short-circuit, but keep the phone
        # so find_client_by_contact still matches the same Client.
        p2 = build_intake(
            name="Race Test", email=None, phone="2075550303",
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
            f"L3: expected one lead_created activity per booking window, "
            f"got {len(lead_activities)}"
        )
    finally:
        _cleanup(email)
