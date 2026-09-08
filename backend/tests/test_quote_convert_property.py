"""BB-QUOTE-01: converting an accepted quote must land the Job on the property
the quote was written against — not on whichever of the client's properties has
the lowest id.

`_resolve_property_for_quote` used to ignore `Quote.property_id` entirely and
`ORDER BY Property.id ASC LIMIT 1`. A client with more than one house
(a duplex owner, a landlord, a rental manager) was quoted for one property and
got a job on a *different* one — wrong address on the schedule, wrong access
details for the crew, and no error to say so. The fix honors `quote.property_id`
when it's set and still points at one of the client's own properties, falling
back to the old by-client lookup otherwise.

Covered here, each mutation-checked against dropping the property_id branch:
  * multi-property client, quote names the second → job lands on the second;
  * no property_id on the quote → still the first property (fallback intact);
  * property_id pointing at another client's property → ignored, falls back to
    THIS client's property (no cross-client placement).
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Property, Quote, Job
from modules.quoting.router import _convert_quote_to_job


def _mk_quote(db, client_id, number, property_id=None):
    q = Quote(
        client_id=client_id, quote_number=number, title="T",
        service_type="residential", address="1 St", notes="", items=[],
        subtotal=100, tax_rate=0, tax=0, discount=0, total=100,
        status="accepted", property_id=property_id,
    )
    db.add(q); db.commit(); db.refresh(q)
    return q


@pytest.fixture
def two_prop_client():
    db = SessionLocal()
    c = Client(name="Two Houses", email="two@example.com", status="active")
    db.add(c); db.commit(); db.refresh(c)
    # first is the lowest-id property — the one the old code always picked.
    first = Property(client_id=c.id, name="Main St", address="1 Main St",
                     property_type="residential", active=True)
    db.add(first); db.commit(); db.refresh(first)
    second = Property(client_id=c.id, name="Oak Ave", address="9 Oak Ave",
                      property_type="residential", active=True)
    db.add(second); db.commit(); db.refresh(second)
    yield db, c, first, second
    db.rollback()
    db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
    db.query(Quote).filter(Quote.client_id == c.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_convert_lands_on_the_property_the_quote_names(two_prop_client):
    db, c, first, second = two_prop_client
    # Quote written against the SECOND (higher-id) property.
    q = _mk_quote(db, c.id, "QT-PROP-1", property_id=second.id)
    job = _convert_quote_to_job(db, q)
    assert job.property_id == second.id, (
        "job landed on the wrong property — the quote named %s but got %s"
        % (second.id, job.property_id)
    )


def test_convert_without_a_named_property_uses_the_first(two_prop_client):
    # Fallback path unchanged: no property_id on the quote → lowest-id property.
    db, c, first, second = two_prop_client
    q = _mk_quote(db, c.id, "QT-PROP-2", property_id=None)
    job = _convert_quote_to_job(db, q)
    assert job.property_id == first.id


def test_a_foreign_property_id_is_ignored_not_placed(two_prop_client):
    # A property_id that belongs to a DIFFERENT client must never be honored —
    # it falls through to this client's own first property.
    db, c, first, second = two_prop_client
    other = Client(name="Someone Else", email="else@example.com", status="active")
    db.add(other); db.commit(); db.refresh(other)
    foreign = Property(client_id=other.id, name="Not Yours", address="99 Elsewhere",
                       property_type="residential", active=True)
    db.add(foreign); db.commit(); db.refresh(foreign)
    try:
        q = _mk_quote(db, c.id, "QT-PROP-3", property_id=foreign.id)
        job = _convert_quote_to_job(db, q)
        assert job.property_id == first.id            # this client's own property
        assert job.property_id != foreign.id          # never the foreign one
    finally:
        db.query(Property).filter(Property.id == foreign.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == other.id).delete(synchronize_session=False)
        db.commit()
