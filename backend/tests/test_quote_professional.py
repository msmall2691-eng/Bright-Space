"""Quote professionalism: jobs titled 'Town — Service', and service policies
present on the public quote payload (email/PDF/page share the same source)."""
import uuid
from datetime import date, time
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Quote, Property, Job
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7301, 1, "admin", "active", True
    email = "prof-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_job_title_is_town_and_service():
    from modules.quoting.router import _job_title_for_quote
    db = SessionLocal()
    try:
        c = Client(name=f"TownCo {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="Home", address="100 Congress Street, Portland, ME 04101",
                     city="Portland", property_type="residential", active=True, org_id=1)
        db.add(p); db.commit(); db.refresh(p)
        q = Quote(client_id=c.id, quote_number=f"Q-{uuid.uuid4().hex[:8]}", status="accepted",
                  service_type="residential", total=185,
                  address="100 Congress Street, Portland, ME 04101", org_id=1)
        db.add(q); db.commit(); db.refresh(q)

        assert _job_title_for_quote(db, q, p) == "Portland — Residential Cleaning"

        # No structured city → parse from the address.
        p.city = None; db.commit()
        assert _job_title_for_quote(db, q, p) == "Portland — Residential Cleaning"

        # STR service label.
        q.service_type = "str_turnover"; db.commit()
        assert _job_title_for_quote(db, q, p) == "Portland — Turnover Cleaning"

        # No town anywhere → service only.
        q.address = None; p.address = ""; p.city = None; db.commit()
        assert _job_title_for_quote(db, q, p) == "Turnover Cleaning"
    finally:
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.id == p.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_public_quote_payload_includes_policies():
    """Policies default is served on the public quote dict (drives page + is the
    same source email/PDF use)."""
    db = SessionLocal()
    from modules.scheduling.router import _ensure_job_public_token  # noqa (ensures app import ok)
    try:
        c = Client(name=f"PolCo {uuid.uuid4().hex[:6]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        q = Quote(client_id=c.id, quote_number=f"Q-{uuid.uuid4().hex[:8]}", status="sent",
                  service_type="residential", total=185, org_id=1,
                  public_token=uuid.uuid4().hex, notes="Full home clean.")
        db.add(q); db.commit(); db.refresh(q)
        token = q.public_token
        client = TestClient(app)
        body = client.get(f"/api/quotes/public/{token}").json()
        assert body["notes"] == "Full home clean."
        assert isinstance(body["policies"], str) and body["policies"].strip()
        assert "24 hours" in body["policies"]
    finally:
        db.query(Quote).filter(Quote.id == q.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
