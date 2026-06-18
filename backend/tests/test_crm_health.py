"""GET /clients/health — read-only CRM health snapshot.

Classifies every client into one mutually-exclusive bucket (test / spam_marketing
/ duplicate / incomplete / real) so the "how many of these leads are real?"
question is answerable BEFORE any cleanup runs. This asserts the classifier via
count deltas, so it's robust against whatever else is in the test DB.
"""
import uuid
import pytest

from database.db import SessionLocal
from database.models import Client
from modules.clients.router import crm_health


@pytest.fixture
def health_fixture():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    dup_email = f"dup_{tag}@gmail.com"
    made = [
        # test bucket — name matches a junk pattern
        Client(name=f"Test Account {tag}", email=f"real_{tag}@gmail.com", status="lead", org_id=None),
        # spam_marketing — no-reply / blocked marketing sender
        Client(name="Indeed Jobs", email="noreply@indeed.com", status="lead", org_id=None),
        # duplicate pair — share a normalized email
        Client(name=f"Dup One {tag}", email=dup_email, status="lead", org_id=None),
        Client(name=f"Dup Two {tag}", email=dup_email.upper(), status="lead", org_id=None),
        # incomplete — no reachable email or phone
        Client(name=f"No Contact {tag}", status="lead", org_id=None),
        # real — contactable, named, unique
        Client(name=f"Jane Customer {tag}", email=f"jane_{tag}@gmail.com", status="active", org_id=None),
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


def _counts(db):
    out = crm_health(sample=0, db=db, org_id=None)
    return out, {k: v["count"] for k, v in out["buckets"].items()}


def test_health_classifies_each_bucket(health_fixture):
    db, ids = health_fixture
    out, after = _counts(db)

    # Buckets are mutually exclusive — they sum to the total.
    assert sum(after.values()) == out["total"]
    # Independent tallies also each cover every client.
    assert sum(out["by_source"].values()) == out["total"]
    assert sum(out["by_status"].values()) == out["total"]

    # Remove the six fixture clients and re-measure: the deltas are exactly the
    # buckets they should have landed in (uuid-tagged data can't collide).
    db.query(Client).filter(Client.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    _, before = _counts(db)

    assert after["test"] - before["test"] == 1
    assert after["spam_marketing"] - before["spam_marketing"] == 1
    assert after["duplicate"] - before["duplicate"] == 2
    assert after["incomplete"] - before["incomplete"] == 1
    assert after["real"] - before["real"] == 1
