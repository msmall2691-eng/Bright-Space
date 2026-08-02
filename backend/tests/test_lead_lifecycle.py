"""Lead lifecycle clarity:
  - promote_client_from_lead flips a "lead" client to "active" (and no-ops
    otherwise), so a booked customer isn't left as both a lead and a customer.
  - GET /api/intake?client_id= returns a client's origin request(s), powering
    the "Came in as" tie-back on the client profile.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, LeadIntake
from modules.auth.router import get_current_user, current_org_id
from utils.activity_logger import promote_client_from_lead


class _Admin:
    id, org_id, role, status, active = 7901, 1, "admin", "active", True
    email = "lifecycle-admin@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    c = TestClient(app)
    yield c
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_promote_flips_lead_to_active():
    db = SessionLocal()
    try:
        c = Client(name=f"Lead {uuid.uuid4().hex[:5]}", status="lead", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        assert promote_client_from_lead(db, c.id, reason="job_booked") is True
        db.commit(); db.refresh(c)
        assert c.status == "active"
        db.delete(c); db.commit()
    finally:
        db.close()


def test_promote_noop_when_not_lead():
    db = SessionLocal()
    try:
        c = Client(name=f"Active {uuid.uuid4().hex[:5]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        assert promote_client_from_lead(db, c.id, reason="job_booked") is False
        db.refresh(c)
        assert c.status == "active"  # unchanged
        db.delete(c); db.commit()
    finally:
        db.close()


def test_intake_list_filters_by_client(api):
    db = SessionLocal()
    made = []
    try:
        c = Client(name=f"Converted {uuid.uuid4().hex[:5]}", status="active", org_id=1)
        db.add(c); db.commit(); db.refresh(c)
        mine = LeadIntake(name="Mine", email=f"{uuid.uuid4().hex[:6]}@ex.com",
                          status="converted", source="website", org_id=1, client_id=c.id)
        other = LeadIntake(name="Other", email=f"{uuid.uuid4().hex[:6]}@ex.com",
                           status="new", source="website", org_id=1, client_id=None)
        db.add_all([mine, other]); db.commit(); db.refresh(mine); db.refresh(other)
        made = [mine, other, c]

        r = api.get(f"/api/intake?client_id={c.id}")
        assert r.status_code == 200, r.text
        ids = [row["id"] for row in r.json()]
        assert mine.id in ids
        assert other.id not in ids   # not linked to this client
    finally:
        for m in made:
            db.delete(m)
        db.commit(); db.close()
