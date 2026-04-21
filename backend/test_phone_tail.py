"""Tests for phone_tail denormalization and indexed lookups."""
import pytest
from sqlalchemy.orm import Session
from database.models import Client, ContactPhone, Base
from database.db import engine
from utils.phone import phone_tail as compute_phone_tail


@pytest.fixture(scope="function")
def db():
    """Fresh in-memory DB per test."""
    Base.metadata.create_all(engine)
    from database.db import SessionLocal
    session = SessionLocal()
    yield session
    session.close()
    Base.metadata.drop_all(engine)


def test_client_phone_tail_populated_on_insert(db):
    """phone_tail should auto-populate on Client insert."""
    c = Client(name="Test", phone="+1 (207) 555-1234")
    db.add(c)
    db.commit()
    db.refresh(c)
    assert c.phone_tail == "2075551234"


def test_client_phone_tail_updated_on_phone_change(db):
    """phone_tail should update when phone field changes."""
    c = Client(name="Test", phone="+12075551234")
    db.add(c)
    db.commit()
    c.phone = "+12075559999"
    db.commit()
    db.refresh(c)
    assert c.phone_tail == "2075559999"


def test_contact_phone_tail_populated(db):
    """phone_tail should auto-populate on ContactPhone insert."""
    client = Client(name="Test")
    db.add(client)
    db.commit()
    cp = ContactPhone(client_id=client.id, phone="(207) 555-1234")
    db.add(cp)
    db.commit()
    db.refresh(cp)
    assert cp.phone_tail == "2075551234"


def test_phone_tail_null_for_empty_phone(db):
    """phone_tail should be None when phone is None or empty."""
    c = Client(name="Test")
    db.add(c)
    db.commit()
    assert c.phone_tail is None

    c.phone = ""
    db.commit()
    db.refresh(c)
    assert c.phone_tail is None


def test_phone_tail_utility(db):
    """Verify phone_tail utility function."""
    assert compute_phone_tail("+1 (207) 555-1234") == "2075551234"
    assert compute_phone_tail("+12075551234") == "2075551234"
    assert compute_phone_tail("2075551234") == "2075551234"
    assert compute_phone_tail(None) is None
    assert compute_phone_tail("") is None


def test_match_client_by_phone_uses_index(db):
    """Verify indexed lookup works for phone matching."""
    from modules.comms.router import _match_client_by_phone

    # Create a real client
    real = Client(name="Real", phone="+1 (207) 555-1234")
    db.add(real)
    db.commit()

    # Should match on exact phone
    result = _match_client_by_phone(db, "+12075551234")
    assert result is not None
    assert result.id == real.id

    # Should match on fuzzy tail
    result = _match_client_by_phone(db, "(207) 555-1234")
    assert result is not None
    assert result.id == real.id

    # Should NOT match wrong number
    result = _match_client_by_phone(db, "555-9999")
    assert result is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
