"""GET /api/intake/{id} — the single-request detail endpoint that powers the
Request detail page. Must return the base intake fields plus a `linked` block
carrying labels for the related client / opportunity / quote so the UI can
render clickable related-record cards.

Also guards the route ordering: /stats must not be captured by /{intake_id}.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, LeadIntake, Quote, Opportunity
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7612, 1, "admin", "active", True
    email = "intake-detail-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_detail_returns_linked_records(api):
    db = SessionLocal()
    made = []
    try:
        c = Client(name=f"Lead {uuid.uuid4().hex[:6]}", status="lead", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        opp = Opportunity(client_id=c.id, title="Biweekly clean", stage="new",
                          amount=185, org_id=1)
        db.add(opp); db.commit(); db.refresh(opp)
        q = Quote(client_id=c.id, quote_number=f"Q-{uuid.uuid4().hex[:6]}",
                  status="sent", service_type="residential", total=185, org_id=1,
                  public_token=uuid.uuid4().hex)
        db.add(q); db.commit(); db.refresh(q)
        intake = LeadIntake(
            name="Jane Lead", email=f"{uuid.uuid4().hex[:6]}@ex.com", status="quoted",
            source="website", org_id=1, client_id=c.id,
            opportunity_id=opp.id, converted_quote_id=q.id,
        )
        db.add(intake); db.commit(); db.refresh(intake)
        made = [intake, q, opp, c]

        r = api.get(f"/api/intake/{intake.id}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"] == intake.id
        assert body["name"] == "Jane Lead"
        assert body["linked"]["client"] == {"id": c.id, "name": c.name, "status": "lead"}
        assert body["linked"]["opportunity"]["id"] == opp.id
        assert body["linked"]["opportunity"]["stage"] == "new"
        assert body["linked"]["quote"]["id"] == q.id
        assert body["linked"]["quote"]["status"] == "sent"
    finally:
        for m in made:
            db.delete(m)
        db.commit(); db.close()


def test_detail_404_for_missing(api):
    r = api.get("/api/intake/99999999")
    assert r.status_code == 404


def test_stats_not_shadowed_by_detail_route(api):
    """/stats is a sibling static path — it must still resolve to the stats
    handler, not be captured as intake_id."""
    r = api.get("/api/intake/stats")
    assert r.status_code == 200, r.text
    assert "total" in r.json()
