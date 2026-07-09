"""Converting a website lead (intake) to a quote works and seeds pricing from the
instant-quote estimate. Regression: the endpoint previously imported a
non-existent quote_to_dict and never set quote_number (NOT NULL), so it was fully
broken."""
from types import SimpleNamespace

import pytest

from database.db import SessionLocal
from database.models import LeadIntake, Client, Quote, Property
from modules.intake.router import convert_intake_to_quote
from modules.quoting.router import create_quote
from schemas.quotes import QuoteCreate


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


def test_convert_intake_is_idempotent(intake_ctx):
    """July-2026 audit M3: a stray extra quote (its own hand-typed price,
    already 'Sent') showed up for a request the auditor had already
    converted once. convert_intake_to_quote had no guard against being
    called twice on the same intake — a double-click on "Create Quote", a
    duplicate LeadIntake from the pre-fix M2 dedup bug, or a stale browser
    tab resubmitting would each mint an independent Quote. Calling it twice
    on the same intake must now return the SAME quote both times."""
    db, intake = intake_ctx
    first = convert_intake_to_quote(intake.id, db=db)
    second = convert_intake_to_quote(intake.id, db=db)
    assert second["id"] == first["id"]
    assert second["quote_number"] == first["quote_number"]
    # Only one Quote row exists for this intake — not two.
    count = db.query(Quote).filter(Quote.intake_id == intake.id).count()
    assert count == 1, f"expected 1 quote for this intake, found {count}"


def test_create_quote_stamps_source_intake_as_quoted(intake_ctx):
    """The live "Create Quote" button (Requests.jsx -> Quoting.jsx) never
    calls /convert-to-quote — it goes straight to POST /api/quotes
    (create_quote) with intake_id in the body. That path used to leave
    lead_intakes.status/converted_quote_id untouched, so the Requests list
    could never actually show a request as quoted/converted even after a
    real quote was created for it. create_quote() must stamp the source
    intake exactly like convert_intake_to_quote does."""
    db, intake = intake_ctx
    client = Client(name="Web Lead", email="lead@example.com", status="lead")
    db.add(client); db.commit(); db.refresh(client)
    intake.client_id = client.id
    db.commit()

    user = SimpleNamespace(id=None)
    out = create_quote(
        QuoteCreate(client_id=client.id, intake_id=intake.id, title="T", items=[]),
        db=db, current_user=user,
    )
    db.refresh(intake)
    assert intake.status == "quoted"
    assert intake.converted_quote_id == out["id"]


def test_create_quote_does_not_reassign_an_already_converted_intake(intake_ctx):
    """A second quote created against an intake that's already linked to one
    (however that happened) must not silently repoint converted_quote_id at
    the new quote — the intake's provenance should point at whichever quote
    actually converted it first."""
    db, intake = intake_ctx
    client = Client(name="Web Lead", email="lead@example.com", status="lead")
    db.add(client); db.commit(); db.refresh(client)
    intake.client_id = client.id
    db.commit()

    user = SimpleNamespace(id=None)
    first = create_quote(
        QuoteCreate(client_id=client.id, intake_id=intake.id, title="First", items=[]),
        db=db, current_user=user,
    )
    second = create_quote(
        QuoteCreate(client_id=client.id, intake_id=intake.id, title="Second", items=[]),
        db=db, current_user=user,
    )
    assert second["id"] != first["id"]  # create_quote has no dedup guard itself
    db.refresh(intake)
    assert intake.converted_quote_id == first["id"]


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
