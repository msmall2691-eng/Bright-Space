"""GET /api/quotes?property_id=X — closes a linearity dead-end found in the
Clients/Properties connectivity audit: PropertyDetail showed jobs and
recurring series for a property but never quotes, even though Quote carries
property_id directly. A quote not yet converted to a job had no path back
from the property page at all.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Property, Quote
from modules.quoting.router import list_quotes


@pytest.fixture
def rig():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    c = Client(name=f"Quote Filter {tag}", status="active")
    db.add(c); db.commit(); db.refresh(c)
    p1 = Property(client_id=c.id, name="Prop A", address="1 A St")
    p2 = Property(client_id=c.id, name="Prop B", address="2 B St")
    db.add_all([p1, p2]); db.commit(); db.refresh(p1); db.refresh(p2)

    q1 = Quote(client_id=c.id, property_id=p1.id, quote_number=f"QT-{tag}-1", status="draft")
    q2 = Quote(client_id=c.id, property_id=p2.id, quote_number=f"QT-{tag}-2", status="draft")
    q3 = Quote(client_id=c.id, property_id=None, quote_number=f"QT-{tag}-3", status="draft")
    db.add_all([q1, q2, q3]); db.commit()

    yield db, c, p1, p2

    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_list_quotes_filters_by_property_id(rig):
    db, c, p1, p2 = rig
    out = list_quotes(db=db, client_id=None, property_id=p1.id, status=None,
                       limit=100, offset=0, org_id=None)
    ids = {q["id"] for q in out}
    assert all(q["property_id"] == p1.id for q in out)
    assert len(ids) == 1


def test_list_quotes_property_filter_excludes_other_properties_and_none(rig):
    db, c, p1, p2 = rig
    out = list_quotes(db=db, client_id=None, property_id=p2.id, status=None,
                       limit=100, offset=0, org_id=None)
    assert len(out) == 1
    assert out[0]["property_id"] == p2.id


def test_list_quotes_unfiltered_still_returns_all_client_quotes(rig):
    db, c, p1, p2 = rig
    out = list_quotes(db=db, client_id=c.id, property_id=None, status=None,
                       limit=100, offset=0, org_id=None)
    assert len(out) == 3
