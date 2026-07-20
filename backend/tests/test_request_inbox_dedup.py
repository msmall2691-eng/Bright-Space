"""Twenty-style inbox model + client/property dedup.

Pins the behavior change that makes requests an inbox rather than an
auto-creator:
  * a new request is JUST a LeadIntake — no Client/Property/Opportunity;
  * convert-to-client resolves-or-reuses a client (dedup) and attaches the
    property, so a returning customer never spawns a duplicate;
  * create_property is idempotent per client on the normalized address; and
  * merge_duplicate_properties groups duplicates per client by normalized
    address (the offline cleanup for existing data).
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import (
    Client, Property, LeadIntake, Opportunity, ContactEmail, ContactPhone,
)
from modules.intake.router import convert_intake_to_client
from modules.properties.router import create_property, PropertyCreate


def _uniq():
    return uuid.uuid4().hex[:10]


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


def _cleanup(db, *client_ids, intake_ids=()):
    for iid in intake_ids:
        db.query(LeadIntake).filter(LeadIntake.id == iid).delete(synchronize_session=False)
    if client_ids:
        db.query(LeadIntake).filter(LeadIntake.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(Opportunity).filter(Opportunity.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(ContactEmail).filter(ContactEmail.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(ContactPhone).filter(ContactPhone.client_id.in_(client_ids)).delete(synchronize_session=False)
        db.query(Client).filter(Client.id.in_(client_ids)).delete(synchronize_session=False)
    db.commit()


def test_convert_to_client_creates_then_reuses(db):
    """First conversion creates the client + property; a second request from the
    same person (matched on phone) reuses that client and adds a new property."""
    email = f"conv-{_uniq()}@example.com"
    i1 = LeadIntake(
        name="Conv Cust", email=email, phone="+12075557000",
        address="1 Elm St", city="Portland", state="ME", zip_code="04101",
        service_type="residential", status="new", source="website",
    )
    db.add(i1); db.commit(); db.refresh(i1)
    out1 = convert_intake_to_client(i1.id, db=db, org_id=1)
    cid = out1["client_id"]
    i2_id = None
    try:
        assert out1["created_client"] is True
        assert out1["property_id"] is not None
        assert db.query(LeadIntake).filter(LeadIntake.id == i1.id).one().status == "reviewed"

        i2 = LeadIntake(
            name="Conv Cust", email=f"alt-{_uniq()}@example.com", phone="+12075557000",
            address="2 Oak Ave", city="Portland", state="ME", zip_code="04101",
            service_type="residential", status="new", source="website",
        )
        db.add(i2); db.commit(); db.refresh(i2)
        i2_id = i2.id
        out2 = convert_intake_to_client(i2.id, db=db, org_id=1)
        assert out2["client_id"] == cid
        assert out2["created_client"] is False and out2["matched_existing"] is True

        addrs = {p.address for p in db.query(Property).filter(Property.client_id == cid).all()}
        assert addrs == {"1 Elm St", "2 Oak Ave"}
        # Exactly one client for this person.
        assert db.query(Client).filter(Client.phone == "+12075557000").count() == 1
    finally:
        _cleanup(db, cid, intake_ids=[i1.id] + ([i2_id] if i2_id else []))


def test_convert_to_client_is_idempotent(db):
    """Converting the same request twice returns the same client and never
    duplicates the client or its property."""
    email = f"idem-{_uniq()}@example.com"
    i = LeadIntake(
        name="Idem", email=email, phone="+12075557111",
        address="5 Idem Rd", state="ME", service_type="residential",
        status="new", source="website",
    )
    db.add(i); db.commit(); db.refresh(i)
    out1 = convert_intake_to_client(i.id, db=db, org_id=1)
    out2 = convert_intake_to_client(i.id, db=db, org_id=1)
    cid = out1["client_id"]
    try:
        assert out2["client_id"] == cid
        assert db.query(Client).filter(Client.email.ilike(email)).count() == 1
        assert db.query(Property).filter(Property.client_id == cid).count() == 1
    finally:
        _cleanup(db, cid, intake_ids=[i.id])


def test_create_property_dedups_on_normalized_address(db):
    """POSTing the same address (whitespace/case variants) for one client
    returns the existing property instead of creating a duplicate."""
    c = Client(name="Prop Dedup", status="lead", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    try:
        p1 = create_property(
            PropertyCreate(client_id=c.id, name="Home", address="10 Main St",
                           city="Bath", state="ME", zip_code="04530"),
            db=db, org_id=1,
        )
        p2 = create_property(
            PropertyCreate(client_id=c.id, name="Home again", address=" 10 main st ",
                           city="Bath", state="ME", zip_code="04530"),
            db=db, org_id=1,
        )
        assert p1["id"] == p2["id"], "same normalized address must reuse the property"
        assert db.query(Property).filter(Property.client_id == c.id).count() == 1
        # A genuinely different address DOES create a second property.
        p3 = create_property(
            PropertyCreate(client_id=c.id, name="Other", address="99 Other Rd",
                           city="Bath", state="ME", zip_code="04530"),
            db=db, org_id=1,
        )
        assert p3["id"] != p1["id"]
        assert db.query(Property).filter(Property.client_id == c.id).count() == 2
    finally:
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit()


def test_merge_duplicate_properties_groups_per_client():
    """The offline cleanup groups only same-client, same-normalized-address
    rows — different clients or different cities stay separate."""
    from types import SimpleNamespace
    from scripts.merge_duplicate_properties import find_duplicate_groups

    props = [
        SimpleNamespace(id=1, client_id=10, address="1 Main St", city="Bath", state="ME", zip_code="04530"),
        SimpleNamespace(id=2, client_id=10, address="1 main st ", city="bath", state="ME", zip_code="04530"),
        SimpleNamespace(id=3, client_id=10, address="1 Main St", city="Portland", state="ME", zip_code="04101"),
        SimpleNamespace(id=4, client_id=99, address="1 Main St", city="Bath", state="ME", zip_code="04530"),
        SimpleNamespace(id=5, client_id=10, address="", city="", state="", zip_code=""),
        SimpleNamespace(id=6, client_id=10, address="  ", city="", state="", zip_code=""),
    ]
    groups = find_duplicate_groups(props)
    # Only #1 and #2 (same client, same normalized address) group. #3 is a
    # different city, #4 a different client, and the blank-address rows (#5/#6)
    # never group because a property with no address can't be safely matched.
    assert len(groups) == 1
    assert {p.id for p in groups[0]} == {1, 2}
