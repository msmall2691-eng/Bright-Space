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
    ), db=db, org_id=1)
    assert out["custom_fields"]["gate_code"] == "0508"
    assert out["custom_fields"]["wifi"] == "guest123"
    # Round-trips from the DB.
    fresh = db.query(Property).filter(Property.id == out["id"]).first()
    assert fresh.custom_fields == {"gate_code": "0508", "wifi": "guest123"}


def test_property_update_sets_custom_fields(client_row):
    c, db = client_row
    out = create_property(PropertyCreate(client_id=c.id, name="P2", address="2 Rd"), db=db, org_id=1)
    assert out["custom_fields"] == {}
    updated = update_property(out["id"], PropertyUpdate(custom_fields={"linens": "in closet"}), db=db, org_id=1)
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


def test_property_type_normalized_and_validated(client_row):
    """Regression: creating a property from the Schedule Job modal with a
    turnover job passed the JOB type ('str_turnover') straight through and
    died on ck_properties_property_type as an HTTP 500. The synonym now
    normalizes to 'str'; genuinely unknown values are a clear 422."""
    from fastapi import HTTPException

    c, db = client_row
    out = create_property(PropertyCreate(
        client_id=c.id, name="Limerick Rental", address="163 Leisure Ln",
        property_type="str_turnover",
    ), db=db, org_id=1)
    assert out["property_type"] == "str"

    with pytest.raises(HTTPException) as ei:
        create_property(PropertyCreate(
            client_id=c.id, name="Bad Type House", address="9 Nope Rd",
            property_type="castle",
        ), db=db, org_id=1)
    assert ei.value.status_code == 422
