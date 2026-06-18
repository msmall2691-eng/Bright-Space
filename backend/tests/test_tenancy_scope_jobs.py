"""Multi-tenancy MT-2: jobs + visits are scoped to the caller's workspace.

Same pattern as clients/properties: the master-API-key test caller resolves to
the default org, so a job/visit planted in another org must be invisible to the
list/detail endpoints and 404 on update/delete; legacy NULL-org rows stay visible.
"""
import uuid
from datetime import date, time
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Job, Visit, Property

client = TestClient(app)
OTHER_ORG = 99999


def _seed(db, org_id):
    c = Client(name=f"JobOwner {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    p = Property(client_id=c.id, name="P", address="1 Job St",
                 property_type="residential", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    j = Job(client_id=c.id, property_id=p.id, title="Scoped Job", scheduled_date=date(2026, 8, 1),
            start_time=time(9, 0), end_time=time(12, 0), status="scheduled", org_id=org_id)
    db.add(j); db.commit(); db.refresh(j)
    v = Visit(job_id=j.id, scheduled_date=date(2026, 8, 1), start_time=time(9, 0),
              end_time=time(12, 0), status="scheduled", org_id=org_id)
    db.add(v); db.commit(); db.refresh(v)
    return c, j, v


def test_other_org_job_and_visit_are_invisible():
    db = SessionLocal()
    c, j, v = _seed(db, OTHER_ORG)
    try:
        job_ids = {row["id"] for row in client.get("/api/jobs").json()}
        assert j.id not in job_ids, "cross-tenant job leaked into the list"
        assert client.get(f"/api/jobs/{j.id}").status_code == 404
        assert client.patch(f"/api/jobs/{j.id}", json={"notes": "x"}).status_code == 404
        assert client.delete(f"/api/jobs/{j.id}").status_code == 404

        visits = client.get("/api/visits?scheduled_date_from=2026-07-01&scheduled_date_to=2026-09-01").json()
        vis = visits.get("visits", visits) if isinstance(visits, dict) else visits
        vis_ids = {x["id"] for x in vis} if isinstance(vis, list) else set()
        assert v.id not in vis_ids, "cross-tenant visit leaked into the list"
        assert client.get(f"/api/visits/{v.id}").status_code == 404
        assert client.delete(f"/api/visits/{v.id}").status_code == 404
    finally:
        db.query(Visit).filter(Visit.job_id == j.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_legacy_null_org_job_stays_visible():
    db = SessionLocal()
    c, j, v = _seed(db, None)  # pre-tenancy rows
    try:
        assert client.get(f"/api/jobs/{j.id}").status_code == 200
        assert client.get(f"/api/visits/{v.id}").status_code == 200
    finally:
        db.query(Visit).filter(Visit.job_id == j.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.id == j.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
