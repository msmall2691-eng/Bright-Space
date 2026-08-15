"""A client added with a street address gets a Property created from it
automatically (owner report: "No properties for this client yet" while the
address sat on the client card, forcing a hand re-type when scheduling).
Form/API path only; no address → no property.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Property
from modules.clients.router import create_client, ClientCreate


class _Owner:
    id = None
    email = "owner@example.com"
    role = "admin"


@pytest.fixture
def made():
    ids = {"clients": []}
    yield ids
    db = SessionLocal()
    db.query(Property).filter(Property.client_id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_client_with_address_gets_a_property(made):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    out = create_client(
        ClientCreate(first_name=f"Auto{tag}", last_name="Prop",
                     address="1 Harvest Lane", city="Portland", state="ME", zip_code="04101"),
        db=db, current_user=_Owner(), org_id=None, force=True,
    )
    made["clients"].append(out["id"])
    props = db.query(Property).filter(Property.client_id == out["id"]).all()
    assert len(props) == 1
    p = props[0]
    assert p.address == "1 Harvest Lane"
    assert p.name == "1 Harvest Lane"      # shows up ready-to-pick in the schedule modal
    assert p.city == "Portland" and p.state == "ME" and p.zip_code == "04101"
    assert p.property_type == "residential"
    db.close()


def test_client_without_address_gets_no_property(made):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    out = create_client(
        ClientCreate(first_name=f"NoAddr{tag}", last_name="Client"),
        db=db, current_user=_Owner(), org_id=None, force=True,
    )
    made["clients"].append(out["id"])
    assert db.query(Property).filter(Property.client_id == out["id"]).count() == 0
    db.close()
