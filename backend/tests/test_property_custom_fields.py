"""Custom-field (metadata) support on Properties — parity with Clients.

Covers the new Property.custom_fields column + API plumbing and the fields
entity_type whitelist that now includes 'property'.
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Property
from modules.properties.router import (
    create_property, update_property, PropertyCreate, PropertyUpdate,
)
from modules.fields.router import create_field, FieldCreate


@pytest.fixture
def client_row():
    db = SessionLocal()
    c = Client(name="CF Property Test", email="cf@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    yield c, db
    db.rollback()
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_property_create_persists_custom_fields(client_row):
    c, db = client_row
    out = create_property(PropertyCreate(
        client_id=c.id, name="Pier House", address="1 Pier Rd",
        property_type="str", custom_fields={"gate_code": "0508", "wifi": "guest123"},
    ), db=db)
    assert out["custom_fields"]["gate_code"] == "0508"
    assert out["custom_fields"]["wifi"] == "guest123"
    # Round-trips from the DB.
    fresh = db.query(Property).filter(Property.id == out["id"]).first()
    assert fresh.custom_fields == {"gate_code": "0508", "wifi": "guest123"}


def test_property_update_sets_custom_fields(client_row):
    c, db = client_row
    out = create_property(PropertyCreate(client_id=c.id, name="P2", address="2 Rd"), db=db)
    assert out["custom_fields"] == {}
    updated = update_property(out["id"], PropertyUpdate(custom_fields={"linens": "in closet"}), db=db)
    assert updated["custom_fields"] == {"linens": "in closet"}


def test_fields_accepts_property_entity_and_rejects_unknown(client_row):
    c, db = client_row
    from database.models import FieldDefinition
    try:
        fld = create_field(FieldCreate(entity_type="property", name="Gate Code"), db=db)
        assert fld["entity_type"] == "property"
        assert fld["key"] == "gate_code"
        with pytest.raises(Exception):
            create_field(FieldCreate(entity_type="nonsense", name="X"), db=db)
    finally:
        db.rollback()
        db.query(FieldDefinition).filter(
            FieldDefinition.entity_type.in_(["property", "nonsense"])
        ).delete(synchronize_session=False)
        db.commit()
