"""Home's one-tap "Draft quote" on a new-lead card
(POST /api/ai/quote-from-lead/{intake_id}).

The whole point is a DRAFT the owner reviews and sends herself — so these lock
down that nothing is ever sent from this path, that a second tap doesn't mint a
second quote, that another workspace's lead is invisible, and that the AI intro
is a nicety with a deterministic fallback (CI has no ANTHROPIC_API_KEY, so the
happy path here IS the fallback path).
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (Client, ContactEmail, ContactPhone, LeadIntake,
                             Opportunity, Property, Quote)
from modules.auth.router import get_current_user, current_org_id

OTHER_ORG = 99771


class _Admin:
    id, org_id, role, status, active = 7711, 1, "admin", "active", True
    email = "qfl-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _make_lead(db, *, org_id=1, **over):
    tag = uuid.uuid4().hex[:8]
    fields = dict(
        name="Dana Quotable", email=f"dana-{tag}@example.com",
        phone=f"207555{tag[:4]}", address="24 Pine Street", city="Portland",
        state="ME", zip_code="04101", service_type="residential",
        requested_service="standard", frequency="biweekly",
        bedrooms=3, bathrooms=2, square_footage=1800,
        estimate_min=200, estimate_max=300,
        message="Looking for biweekly cleaning of my 3 bedroom home.",
        source="website", status="new", org_id=org_id,
    )
    fields.update(over)
    lead = LeadIntake(**fields)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _cleanup(intake_id, email):
    db = SessionLocal()
    try:
        cids = [c.id for c in db.query(Client).filter(Client.email == email).all()]
        db.query(LeadIntake).filter(LeadIntake.id == intake_id).delete(synchronize_session=False)
        if cids:
            db.query(Quote).filter(Quote.client_id.in_(cids)).delete(synchronize_session=False)
            db.query(Opportunity).filter(Opportunity.client_id.in_(cids)).delete(synchronize_session=False)
            db.query(Property).filter(Property.client_id.in_(cids)).delete(synchronize_session=False)
            db.query(ContactEmail).filter(ContactEmail.client_id.in_(cids)).delete(synchronize_session=False)
            db.query(ContactPhone).filter(ContactPhone.client_id.in_(cids)).delete(synchronize_session=False)
            db.query(Client).filter(Client.id.in_(cids)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def test_draft_quote_from_lead_creates_a_reviewable_draft(api):
    db = SessionLocal()
    lead = _make_lead(db)
    iid, email = lead.id, lead.email
    db.close()
    try:
        r = api.post(f"/api/ai/quote-from-lead/{iid}", json={})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] is True
        # Where the owner lands to review it.
        assert body["href"] == f"/quotes/{body['id']}"
        assert body["status"] == "draft"
        assert body["quote_number"] and not body["quote_number"].startswith("PENDING-")

        db = SessionLocal()
        q = db.query(Quote).filter(Quote.id == body["id"]).first()
        # DRAFT ONLY — nothing was sent to the customer from this path.
        assert q.status == "draft"
        assert q.sent_at is None
        assert q.public_token is None
        # Priced from the website's own estimate (200..300 -> $5-rounded 250),
        # with no tax baked in, so the seed matches what the customer was shown.
        assert q.items[0]["unit_price"] == 250
        assert q.subtotal == 250 and q.tax == 0 and q.total == 250
        assert "1,800 sqft" in q.items[0]["description"]
        assert q.title.startswith("Biweekly Residential Cleaning")
        assert q.frequency == "biweekly"
        # A customer-facing intro is always present (AI or fallback), and the
        # lead's own words stay INTERNAL (they leaked onto a public quote once).
        assert q.customer_message and "Dana" in q.customer_message
        # `notes` is the customer-facing scope from Settings -> Service Scopes,
        # NOT the lead's message.
        from modules.settings.router import service_scopes_list
        db2 = SessionLocal()
        scope = next(s["scope"] for s in service_scopes_list(db2) if s["key"] == "residential")
        db2.close()
        assert q.notes == scope
        assert q.internal_notes == "Looking for biweekly cleaning of my 3 bedroom home."
        assert q.customer_message and "3 bedroom home" not in q.customer_message

        # Went through the canonical create path: intake stamped, client and
        # property resolved, pipeline Opportunity created.
        lead = db.query(LeadIntake).filter(LeadIntake.id == iid).first()
        assert lead.status == "quoted"
        assert lead.converted_quote_id == q.id
        assert lead.client_id == q.client_id
        assert q.property_id
        assert q.opportunity_id
        assert q.org_id == 1
        db.close()
    finally:
        _cleanup(iid, email)


def test_second_tap_returns_the_same_draft(api):
    """She may well tap twice — that must not mint a second quote."""
    db = SessionLocal()
    lead = _make_lead(db)
    iid, email = lead.id, lead.email
    db.close()
    try:
        first = api.post(f"/api/ai/quote-from-lead/{iid}", json={}).json()
        second = api.post(f"/api/ai/quote-from-lead/{iid}", json={})
        assert second.status_code == 200, second.text
        second = second.json()
        assert second["id"] == first["id"]
        assert second["href"] == first["href"]
        assert second["created"] is False
        db = SessionLocal()
        assert db.query(Quote).filter(Quote.intake_id == iid).count() == 1
        db.close()
    finally:
        _cleanup(iid, email)


def test_reuses_an_existing_client_instead_of_duplicating(api):
    """Same client resolution as the live Requests -> Quote flow: an existing
    customer matched on email is reused, not duplicated."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    email = f"returning-{tag}@example.com"
    existing = Client(name="Returning Customer", email=email, status="active", org_id=1)
    db.add(existing); db.commit(); db.refresh(existing)
    existing_id = existing.id
    lead = _make_lead(db, email=email, name="Returning Customer")
    iid = lead.id
    db.close()
    try:
        body = api.post(f"/api/ai/quote-from-lead/{iid}", json={}).json()
        db = SessionLocal()
        q = db.query(Quote).filter(Quote.id == body["id"]).first()
        assert q.client_id == existing_id
        assert db.query(Client).filter(Client.email == email).count() == 1
        db.close()
    finally:
        _cleanup(iid, email)


def test_another_orgs_lead_is_not_found(api):
    db = SessionLocal()
    lead = _make_lead(db, org_id=OTHER_ORG)
    iid, email = lead.id, lead.email
    db.close()
    try:
        r = api.post(f"/api/ai/quote-from-lead/{iid}", json={})
        assert r.status_code == 404
        db = SessionLocal()
        # Nothing was written for the foreign lead.
        assert db.query(Quote).filter(Quote.intake_id == iid).count() == 0
        assert db.query(LeadIntake).filter(LeadIntake.id == iid).first().status == "new"
        db.close()
    finally:
        _cleanup(iid, email)


def test_unknown_lead_is_not_found(api):
    assert api.post("/api/ai/quote-from-lead/999999", json={}).status_code == 404


def test_intro_falls_back_when_the_model_is_unavailable():
    """No API key, or a model call that blows up, still yields a complete,
    personalized intro — the AI never gates the real feature."""
    from modules.ai.router import _draft_quote_intro

    db = SessionLocal()
    lead = _make_lead(db)
    iid, email = lead.id, lead.email
    db.close()
    try:
        db = SessionLocal()
        lead = db.query(LeadIntake).filter(LeadIntake.id == iid).first()

        # No key at all.
        msg, used_ai = _draft_quote_intro(lead, "Maine Cleaning Co.", None)
        assert used_ai is False
        assert msg.startswith("Hi Dana,")
        assert "Maine Cleaning Co." in msg
        assert "Portland" in msg and "biweekly" in msg

        # A key that fails mid-call.
        class _Boom:
            def __getattr__(self, _):
                raise RuntimeError("model exploded")

        msg2, used_ai2 = _draft_quote_intro(lead, "Maine Cleaning Co.", _Boom())
        assert used_ai2 is False
        assert msg2 == msg
        db.close()
    finally:
        _cleanup(iid, email)


def test_lead_with_no_estimate_or_size_seeds_a_blank_price(api):
    """Better an obviously-blank price she fills in than a fabricated one."""
    db = SessionLocal()
    lead = _make_lead(db, estimate_min=None, estimate_max=None,
                      bedrooms=None, bathrooms=None, square_footage=None)
    iid, email = lead.id, lead.email
    db.close()
    try:
        body = api.post(f"/api/ai/quote-from-lead/{iid}", json={}).json()
        db = SessionLocal()
        q = db.query(Quote).filter(Quote.id == body["id"]).first()
        assert q.items[0]["unit_price"] == 0
        assert q.total == 0
        assert q.status == "draft"
        # Still a usable draft: name, scope and intro are all there.
        assert q.items[0]["name"] == "Biweekly Residential Cleaning"
        assert q.notes and q.customer_message
        db.close()
    finally:
        _cleanup(iid, email)
