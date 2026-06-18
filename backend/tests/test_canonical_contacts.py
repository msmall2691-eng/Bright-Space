"""Audit #3 Part B2 / Audit #4 Part 1 #2 — contact_emails/contact_phones are the
canonical dedup source.

Before this, find_client_by_contact only checked the singular Client.email /
Client.phone columns, so an address/number stored as an *additional* contact was
invisible to dedup and a returning customer spawned a duplicate client (the live
"3 Megan clients" finding). These tests pin: the multi-value tables are searched,
and the intake path populates them.
"""
import uuid
import pytest

from database.db import SessionLocal
from database.models import Client, ContactEmail, ContactPhone, LeadIntake, Activity
from utils.contacts import find_client_by_contact, add_contact_email, add_contact_phone
from modules.intake.normalize import build_intake, upsert_lead


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


def _cleanup(db, client_id):
    db.query(Activity).filter(Activity.client_id == client_id).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.client_id == client_id).delete(synchronize_session=False)
    db.query(ContactEmail).filter(ContactEmail.client_id == client_id).delete(synchronize_session=False)
    db.query(ContactPhone).filter(ContactPhone.client_id == client_id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
    db.commit()


def test_find_matches_additional_email_not_just_primary(db):
    primary = f"primary-{uuid.uuid4().hex[:8]}@example.com"
    alt = f"alt-{uuid.uuid4().hex[:8]}@example.com"
    c = Client(name="Multi Email", email=primary, status="lead")
    db.add(c); db.commit(); db.refresh(c)
    try:
        add_contact_email(db, c, alt, source="manual"); db.commit()
        # Lookup by the ADDITIONAL email resolves to the same client (no dupe).
        found = find_client_by_contact(db, email=alt)
        assert found is not None and found.id == c.id
    finally:
        _cleanup(db, c.id)


def test_find_matches_additional_phone_via_tail(db):
    c = Client(name="Multi Phone", phone="+12075551111", status="lead")
    db.add(c); db.commit(); db.refresh(c)
    try:
        add_contact_phone(db, c, "(207) 555-2222", source="manual"); db.commit()
        # Fuzzy last-10 match against the additional phone.
        found = find_client_by_contact(db, phone="207-555-2222")
        assert found is not None and found.id == c.id
    finally:
        _cleanup(db, c.id)


def test_add_contact_helpers_are_idempotent_and_first_is_primary(db):
    c = Client(name="Idem", status="lead")
    db.add(c); db.commit(); db.refresh(c)
    try:
        e1 = add_contact_email(db, c, "X@Example.com", source="website"); db.commit()
        e2 = add_contact_email(db, c, "x@example.com"); db.commit()  # same, case-insensitive
        assert e1.id == e2.id                      # no duplicate row
        assert e1.is_primary is True               # first email is primary
        rows = db.query(ContactEmail).filter(ContactEmail.client_id == c.id).count()
        assert rows == 1
    finally:
        _cleanup(db, c.id)


def test_intake_populates_canonical_contacts_and_dedupes_returning_customer(db):
    email = f"return-{uuid.uuid4().hex[:8]}@example.com"
    # First visit creates the client + canonical contact rows.
    r1 = upsert_lead(db, build_intake(name="Return Cust", email=email, phone="2075553333",
                                      service_key="residential"))
    cid = r1["client_id"]
    try:
        assert db.query(ContactEmail).filter(ContactEmail.client_id == cid,
                                             ContactEmail.email.ilike(email)).first()
        assert db.query(ContactPhone).filter(ContactPhone.client_id == cid).first()
        # A later, separate lead (outside the dedup window) by the same email must
        # land on the SAME client — not a new one.
        found = find_client_by_contact(db, email=email)
        assert found.id == cid
    finally:
        _cleanup(db, cid)
