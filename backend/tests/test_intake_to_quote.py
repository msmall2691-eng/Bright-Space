"""Converting a website lead (intake) to a quote works and seeds pricing from the
instant-quote estimate. Regression: the endpoint previously imported a
non-existent quote_to_dict and never set quote_number (NOT NULL), so it was fully
broken."""
import pytest

from database.db import SessionLocal
from database.models import LeadIntake, Client, Quote
from modules.intake.router import convert_intake_to_quote


@pytest.fixture
def intake_ctx():
    db = SessionLocal()
    intake = LeadIntake(
        name="Web Lead", email="lead@example.com", phone="2075550000",
        address="9 Web St", city="Portland", state="ME", zip_code="04101",
        service_type="residential", message="Biweekly please",
        estimate_min=200, estimate_max=300, status="new", source="website",
    )
    db.add(intake); db.commit(); db.refresh(intake)
    yield db, intake
    db.rollback()
    # clean up any created client/quote + the intake
    q = db.query(Quote).filter(Quote.intake_id == intake.id).first()
    if q:
        db.query(Quote).filter(Quote.intake_id == intake.id).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id == intake.id).delete(synchronize_session=False)
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
