"""Multi-tenancy MT-2: clients are scoped to the caller's workspace.

The test suite authenticates with the master API key, which resolves to the
default org (1). So a client planted in a DIFFERENT org must be invisible to the
list/detail endpoints, a client created via the API is stamped with the caller's
org, and legacy NULL-org rows stay visible (no regression from MT-1's backfill).
"""
import uuid
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import Client

client = TestClient(app)
OTHER_ORG = 99999  # a workspace the API-key caller is NOT in


def _mk(db, name, org_id):
    c = Client(name=name, status="lead", org_id=org_id)
    db.add(c); db.commit(); db.refresh(c)
    return c.id


def test_other_org_client_is_invisible_and_404():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    other_id = _mk(db, f"Other Org {tag}", OTHER_ORG)
    legacy_id = _mk(db, f"Legacy {tag}", None)  # pre-tenancy row (org_id NULL)
    try:
        # List excludes the other-org client but keeps the legacy NULL-org one.
        rows = client.get("/api/clients?limit=200").json()
        ids = {r["id"] for r in rows}
        assert other_id not in ids, "cross-tenant client leaked into the list"
        assert legacy_id in ids, "legacy NULL-org client should remain visible"

        # Direct fetch of the other-org client reads as 404 (not visible).
        assert client.get(f"/api/clients/{other_id}").status_code == 404
        assert client.get(f"/api/clients/{other_id}/profile").status_code == 404
        # The legacy one is still reachable.
        assert client.get(f"/api/clients/{legacy_id}").status_code == 200
    finally:
        db.query(Client).filter(Client.id.in_([other_id, legacy_id])).delete(synchronize_session=False)
        db.commit(); db.close()


def test_created_client_is_stamped_with_caller_org():
    tag = uuid.uuid4().hex[:8]
    r = client.post("/api/clients", json={"name": f"Stamp Test {tag}"})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    db = SessionLocal()
    try:
        row = db.query(Client).filter(Client.id == cid).first()
        assert row.org_id is not None, "created client must be stamped with an org"
        # And it's visible to the same caller.
        assert client.get(f"/api/clients/{cid}").status_code == 200
    finally:
        db.query(Client).filter(Client.id == cid).delete(synchronize_session=False)
        db.commit(); db.close()


def test_cannot_update_or_delete_other_org_client():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    other_id = _mk(db, f"Other Mutate {tag}", OTHER_ORG)
    try:
        assert client.patch(f"/api/clients/{other_id}", json={"notes": "hacked"}).status_code == 404
        assert client.delete(f"/api/clients/{other_id}").status_code == 404
        db.expire_all()
        row = db.query(Client).filter(Client.id == other_id).first()
        assert row is not None and (row.notes or "") != "hacked"  # untouched
    finally:
        db.query(Client).filter(Client.id == other_id).delete(synchronize_session=False)
        db.commit(); db.close()
