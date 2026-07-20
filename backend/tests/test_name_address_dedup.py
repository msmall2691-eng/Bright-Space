"""Name + address auto-merge (Requests-page dedup).

A customer who submits the form twice with DIFFERENT contact info (phone the
first time, a typo'd email the second) produces two rows the contact-based
dedup can't link — nothing matches. When the name AND service address are the
same, and the two land inside NAME_ADDR_DEDUP_WINDOW_MINUTES, upsert_lead now
collapses them into one lead, back-fills any missing contact field, and leaves
an audit trail (internal note + a `lead_deduped` Activity) because this is the
one merge whose reason isn't obvious from the row itself.

The complementary rule — a genuine repeat customer at the same address WEEKS
later is a NEW job, not a duplicate — is pinned too: outside the window, a
second row is created rather than merged.
"""
import uuid
from datetime import datetime, timedelta, timezone

from database.db import SessionLocal
from database.models import (
    Activity, Client, LeadIntake, Property, Opportunity, ContactEmail, ContactPhone,
)
from modules.intake.normalize import build_intake, upsert_lead


def _uniq_email():
    return f"nad-{uuid.uuid4().hex[:10]}@example.com"


def _cleanup(*emails):
    db = SessionLocal()
    try:
        for email in emails:
            client_ids = [c.id for c in db.query(Client).filter(Client.email.ilike(email)).all()]
            if client_ids:
                db.query(Activity).filter(Activity.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(Property).filter(Property.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(Opportunity).filter(Opportunity.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(ContactEmail).filter(ContactEmail.client_id.in_(client_ids)).delete(synchronize_session=False)
                db.query(ContactPhone).filter(ContactPhone.client_id.in_(client_ids)).delete(synchronize_session=False)
            db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).delete(synchronize_session=False)
            db.query(Client).filter(Client.email.ilike(email)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_same_name_address_different_contact_merges():
    email_a, email_b = _uniq_email(), _uniq_email()
    try:
        db = SessionLocal()
        first = build_intake(
            name="Dana Rivers", email=email_a, phone="2075550111",
            service_key="residential", address="88 Harbor Rd", city="Portland",
            state="ME", zip_code="04101", square_footage=1500, bathrooms=2,
        )
        r1 = upsert_lead(db, first)

        # Same person, same address, but a completely different email + phone
        # (filled the form again on another device). No contact field links
        # them — only name + address do.
        second = build_intake(
            name="Dana Rivers", email=email_b, phone="2078889999",
            service_key="residential", address="88 Harbor Rd", city="Portland",
            state="ME", zip_code="04101", square_footage=1500, bathrooms=2,
        )
        r2 = upsert_lead(db, second)

        assert r2["deduped"] is True, "second submission should have merged, not created a new lead"
        assert r2["intake_id"] == r1["intake_id"], "both submissions should resolve to one lead row"

        # The alternate contact is preserved on the audit note, not dropped.
        lead = db.query(LeadIntake).filter(LeadIntake.id == r1["intake_id"]).first()
        assert "Auto-merged" in (lead.internal_notes or "")
        assert email_b in (lead.internal_notes or "") or "2078889999" in (lead.internal_notes or "")

        # And a timeline Activity records the system merge.
        acts = db.query(Activity).filter(
            Activity.client_id == lead.client_id,
            Activity.activity_type == "lead_deduped",
        ).all()
        assert len(acts) >= 1
    finally:
        _cleanup(email_a, email_b)


def test_different_address_does_not_merge():
    """The two 'Lillie' leads from production: same-ish name but DIFFERENT
    addresses (and contact) must stay as two separate leads."""
    email_a, email_b = _uniq_email(), _uniq_email()
    try:
        db = SessionLocal()
        r1 = upsert_lead(db, build_intake(
            name="Lillie Schechter", email=email_a, phone="2075550001",
            service_key="residential", address="", city="Portland", state="ME",
        ))
        r2 = upsert_lead(db, build_intake(
            name="Lillie Schechter", email=email_b, phone="2075550002",
            service_key="str", address="3949 Charleston Street", city="Portland", state="ME",
        ))
        assert r2["intake_id"] != r1["intake_id"], "different addresses must not auto-merge"
    finally:
        _cleanup(email_a, email_b)


def test_same_name_address_outside_window_stays_separate():
    email_a, email_b = _uniq_email(), _uniq_email()
    try:
        db = SessionLocal()
        r1 = upsert_lead(db, build_intake(
            name="Sam Coast", email=email_a, phone="2075553001",
            service_key="residential", address="12 Pine St", city="Bath", state="ME", zip_code="04530",
        ))
        # Age the first lead well past the name+address window — a repeat
        # customer weeks later is a NEW job, not a duplicate.
        row = db.query(LeadIntake).filter(LeadIntake.id == r1["intake_id"]).first()
        row.created_at = datetime.now(timezone.utc) - timedelta(days=30)
        db.commit()

        r2 = upsert_lead(db, build_intake(
            name="Sam Coast", email=email_b, phone="2075553002",
            service_key="residential", address="12 Pine St", city="Bath", state="ME", zip_code="04530",
        ))
        assert r2["intake_id"] != r1["intake_id"], "same address weeks later should be a new lead"
    finally:
        _cleanup(email_a, email_b)
