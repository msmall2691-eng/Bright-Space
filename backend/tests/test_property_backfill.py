"""The "which property" decision for the backfill of property-less jobs/series.

Auto-fix only where unambiguous: one property → attach it; none + address →
create from it; multiple, or none + no address → leave for review (None).
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Property
from services.property_backfill import resolve_backfill_property_id


@pytest.fixture
def db():
    s = SessionLocal()
    made = {"clients": [], "properties": []}
    s._made = made
    yield s
    s.query(Property).filter(Property.client_id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    s.query(Client).filter(Client.id.in_(made["clients"] or [0])).delete(synchronize_session=False)
    s.commit(); s.close()


def _client(db, **over):
    f = dict(name=f"BF {uuid.uuid4().hex[:6]}", status="active", org_id=1)
    f.update(over)
    c = Client(**f); db.add(c); db.commit(); db.refresh(c)
    db._made["clients"].append(c.id)
    return c


def _prop(db, cid, **over):
    f = dict(client_id=cid, name="House", address="1 A St", property_type="residential", org_id=1)
    f.update(over)
    p = Property(**f); db.add(p); db.commit(); db.refresh(p)
    return p.id


def test_single_property_is_attached(db):
    c = _client(db)
    pid = _prop(db, c.id)
    assert resolve_backfill_property_id(db, c.id, 1) == pid


def test_multiple_properties_left_for_review(db):
    c = _client(db)
    _prop(db, c.id, name="A"); _prop(db, c.id, name="B")
    assert resolve_backfill_property_id(db, c.id, 1) is None


def test_no_property_with_address_creates_one(db):
    c = _client(db, address="77 Backfill Blvd")
    pid = resolve_backfill_property_id(db, c.id, 1)
    assert pid is not None
    prop = db.query(Property).filter(Property.id == pid).first()
    assert prop.client_id == c.id and prop.address == "77 Backfill Blvd"


def test_no_property_no_address_left_for_review(db):
    c = _client(db)   # no address
    assert resolve_backfill_property_id(db, c.id, 1) is None


def test_second_orphan_reuses_the_created_property(db):
    """Within one backfill run, a client's first orphan creates the property and
    the second reuses it — no duplicate property."""
    c = _client(db, address="9 Reuse Rd")
    pid1 = resolve_backfill_property_id(db, c.id, 1)
    db.flush()
    pid2 = resolve_backfill_property_id(db, c.id, 1)
    assert pid1 == pid2
    assert db.query(Property).filter(Property.client_id == c.id).count() == 1
