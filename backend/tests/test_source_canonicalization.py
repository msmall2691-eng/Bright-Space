"""clients.source is canonicalized on every write by the model validator, so the
"where do leads come from?" funnel groups cleanly: website|sms|email|referral|
manual|ical|phone|unknown. normalize_source() is the shared mapping.
"""
import uuid
import pytest

from utils.source import normalize_source
from database.db import SessionLocal
from database.models import Client


def test_normalize_source_mapping():
    assert normalize_source("Website") == "website"
    assert normalize_source("  website ") == "website"
    assert normalize_source("gmail") == "email"
    assert normalize_source("twilio") == "sms"
    assert normalize_source("gcal_instance") == "ical"
    assert normalize_source("xlsx_import") == "manual"
    assert normalize_source("merge") == "manual"
    assert normalize_source("call") == "phone"
    assert normalize_source("referral") == "referral"
    # Unrecognized / blank → unknown
    assert normalize_source("parsed_from_id") == "unknown"
    assert normalize_source("completed/cancelled visit") == "unknown"
    assert normalize_source("") == "unknown"
    assert normalize_source(None) == "unknown"


@pytest.fixture
def cleanup_ids():
    ids = []
    yield ids
    db = SessionLocal()
    db.query(Client).filter(Client.id.in_(ids or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def test_model_validator_canonicalizes_on_write(cleanup_ids):
    db = SessionLocal()
    # A messy free-text source is normalized the moment it's assigned.
    c = Client(name=f"Src {uuid.uuid4().hex[:6]}", status="lead",
               source="Website", org_id=1)
    db.add(c); db.commit(); db.refresh(c)
    cleanup_ids.append(c.id)
    assert c.source == "website"

    # Internal marker maps to its canonical bucket; reassignment re-canonicalizes.
    c.source = "gcal_instance"
    db.commit(); db.refresh(c)
    assert c.source == "ical"

    c.source = "totally unknown thing"
    db.commit(); db.refresh(c)
    assert c.source == "unknown"
    db.close()
