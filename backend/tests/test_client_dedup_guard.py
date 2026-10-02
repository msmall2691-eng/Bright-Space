"""The server-side duplicate guard on POST /api/clients.

The inline "+ New client" forms everywhere (Schedule, Property, Quoting) and
the Clients page all funnel through create_client; this is the backstop that
keeps a second record from being made for a client who already exists —
matched by name, email, or phone — unless the caller explicitly forces it
after seeing the matches. The 409 body carries the full matching clients (with
ids) so the UI's "Use this / Create anyway" prompt can offer the existing one.
"""
import uuid

import pytest
from fastapi import HTTPException

from database.db import SessionLocal
from database.models import Client, Property
from modules.clients.router import create_client, ClientCreate


class _Owner:
    id = None
    email = "owner@example.com"
    role = "admin"


@pytest.fixture
def made():
    ids = {"clients": []}
    yield ids
    db = SessionLocal()
    db.query(Property).filter(Property.client_id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.query(Client).filter(Client.id.in_(ids["clients"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _seed(db, made, **over):
    out = create_client(ClientCreate(**over), db=db, current_user=_Owner(), org_id=None, force=True)
    made["clients"].append(out["id"])
    return out


def test_duplicate_name_blocks_and_returns_the_match(made):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    name = f"Dup Name {tag}"
    first = _seed(db, made, name=name, email=f"a{tag}@example.com")

    # Same name, different email → still a duplicate, blocked with 409.
    with pytest.raises(HTTPException) as ei:
        create_client(ClientCreate(name=name, email=f"b{tag}@example.com"),
                      db=db, current_user=_Owner(), org_id=None, force=False)
    assert ei.value.status_code == 409
    detail = ei.value.detail
    dupes = detail["duplicates"]
    assert [d["id"] for d in dupes] == [first["id"]]   # the UI needs the id to "Use this"
    assert "force=true" in detail["hint"]
    db.close()


def test_duplicate_email_and_phone_also_block(made):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    _seed(db, made, name=f"Email Owner {tag}", email=f"shared{tag}@example.com",
          phone="207-555-0100")

    # Different name, same email → blocked.
    with pytest.raises(HTTPException) as ei:
        create_client(ClientCreate(name=f"Other {tag}", email=f"shared{tag}@example.com"),
                      db=db, current_user=_Owner(), org_id=None, force=False)
    assert ei.value.status_code == 409

    # Different name/email, same phone (last-10 tail) → blocked.
    with pytest.raises(HTTPException) as ei2:
        create_client(ClientCreate(name=f"Third {tag}", phone="(207) 555-0100"),
                      db=db, current_user=_Owner(), org_id=None, force=False)
    assert ei2.value.status_code == 409
    db.close()


def test_force_creates_despite_match(made):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    name = f"Forced {tag}"
    _seed(db, made, name=name)

    out = create_client(ClientCreate(name=name), db=db, current_user=_Owner(),
                        org_id=None, force=True)
    made["clients"].append(out["id"])
    assert db.query(Client).filter(Client.name == name).count() == 2
    db.close()


def test_distinct_client_is_not_blocked(made):
    db = SessionLocal()
    tag = uuid.uuid4().hex[:6]
    _seed(db, made, name=f"Alpha {tag}", email=f"alpha{tag}@example.com", phone="207-555-0111")

    # Nothing in common → creates normally even without force.
    out = create_client(
        ClientCreate(name=f"Beta {tag}", email=f"beta{tag}@example.com", phone="207-555-0222"),
        db=db, current_user=_Owner(), org_id=None, force=False)
    made["clients"].append(out["id"])
    assert out["id"]
    db.close()
