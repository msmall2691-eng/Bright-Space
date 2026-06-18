"""Converting a website lead (intake) to a quote works and seeds pricing from the
instant-quote estimate. Regression: the endpoint previously imported a
non-existent quote_to_dict and never set quote_number (NOT NULL), so it was fully
broken."""
import pytest

from database.db import SessionLocal
from database.models import LeadIntake, Client, Quote, Property
from modules.intake.router import convert_intake_to_quote


@pytest.fixture
def intake_ctx():
    db = SessionLocal()
    intake = LeadIntake(
        name="Web Lead", email="lead@example.com", phone="2075550000",
        address="9 Web St", city="Portland", state="ME", zip_code="04101",
        service_type="residential", message="Biweekly please",
        bedrooms=3, bathrooms=2, square_footage=2000,
        estimate_min=200, estimate_max=300, status="new", source="website",
    )
    db.add(intake); db.commit(); db.refresh(intake)
    yield db, intake
    db.rollback()
    # clean up any created client/quote/property + the intake
    db.query(Quote).filter(Quote.intake_id == intake.id).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id == intake.id).delete(synchronize_session=False)
    cids = [c.id for c in db.query(Client).filter(Client.email == "lead@example.com").all()]
    if cids:
        db.query(Property).filter(Property.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.email == "lead@example.com").delete(synchronize_session=False)
    db.commit(); db.close()


def test_convert_intake_seeds_quote_from_estimate(intake_ctx):
    db, intake = intake_ctx
    out = convert_intake_to_quote(intake.id, db=db)
    # A real quote number was assigned (not the PENDING placeholder, not null).
    assert out["quote_number"] and not out["quote_number"].startswith("PENDING-")
    assert out["status"] == "draft"
    # First line item priced at the estimate midpoint (200..300 -> 250).
    assert out["items"][0]["unit_price"] == 250
    assert out["subtotal"] == 250
    assert out["total"] > 250  # tax applied
    # Lead's address + service carried over; intake marked quoted.
    assert "9 Web St" in (out["address"] or "")
    db.refresh(intake)
    assert intake.status == "quoted"
    # The quote is linked to a Property that carries the structured request, so
    # the operator (and later the job) start from real data, not a re-type.
    assert out["property_id"]
    prop = db.query(Property).filter(Property.id == out["property_id"]).first()
    assert prop and prop.client_id == out["client_id"]
    assert prop.bedrooms == 3 and prop.bathrooms == 2 and prop.square_footage == 2000


def test_core_models_have_audit_fields():
    """Twenty-style ActorMetadata is present on the core mutable tables so
    'who changed this, and when' is answerable (and can't silently regress)."""
    for model in (Client, Property, LeadIntake):
        cols = set(model.__table__.columns.keys())
        assert {"created_by", "updated_by", "updated_at"} <= cols, (model.__name__, cols)
    from database.models import Invoice
    inv = set(Invoice.__table__.columns.keys())
    assert {"created_by", "updated_by", "updated_at"} <= inv
    # Property gained structured size columns for convert-to-quote propagation.
    assert {"bedrooms", "bathrooms", "square_footage"} <= set(Property.__table__.columns.keys())
