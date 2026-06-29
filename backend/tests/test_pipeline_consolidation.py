"""Pipeline state is single-sourced on Opportunity.stage.

- The CRM summary derives lifecycle_stage from a client's opportunities so the
  field can survive the migration that dropped Client.lifecycle_stage.
- The previously-broken Opportunity.quotes / Quote.opportunity relationships
  bind cleanly now that Quote is Integer-keyed; the SQLAlchemy mapper succeeds
  to initialize and navigation works in both directions.
"""
import pytest

from database.db import SessionLocal
from database.models import Client, Opportunity, Quote


@pytest.fixture
def db_session():
    db = SessionLocal()
    yield db
    db.rollback()
    db.close()


def _seed_client(db, name, email):
    c = Client(name=name, email=email, status="active")
    db.add(c); db.commit(); db.refresh(c)
    return c


def _cleanup(db, client_id):
    db.query(Quote).filter(Quote.client_id == client_id).delete(synchronize_session=False)
    db.query(Opportunity).filter(Opportunity.client_id == client_id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == client_id).delete(synchronize_session=False)
    db.commit()


def test_models_no_longer_expose_client_lifecycle_stage():
    """The column is dropped — read paths use the derived value, not the model."""
    assert "lifecycle_stage" not in Client.__table__.columns


def test_opportunity_quotes_relationship_navigates_both_ways(db_session):
    """Opportunity.quotes ↔ Quote.opportunity bind, which they didn't before
    (the relationship was removed when Quote was UUID-keyed; Quote is Integer
    now, so the back_populates pair is restored)."""
    db = db_session
    c = _seed_client(db, "Rel Test", "rel@example.com")
    try:
        opp = Opportunity(client_id=c.id, title="A deal", stage="new", amount=500.0)
        db.add(opp); db.commit(); db.refresh(opp)
        q = Quote(client_id=c.id, opportunity_id=opp.id, quote_number="QT-REL-1",
                  title="t", service_type="residential", address="x", notes="",
                  items=[], subtotal=0, tax_rate=0, tax=0, discount=0, total=0,
                  status="draft")
        db.add(q); db.commit(); db.refresh(q)

        db.refresh(opp)
        assert [x.id for x in opp.quotes] == [q.id]
        assert q.opportunity is not None
        assert q.opportunity.id == opp.id
    finally:
        _cleanup(db, c.id)


def _crm_summary_lifecycle(db, client_id):
    from modules.clients.router import get_client_crm_summary
    return get_client_crm_summary(client_id, db=db)["lifecycle_stage"]


def test_lifecycle_new_when_no_opportunities(db_session):
    db = db_session
    c = _seed_client(db, "Fresh Lead", "fresh@example.com")
    try:
        assert _crm_summary_lifecycle(db, c.id) == "new"
    finally:
        _cleanup(db, c.id)


def test_lifecycle_opportunity_when_any_opportunity_exists(db_session):
    db = db_session
    c = _seed_client(db, "In Pipeline", "pipe@example.com")
    try:
        db.add(Opportunity(client_id=c.id, title="Deal A", stage="qualified"))
        db.commit()
        assert _crm_summary_lifecycle(db, c.id) == "opportunity"
    finally:
        _cleanup(db, c.id)


def test_lifecycle_customer_once_an_opportunity_is_won(db_session):
    db = db_session
    c = _seed_client(db, "Sold", "sold@example.com")
    try:
        db.add(Opportunity(client_id=c.id, title="Deal Open", stage="quoted"))
        db.add(Opportunity(client_id=c.id, title="Deal Won", stage="won"))
        db.commit()
        # Won wins regardless of other open deals on the same client.
        assert _crm_summary_lifecycle(db, c.id) == "customer"
    finally:
        _cleanup(db, c.id)
