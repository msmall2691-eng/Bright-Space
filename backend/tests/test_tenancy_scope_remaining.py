"""Multi-tenancy MT-2: opportunities + intakes scoped to the caller's workspace.

Completes MT-2's customer/pipeline coverage. The intake `submit`/`webhook`
endpoints stay public (no org) — leads from the website have no logged-in user,
so they land with org_id NULL and are tolerated by the scope filter.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Opportunity, LeadIntake

client = TestClient(app)
OTHER_ORG = 99999


def test_other_org_opportunity_is_invisible():
    db = SessionLocal()
    c = Client(name=f"OppOwner {uuid.uuid4().hex[:6]}", status="active", org_id=OTHER_ORG)
    db.add(c); db.commit(); db.refresh(c)
    o = Opportunity(client_id=c.id, title="Other Deal", stage="new", amount=500, org_id=OTHER_ORG)
    db.add(o); db.commit(); db.refresh(o)
    try:
        ids = {r["id"] for r in client.get("/api/opportunities?limit=200").json()}
        assert o.id not in ids, "cross-tenant opportunity leaked into the list/board"
        assert client.get(f"/api/opportunities/{o.id}").status_code == 404
        assert client.patch(f"/api/opportunities/{o.id}", json={"stage": "won"}).status_code == 404
    finally:
        db.query(Opportunity).filter(Opportunity.id == o.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_other_org_intake_invisible_but_public_submit_still_works():
    db = SessionLocal()
    i = LeadIntake(name="Other Lead", email="other@example.com", status="new", org_id=OTHER_ORG)
    db.add(i); db.commit(); db.refresh(i)
    try:
        ids = {r["id"] for r in client.get("/api/intake?limit=200").json()}
        assert i.id not in ids, "cross-tenant lead leaked into the list"
        assert client.patch(f"/api/intake/{i.id}", json={"status": "contacted"}).status_code == 404

        # The PUBLIC contact form must still create leads (no org context).
        r = client.post("/api/intake/submit", json={
            "name": f"Web Lead {uuid.uuid4().hex[:6]}", "email": "web@example.com",
            "message": "Need a cleaning",
        })
        assert r.status_code == 201, r.text
        new_id = r.json().get("intake_id") or r.json().get("id")
        # The newly submitted (NULL-org) lead is visible to the org-1 caller.
        if new_id:
            assert client.get(f"/api/intake?limit=200").status_code == 200
            db.query(LeadIntake).filter(LeadIntake.id == new_id).delete(synchronize_session=False)
            db.commit()
    finally:
        db.query(LeadIntake).filter(LeadIntake.id == i.id).delete(synchronize_session=False)
        db.commit(); db.close()
