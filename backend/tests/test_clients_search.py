"""Tests for client typeahead search on GET /api/clients.

Backs the job scheduler's searchable client picker: a `search` term filters by
name / email / phone (case-insensitive) instead of preloading every client.
"""
import pytest

from database.db import SessionLocal
from database.models import Client
from modules.clients.router import get_clients


@pytest.fixture
def sample_clients():
    db = SessionLocal()
    made = [
        Client(name="Andrew Nadeau", email="andrew@example.com", phone="2075551234", status="active", org_id=None),
        Client(name="Bethany Smith", email="beth@example.com", phone="2075559999", status="active", org_id=None),
    ]
    for c in made:
        db.add(c)
    db.commit()
    for c in made:
        db.refresh(c)
    ids = [c.id for c in made]
    yield db, ids
    db.query(Client).filter(Client.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_search_matches_name(sample_clients):
    db, ids = sample_clients
    out = get_clients(status="active", search="nadeau", limit=20, offset=0, db=db, org_id=None)
    names = {c["name"] for c in out}
    assert "Andrew Nadeau" in names
    assert "Bethany Smith" not in names


def test_search_matches_email_and_phone(sample_clients):
    db, ids = sample_clients
    by_email = get_clients(status="active", search="beth@", limit=20, offset=0, db=db, org_id=None)
    assert any(c["name"] == "Bethany Smith" for c in by_email)
    by_phone = get_clients(status="active", search="5551234", limit=20, offset=0, db=db, org_id=None)
    assert any(c["name"] == "Andrew Nadeau" for c in by_phone)


def test_blank_search_does_not_filter(sample_clients):
    db, ids = sample_clients
    out = get_clients(status="active", search="   ", limit=200, offset=0, db=db, org_id=None)
    names = {c["name"] for c in out}
    assert {"Andrew Nadeau", "Bethany Smith"} <= names
