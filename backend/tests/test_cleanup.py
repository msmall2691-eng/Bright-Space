"""Tidy Up — retroactive duplicate detection + safe client merge.

GET /api/cleanup/scan clusters clients that share a strong signal (here: the
same phone in two different formats). POST /api/cleanup/clients/merge reassigns
every client-scoped record to the primary, preserves the duplicate's other
contact info, and deletes the duplicate. Verified end to end on seeded rows.
"""
import uuid
import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import (
    Client, Property, Job, Invoice, ContactEmail, ContactPhone,
)
from modules.auth.router import get_current_user, current_org_id


class _Admin:
    id, org_id, role, status, active = 7403, 1, "admin", "active", True
    email = "cleanup-admin@example.com"


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: _Admin()
    app.dependency_overrides[current_org_id] = lambda: 1
    api = TestClient(app)
    ids = {"clients": [], "properties": [], "jobs": [], "invoices": []}
    yield api, ids
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)
    db = SessionLocal()
    cids = ids["clients"] or [0]
    db.query(Job).filter(Job.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Invoice).filter(Invoice.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Property).filter(Property.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(ContactEmail).filter(ContactEmail.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(ContactPhone).filter(ContactPhone.client_id.in_(cids)).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(cids)).delete(synchronize_session=False)
    db.commit(); db.close()


def _mk_client(ids, name, phone, email=""):
    db = SessionLocal()
    c = Client(name=name, phone=phone, email=email, status="active", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    ids["clients"].append(c.id); cid = c.id; db.close()
    return cid


def _seed_records(ids, cid):
    db = SessionLocal()
    p = Property(client_id=cid, name="9 Elm St", address="9 Elm St", property_type="residential", org_id=1)
    db.add(p); db.commit(); db.refresh(p)
    ids["properties"].append(p.id)
    j = Job(client_id=cid, property_id=p.id, job_type="residential", title="Clean", status="scheduled", org_id=1)
    inv = Invoice(client_id=cid, invoice_number=f"INV-{uuid.uuid4().hex[:8]}", status="sent", total=100.0, org_id=1)
    db.add(j); db.add(inv); db.commit()
    db.refresh(j); db.refresh(inv)
    ids["jobs"].append(j.id); ids["invoices"].append(inv.id)
    out = (p.id, j.id, inv.id); db.close()
    return out


def test_scan_finds_dupes_then_merge_moves_records(client):
    api, ids = client

    # Same person, phone in two formats, different emails.
    primary = _mk_client(ids, "Jane Doe", "(207) 555-1234", email="jane@home.com")
    dup = _mk_client(ids, "Jane Doe", "207-555-1234", email="jane.doe@work.com")
    pid, jid, invid = _seed_records(ids, dup)  # records live on the duplicate

    # --- scan sees them as one group, matched on phone ---
    scan = api.get("/api/cleanup/scan").json()
    group = next((g for g in scan["duplicate_clients"]
                  if {primary, dup} <= {c["id"] for c in g["clients"]}), None)
    assert group is not None, "duplicate clients not clustered"
    assert "phone" in group["reason"]

    # --- merge duplicate → primary ---
    res = api.post("/api/cleanup/clients/merge",
                   json={"primary_id": primary, "duplicate_id": dup}).json()
    assert res["removed"] == dup
    assert res["merged_into"]["id"] == primary
    assert res["moved"].get("jobs", 0) >= 1 and res["moved"].get("invoices", 0) >= 1

    db = SessionLocal()
    try:
        assert db.query(Client).filter(Client.id == dup).first() is None      # duplicate gone
        assert db.query(Job).filter(Job.id == jid).first().client_id == primary
        assert db.query(Invoice).filter(Invoice.id == invid).first().client_id == primary
        assert db.query(Property).filter(Property.id == pid).first().client_id == primary
        # duplicate's distinct email preserved as an additional contact
        assert db.query(ContactEmail).filter(
            ContactEmail.client_id == primary, ContactEmail.email == "jane.doe@work.com").first() is not None
    finally:
        db.close()

    # --- scan no longer reports that pair ---
    scan2 = api.get("/api/cleanup/scan").json()
    still = next((g for g in scan2["duplicate_clients"]
                  if dup in {c["id"] for c in g["clients"]}), None)
    assert still is None


def _add_email(cid, email, is_primary):
    db = SessionLocal()
    db.add(ContactEmail(client_id=cid, email=email, is_primary=is_primary))
    db.commit(); db.close()


def _add_phone(cid, phone, is_primary):
    from utils.contacts import phone_last10 as _tail
    db = SessionLocal()
    db.add(ContactPhone(client_id=cid, phone=phone, phone_tail=_tail(phone), is_primary=is_primary))
    db.commit(); db.close()


def test_merge_dedups_contacts_no_double_primary(client):
    """A shared email/phone that exists on BOTH records must not leave the primary
    with a duplicate contact row or a second is_primary=True. Distinct contacts
    from the duplicate carry over (demoted to non-primary)."""
    api, ids = client
    primary = _mk_client(ids, "Sam Rowe", "(207) 555-0100", email="sam@home.com")
    dup = _mk_client(ids, "Sam Rowe", "207-555-0100", email="sam@work.com")

    # Both carry the same additional email + phone; the dup also has distinct ones.
    _add_email(primary, "shared@x.com", is_primary=True)
    _add_email(dup, "shared@x.com", is_primary=True)      # collides with primary's
    _add_email(dup, "extra@x.com", is_primary=False)      # genuinely new
    _add_phone(primary, "+12075550100", is_primary=True)
    _add_phone(dup, "+12075550100", is_primary=True)      # collides (same last-10)
    _add_phone(dup, "+12075559999", is_primary=False)     # genuinely new

    res = api.post("/api/cleanup/clients/merge",
                   json={"primary_id": primary, "duplicate_id": dup}).json()
    assert res["removed"] == dup

    db = SessionLocal()
    try:
        emails = db.query(ContactEmail).filter(ContactEmail.client_id == primary).all()
        by_addr = {}
        for e in emails:
            by_addr[e.email] = by_addr.get(e.email, 0) + 1
        assert by_addr.get("shared@x.com") == 1, "shared email duplicated on merge"
        assert "extra@x.com" in by_addr, "duplicate's distinct email not carried over"
        assert sum(1 for e in emails if e.is_primary) == 1, "primary must keep exactly one primary email"

        phones = db.query(ContactPhone).filter(ContactPhone.client_id == primary).all()
        tails = {}
        for p in phones:
            tails[p.phone_tail] = tails.get(p.phone_tail, 0) + 1
        assert tails.get("2075550100") == 1, "shared phone duplicated on merge"
        assert "2075559999" in tails, "duplicate's distinct phone not carried over"
        assert sum(1 for p in phones if p.is_primary) == 1, "primary must keep exactly one primary phone"

        # duplicate's contact rows are all gone from its id
        assert db.query(ContactEmail).filter(ContactEmail.client_id == dup).count() == 0
        assert db.query(ContactPhone).filter(ContactPhone.client_id == dup).count() == 0
    finally:
        db.close()
