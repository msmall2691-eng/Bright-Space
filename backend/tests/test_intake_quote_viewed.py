"""Regression: GET /api/intake must surface the linked quote's viewed state
AND must not 500 when a request has an associated quote.

The batch quote-load in get_intakes references the Quote model; if Quote isn't
imported at module scope it raises NameError -> 500 for any workspace with a
quoted request (a test where no intake has converted_quote_id would miss it,
because the query only runs when quote_ids is non-empty — this test forces it).
"""
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, LeadIntake, Quote
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7611, 1, "admin", "active", True
    email = "intake-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_intake_list_surfaces_quote_viewed_without_500(api):
    db = SessionLocal()
    made = []
    try:
        c = Client(name=f"QViewed {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        q = Quote(
            client_id=c.id, quote_number=f"Q-{uuid.uuid4().hex[:8]}", status="viewed",
            service_type="residential", total=200, org_id=1,
            public_token=uuid.uuid4().hex,
            viewed_at=datetime(2026, 7, 18, 14, 5, tzinfo=timezone.utc),
        )
        db.add(q); db.commit(); db.refresh(q)
        intake = LeadIntake(
            name="Quoted Lead", email=f"{uuid.uuid4().hex[:6]}@ex.com", status="quoted",
            source="website", org_id=1, client_id=c.id, converted_quote_id=q.id,
        )
        db.add(intake); db.commit(); db.refresh(intake)
        made = [intake, q, c]

        r = api.get("/api/intake")
        assert r.status_code == 200, r.text  # would be 500 on the NameError
        rows = r.json()
        row = next((x for x in rows if x["id"] == intake.id), None)
        assert row is not None
        assert row["quote_status"] == "viewed"
        assert row["quote_viewed_at"] is not None
    finally:
        for m in made:
            db.delete(m)
        db.commit(); db.close()


def test_intake_list_ok_when_quote_not_viewed(api):
    """A quoted-but-unopened request returns 200 with quote_viewed_at = None."""
    db = SessionLocal()
    made = []
    try:
        c = Client(name=f"QUnseen {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        q = Quote(
            client_id=c.id, quote_number=f"Q-{uuid.uuid4().hex[:8]}", status="sent",
            service_type="residential", total=200, org_id=1, public_token=uuid.uuid4().hex,
        )
        db.add(q); db.commit(); db.refresh(q)
        intake = LeadIntake(
            name="Unopened Lead", email=f"{uuid.uuid4().hex[:6]}@ex.com", status="quoted",
            source="website", org_id=1, client_id=c.id, converted_quote_id=q.id,
        )
        db.add(intake); db.commit(); db.refresh(intake)
        made = [intake, q, c]

        r = api.get("/api/intake")
        assert r.status_code == 200, r.text
        row = next((x for x in r.json() if x["id"] == intake.id), None)
        assert row is not None
        assert row["quote_status"] == "sent"
        assert row["quote_viewed_at"] is None
    finally:
        for m in made:
            db.delete(m)
        db.commit(); db.close()
