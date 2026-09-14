"""Reassigning a property to a different client (client-cleanup).

The property form has always shown a client picker, but PropertyUpdate had no
client_id field, so a PATCH silently dropped it — a property linked to the
wrong client, or orphaned when its client was merged away, could not be
re-pointed by hand. update_property now applies it, but only to a real client
in the caller's workspace, and never blanks it.
"""
import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Property
from modules.properties.router import create_property, update_property, PropertyCreate, PropertyUpdate


@pytest.fixture
def two_clients():
    db = SessionLocal()
    a = Client(name="Wrong Client", email="wrong@example.com", status="active", org_id=1)
    b = Client(name="Right Client", email="right@example.com", status="active", org_id=1)
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    yield db, a, b
    db.rollback()
    db.query(Property).filter(Property.client_id.in_([a.id, b.id])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_([a.id, b.id])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_reassigns_property_to_another_client(two_clients):
    db, a, b = two_clients
    out = create_property(PropertyCreate(client_id=a.id, name="Mislinked House", address="1 Fix Rd"),
                          db=db, org_id=1)
    assert out["client_id"] == a.id
    moved = update_property(out["id"], PropertyUpdate(client_id=b.id), db=db, org_id=1)
    assert moved["client_id"] == b.id
    # Round-trips from the DB.
    fresh = db.query(Property).filter(Property.id == out["id"]).first()
    assert fresh.client_id == b.id


def test_reassign_to_unknown_client_is_404(two_clients):
    db, a, b = two_clients
    out = create_property(PropertyCreate(client_id=a.id, name="H2", address="2 Fix Rd"), db=db, org_id=1)
    with pytest.raises(HTTPException) as ei:
        update_property(out["id"], PropertyUpdate(client_id=999999), db=db, org_id=1)
    assert ei.value.status_code == 404
    # The property stayed put.
    assert db.query(Property).filter(Property.id == out["id"]).first().client_id == a.id


def test_reassign_to_null_client_is_rejected(two_clients):
    db, a, b = two_clients
    out = create_property(PropertyCreate(client_id=a.id, name="H3", address="3 Fix Rd"), db=db, org_id=1)
    with pytest.raises(HTTPException) as ei:
        update_property(out["id"], PropertyUpdate(client_id=None), db=db, org_id=1)
    # PropertyUpdate(client_id=None) is an explicit null in the payload → 422.
    assert ei.value.status_code == 422


def test_other_fields_still_update_without_touching_client(two_clients):
    db, a, b = two_clients
    out = create_property(PropertyCreate(client_id=a.id, name="H4", address="4 Fix Rd"), db=db, org_id=1)
    moved = update_property(out["id"], PropertyUpdate(access_notes="Side door"), db=db, org_id=1)
    assert moved["access_notes"] == "Side door"
    assert moved["client_id"] == a.id  # untouched
