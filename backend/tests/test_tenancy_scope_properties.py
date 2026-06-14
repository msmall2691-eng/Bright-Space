"""Multi-tenancy MT-2: properties are scoped to the caller's workspace.

Same pattern as clients (#291): the master-API-key test caller resolves to the
default org, so a property planted in another org must be invisible to the
list/detail endpoints and 404 on update/delete; an API-created property is
stamped; legacy NULL-org rows stay visible.
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client, Property

client = TestClient(app)
OTHER_ORG = 99999


def _client(db, org_id):
    c = Client(name=f"PropOwner {uuid.uuid4().hex[:6]}", status="active", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _prop(db, owner, name, org_id):
    p = Property(client_id=owner.id, name=name, address="1 Scope St",
                 property_type="residential", active=True, org_id=org_id)
    db.add(p); db.commit(); db.refresh(p)
    return p.id


def test_other_org_property_is_invisible_and_404():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    owner = _client(db, OTHER_ORG)
    other_id = _prop(db, owner, f"Other {tag}", OTHER_ORG)
    legacy_id = _prop(db, owner, f"Legacy {tag}", None)
    try:
        rows = client.get("/api/properties").json()
        ids = {r["id"] for r in rows}
        assert other_id not in ids, "cross-tenant property leaked into the list"
        assert legacy_id in ids, "legacy NULL-org property should remain visible"

        assert client.get(f"/api/properties/{other_id}").status_code == 404
        assert client.get(f"/api/properties/{legacy_id}").status_code == 200
        assert client.patch(f"/api/properties/{other_id}", json={"name": "hax"}).status_code == 404
        assert client.delete(f"/api/properties/{other_id}").status_code == 404
    finally:
        db.query(Property).filter(Property.id.in_([other_id, legacy_id])).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == owner.id).delete(synchronize_session=False)
        db.commit(); db.close()


def test_created_property_is_stamped_with_caller_org():
    db = SessionLocal()
    owner = _client(db, None)  # owner visible to caller (NULL org tolerated)
    try:
        r = client.post("/api/properties", json={
            "client_id": owner.id, "name": f"Stamp {uuid.uuid4().hex[:6]}",
            "address": "5 New St", "property_type": "residential",
        })
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        row = db.query(Property).filter(Property.id == pid).first()
        assert row.org_id is not None, "created property must be stamped with an org"
        db.query(Property).filter(Property.id == pid).delete(synchronize_session=False)
        db.commit()
    finally:
        db.query(Client).filter(Client.id == owner.id).delete(synchronize_session=False)
        db.commit(); db.close()
