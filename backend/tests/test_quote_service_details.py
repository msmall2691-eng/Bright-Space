"""Service Summary: the structured request behind a quote (home size, cadence,
condition, pets, focus areas, preferred date) is surfaced on every
customer-facing quote surface — the public page dict, the email, and the PDF —
so the customer can confirm the quote matches what they asked for before they
accept or request changes.

The intake's on-site *access* material (entry method, lock/alarm/house codes,
parking notes) and free-text special instructions are deliberately EXCLUDED:
the quote link is a shareable bearer token, so those belong on the internal
Job, never on a page anyone with the link can open.
"""
import uuid

import pytest
from jinja2 import Template

from database.db import SessionLocal
from database.models import Client, Property, LeadIntake, Quote
from modules.quoting.router import build_service_details, _public_quote_dict


@pytest.fixture
def details_ctx():
    """A quote linked to a rich intake + property, plus the sensitive fields we
    must never leak onto the customer surface."""
    db = SessionLocal()
    c = Client(name="Details Cust", email="details@example.com", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    prop = Property(
        client_id=c.id, name="Home", address="12 Elm St, Portland, ME 04101",
        property_type="residential", active=True, org_id=1,
        bedrooms=3, bathrooms=2, square_footage=2000,
    )
    db.add(prop); db.commit(); db.refresh(prop)
    intake = LeadIntake(
        name="Details Cust", email="details@example.com", phone="2075550000",
        address="12 Elm St", city="Portland", state="ME", zip_code="04101",
        service_type="residential", frequency="biweekly",
        bedrooms=3, bathrooms=2, square_footage=2000,
        condition="moderate", pet_hair="some", requested_date="2026-07-01",
        status="quoted", source="website", org_id=1, client_id=c.id,
        custom_fields={
            "focus_areas": ["kitchen", "bathrooms"],
            # The three things that must NOT reach the customer surface:
            "entry_method": "lockbox",
            "special_instructions": "Alarm code 4231",
            "parking_notes": "Behind the blue van",
        },
    )
    db.add(intake); db.commit(); db.refresh(intake)
    q = Quote(
        client_id=c.id, intake_id=intake.id, property_id=prop.id,
        quote_number=f"QT-SD-{uuid.uuid4().hex[:8]}", status="sent",
        service_type="residential", frequency="biweekly",
        address="12 Elm St, Portland, ME 04101", notes="Full home clean.",
        items=[{"name": "Residential Cleaning", "qty": 1, "unit_price": 250}],
        subtotal=250, tax_rate=0, tax=0, discount=0, total=250, org_id=1,
        public_token=uuid.uuid4().hex,
    )
    db.add(q); db.commit(); db.refresh(q)
    yield db, c, prop, intake, q
    db.rollback()
    db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
    db.query(LeadIntake).filter(LeadIntake.id == intake.id).delete(synchronize_session=False)
    db.query(Property).filter(Property.id == prop.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def _as_map(details):
    return {d["label"]: d["value"] for d in details}


def test_build_service_details_composes_the_request(details_ctx):
    db, c, prop, intake, q = details_ctx
    m = _as_map(build_service_details(db, q))
    assert m["Home size"] == "3 bed · 2 bath · 2,000 sq ft"
    assert m["Frequency"] == "Every 2 weeks"           # biweekly -> customer label
    assert m["Condition"] == "Moderate — some buildup"
    assert m["Pets"] == "Some pet hair"
    assert m["Focus areas"] == "Kitchen, Bathrooms"
    assert m["Preferred date"] == "July 01, 2026"


def test_build_service_details_excludes_access_and_instructions(details_ctx):
    """No entry method, lock/alarm code, parking note, or special-instruction
    text may appear anywhere in the customer-facing rows."""
    db, c, prop, intake, q = details_ctx
    blob = " ".join(f"{d['label']} {d['value']}" for d in build_service_details(db, q)).lower()
    for leaked in ("lockbox", "4231", "alarm", "parking", "blue van", "entry", "special"):
        assert leaked not in blob, f"sensitive value '{leaked}' leaked onto the customer quote"


def test_public_quote_dict_includes_service_details(details_ctx):
    db, c, prop, intake, q = details_ctx
    pub = _public_quote_dict(q, db)
    assert isinstance(pub["service_details"], list)
    labels = {d["label"] for d in pub["service_details"]}
    assert {"Home size", "Frequency", "Focus areas"} <= labels
    # The free-text scope note stays its own field; details never overwrite it.
    assert pub["notes"] == "Full home clean."


def test_home_size_falls_back_to_intake_when_no_property(details_ctx):
    """A quote with no property still shows the size from the intake."""
    db, c, prop, intake, q = details_ctx
    q.property_id = None
    db.commit()
    m = _as_map(build_service_details(db, q))
    assert m["Home size"] == "3 bed · 2 bath · 2,000 sq ft"


def test_details_empty_for_a_bare_manual_quote():
    """A hand-built quote with no linked intake, no property, and no cadence
    yields an empty list, so every surface collapses the section cleanly."""
    db = SessionLocal()
    c = Client(name="Bare Cust", email="bare@example.com", status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    q = Quote(client_id=c.id, quote_number=f"QT-BARE-{uuid.uuid4().hex[:8]}", status="draft",
              service_type="residential", total=100, org_id=1,
              items=[{"name": "Clean", "qty": 1, "unit_price": 100}])
    db.add(q); db.commit(); db.refresh(q)
    try:
        assert build_service_details(db, q) == []
        assert _public_quote_dict(q, db)["service_details"] == []
    finally:
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


# --- Rendering: email + PDF both surface the rows -------------------------

def _render_email(service_details):
    """Render the real quote-email template with just the service_details block
    exercised (all other sections default to empty). get_email_template doesn't
    use self, so we avoid constructing the SMTP-credential-gated service."""
    from services.quote_email_service import QuoteEmailService
    tmpl = Template(QuoteEmailService.get_email_template(None), autoescape=True)
    return tmpl.render(
        company_name="Test Co", company_logo_url=None, quote_number="QT-1",
        quote_title=None, greeting_line="Hi there,", intro_message=None,
        items=[], subtotal="0.00", tax="0.00", discount="0.00", tax_rate=None,
        show_tax=False, show_discount=False, total_amount="250.00",
        expires_at=None, address=None, quote_link="https://x/quote/t",
        pdf_attached=False, brand_color="#1f2937", company_email=None,
        company_phone=None, company_phone_href="", terms=None,
        scope=None, service_label="Residential Cleaning",
        service_details=service_details, policies=[], property_photo_url=None,
    )


def test_email_template_renders_and_escapes_service_details():
    html = _render_email([
        {"label": "Home size", "value": "3 bed · 2 bath · 2,000 sq ft"},
        {"label": "Focus areas", "value": "Kitchen, Bathrooms"},
        {"label": "Evil", "value": "<script>alert(1)</script>"},
    ])
    assert "Service Summary" in html
    assert "3 bed · 2 bath · 2,000 sq ft" in html
    assert "Kitchen, Bathrooms" in html
    # autoescape must neutralize injected markup (this account sends the email).
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


def test_email_template_hides_section_when_empty():
    assert "Service Summary" not in _render_email([])


def test_pdf_generates_with_service_details():
    from services.quote_pdf_service import QuotePDFService
    pdf = QuotePDFService(company_name="Test Co").generate_quote_pdf(
        quote_number="QT-1", client_name="Cust", client_email="c@x.com",
        client_phone=None,
        line_items=[{"name": "Residential Cleaning", "quantity": 1, "line_total": 250}],
        subtotal=250, tax_amount=0, discount_amount=0, total_amount=250,
        notes="Full home clean.", service_type="residential",
        service_details=[
            {"label": "Home size", "value": "3 bed · 2 bath · 2,000 sq ft"},
            {"label": "Frequency", "value": "Every 2 weeks"},
        ],
    )
    assert isinstance(pdf, bytes) and pdf[:4] == b"%PDF"
