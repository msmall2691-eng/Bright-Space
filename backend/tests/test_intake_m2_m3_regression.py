"""Audit M2 + M3 regression tests.

M2: two /api/booking/submit + /api/intake/webhook calls from one maineclean.co
visit used to race past _find_recent_duplicate and each insert a LeadIntake.
The Requests page collapsed them client-side, but the Billing → Leads tab
showed both. The advisory-lock in upsert_lead + server-side collapse on the
list endpoint make the API canonical.

M3: convert_intake_to_quote had no idempotency check — a double-click or
retry spawned a second QT-YYYY-####. The check on intake.converted_quote_id
returns the existing quote instead.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Activity, Client, LeadIntake, Property, Quote

client = TestClient(app)


def _uniq_email():
    return f"m2m3-{uuid.uuid4().hex[:10]}@example.com"


def _cleanup(email):
    db = SessionLocal()
    try:
        client_ids = [c.id for c in db.query(Client).filter(Client.email.ilike(email)).all()]
        if client_ids:
            db.query(Activity).filter(Activity.client_id.in_(client_ids)).delete(synchronize_session=False)
            db.query(Property).filter(Property.client_id.in_(client_ids)).delete(synchronize_session=False)
        intake_ids = [i.id for i in db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).all()]
        if intake_ids:
            db.query(Quote).filter(Quote.intake_id.in_(intake_ids)).delete(synchronize_session=False)
        db.query(LeadIntake).filter(LeadIntake.email.ilike(email)).delete(synchronize_session=False)
        db.query(Client).filter(Client.email.ilike(email)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


# ── M2 ──────────────────────────────────────────────────────────────────────

def test_get_intake_collapses_email_phone_duplicates_server_side():
    """Even if two raw LeadIntake rows survive the write path (e.g. legacy
    rows created before the advisory-lock landed), GET /api/intake must
    only return ONE per (email, phone). Requests.jsx did this client-side;
    Billing → Leads didn't and audit M2 surfaced the divergence."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        # Insert two raw duplicates directly, bypassing upsert_lead.
        from datetime import datetime, timezone, timedelta
        c = Client(name="Dup Test", email=email, phone="+12075551212", status="lead", source="website")
        db.add(c); db.flush()
        older = LeadIntake(
            name="Dup Test", email=email, phone="+12075551212",
            service_type="residential", client_id=c.id, source="website",
            created_at=datetime.now(timezone.utc) - timedelta(seconds=30),
        )
        newer = LeadIntake(
            name="Dup Test", email=email, phone="+12075551212",
            service_type="residential", client_id=c.id, source="website",
            created_at=datetime.now(timezone.utc),
        )
        db.add_all([older, newer]); db.commit()

        from modules.intake.router import get_intakes
        rows = get_intakes(db=db, org_id=None)
        matches = [r for r in rows if (r.get("email") or "").lower() == email]
        assert len(matches) == 1, (
            f"Audit M2: GET /api/intake must collapse (email, phone) duplicates. "
            f"Got {len(matches)} rows for {email}."
        )
        # The newer one wins (client-side rule mirrored).
        assert matches[0]["id"] == newer.id
    finally:
        _cleanup(email)


def test_get_intake_include_duplicates_bypass_flag():
    """The collapse can be turned off for debugging."""
    email = _uniq_email()
    try:
        db = SessionLocal()
        c = Client(name="Dup Debug", email=email, phone="+12075553030", status="lead", source="website")
        db.add(c); db.flush()
        from datetime import datetime, timezone, timedelta
        one = LeadIntake(
            name="Dup Debug", email=email, phone="+12075553030",
            service_type="residential", client_id=c.id, source="website",
            created_at=datetime.now(timezone.utc) - timedelta(seconds=15),
        )
        two = LeadIntake(
            name="Dup Debug", email=email, phone="+12075553030",
            service_type="residential", client_id=c.id, source="website",
            created_at=datetime.now(timezone.utc),
        )
        db.add_all([one, two]); db.commit()

        from modules.intake.router import get_intakes
        rows = get_intakes(include_duplicates=True, db=db, org_id=None)
        matches = [r for r in rows if (r.get("email") or "").lower() == email]
        assert len(matches) == 2
    finally:
        _cleanup(email)


# ── M3 ──────────────────────────────────────────────────────────────────────

def test_convert_to_quote_is_idempotent():
    """Second POST /api/intake/{id}/convert-to-quote returns the same quote,
    doesn't mint QT-YYYY-#### twice. Audit M3."""
    email = _uniq_email()
    try:
        # Create a lead via the real intake path.
        r1 = client.post("/api/intake/submit", json={
            "name": "Idem Convert", "email": email, "phone": "2075554040",
            "address": "5 Idempotent Way", "service_type": "residential",
            "square_footage": 1800, "bathrooms": 2, "frequency": "biweekly",
        })
        assert r1.status_code == 201, r1.text
        intake_id = r1.json()["intake_id"]

        # First convert — new quote.
        # (Uses direct handler because the endpoint requires auth in the test
        # client; we exercise the idempotency contract at the handler layer.)
        db = SessionLocal()
        from modules.intake.router import convert_intake_to_quote
        q1 = convert_intake_to_quote(intake_id, db=db, org_id=None)
        assert q1["id"]

        # Second convert — SAME quote, not a new one.
        q2 = convert_intake_to_quote(intake_id, db=db, org_id=None)
        assert q2["id"] == q1["id"], (
            f"Audit M3: repeated convert must return the same quote; "
            f"got {q1['id']} then {q2['id']}"
        )

        # And there's exactly one quote linked to this intake in the DB.
        quotes = db.query(Quote).filter(Quote.intake_id == intake_id).all()
        assert len(quotes) == 1
    finally:
        _cleanup(email)
