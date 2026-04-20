"""
Tests for the placeholder-client → real-client absorption logic in
backend/modules/clients/router.py.

Why this exists
---------------
Before this fix: when an SMS arrives from an unknown number, the Twilio
inbound webhook auto-creates a "placeholder" Client (status='lead',
source='sms', name=phone). When you later add the same phone to a real
seeded client, the SMS thread STAYS linked to the placeholder. Result:
your real client's profile has no SMS history, and the conversation list
shows the phone number instead of the customer's name.

After this fix: when a phone is added to a real client, any matching
placeholder client (strictly defined — never absorbs records that have
been touched manually) gets absorbed into the real client. Conversations,
messages, lead intakes, and contact phones are re-parented; the
placeholder Client row is deleted.

Also covers the original XFAIL from test_contact_phone_backwards.py.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime

import pytest
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Use a dedicated test DB
os.environ["DATABASE_URL"] = "sqlite:///./test_placeholder_absorption.db"
_db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "test_placeholder_absorption.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from database.db import init_db, SessionLocal  # noqa: E402
init_db()

from database.models import (  # noqa: E402
    Client, ContactPhone, Conversation, Message, LeadIntake, Job, Quote,
)
from modules.clients.router import (  # noqa: E402
    _is_placeholder_candidate,
    _absorb_placeholder_clients,
    _link_and_merge_conversations,
)


# ──────────────────────────────────────────────────────────────────────
# Test plumbing
# ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def db() -> Session:
    """Fresh session per test, with full table cleanup so tests can't bleed
    state into each other."""
    s = SessionLocal()
    try:
        # Order matters: child tables before parents.
        s.query(Message).delete()
        s.query(Conversation).delete()
        s.query(LeadIntake).delete()
        s.query(ContactPhone).delete()
        s.query(Job).delete()
        s.query(Quote).delete()
        s.query(Client).delete()
        s.commit()
        yield s
    finally:
        s.close()


def make_placeholder(db: Session, phone: str) -> Client:
    """Simulate what the Twilio inbound webhook does on an unknown number."""
    c = Client(name=phone, phone=phone, status="lead", source="sms")
    db.add(c)
    db.flush()
    intake = LeadIntake(name=f"SMS {phone}", phone=phone, source="sms",
                        status="new", client_id=c.id)
    conv = Conversation(channel="sms", client_id=c.id,
                        external_contact=phone, status="open",
                        unread_count=1)
    db.add_all([intake, conv])
    db.flush()
    msg = Message(client_id=c.id, conversation_id=conv.id,
                  channel="sms", direction="inbound",
                  from_addr=phone, to_addr="+18005550000",
                  body="Hi, I'd like to book a turnover")
    db.add(msg)
    db.commit()
    return c


def make_real_client(db: Session, name: str, **extra) -> Client:
    c = Client(name=name, status=extra.get("status", "active"), **{
        k: v for k, v in extra.items() if k != "status"
    })
    db.add(c); db.commit(); db.refresh(c)
    return c


# ──────────────────────────────────────────────────────────────────────
# _is_placeholder_candidate — the safety check
# ──────────────────────────────────────────────────────────────────────

def test_placeholder_check_accepts_clean_sms_autocreate(db):
    p = make_placeholder(db, "+12075559001")
    assert _is_placeholder_candidate(p) is True


def test_placeholder_check_rejects_promoted_status(db):
    p = make_placeholder(db, "+12075559002")
    p.status = "active"
    db.commit()
    assert _is_placeholder_candidate(p) is False


def test_placeholder_check_rejects_non_sms_source(db):
    p = make_placeholder(db, "+12075559003")
    p.source = "website"
    db.commit()
    assert _is_placeholder_candidate(p) is False


def test_placeholder_check_rejects_real_name(db):
    p = make_placeholder(db, "+12075559004")
    p.name = "John Doe"
    db.commit()
    assert _is_placeholder_candidate(p) is False


def test_placeholder_check_rejects_with_email(db):
    p = make_placeholder(db, "+12075559005")
    p.email = "real@example.com"
    db.commit()
    assert _is_placeholder_candidate(p) is False


def test_placeholder_check_rejects_with_billing_address(db):
    p = make_placeholder(db, "+12075559006")
    p.billing_address = "PO Box 123"
    db.commit()
    assert _is_placeholder_candidate(p) is False


def test_placeholder_check_rejects_with_quote(db):
    p = make_placeholder(db, "+12075559007")
    db.add(Quote(client_id=p.id, address="x", subtotal=100, total=100))
    db.commit()
    db.refresh(p)
    assert _is_placeholder_candidate(p) is False


def test_placeholder_check_rejects_with_job(db):
    p = make_placeholder(db, "+12075559008")
    db.add(Job(client_id=p.id, title="t", scheduled_date="2030-01-01"))
    db.commit()
    db.refresh(p)
    assert _is_placeholder_candidate(p) is False


def test_placeholder_check_accepts_formatted_phone_name(db):
    """Some webhooks store the name as '(207) 555-1234' instead of E.164."""
    p = make_placeholder(db, "(207) 555-9009")
    assert _is_placeholder_candidate(p) is True


# ──────────────────────────────────────────────────────────────────────
# _absorb_placeholder_clients — the actual merge
# ──────────────────────────────────────────────────────────────────────

def test_absorb_basic_case(db):
    """The bug from prod: SMS arrives → placeholder created → user adds the
    phone to the real client → placeholder absorbed."""
    placeholder = make_placeholder(db, "+12075550101")
    real = make_real_client(db, "Hank Real")

    report = {"linked_conversations": 0, "linked_messages": 0}
    _absorb_placeholder_clients(db, real.id, "+12075550101", report)
    db.commit()

    # Placeholder is gone
    assert db.query(Client).filter(Client.id == placeholder.id).first() is None
    # Conversation now belongs to the real client
    convs = db.query(Conversation).filter(Conversation.client_id == real.id).all()
    assert len(convs) == 1
    # Message too
    msgs = db.query(Message).filter(Message.client_id == real.id).all()
    assert len(msgs) == 1
    # Lead intake migrated
    intakes = db.query(LeadIntake).filter(LeadIntake.client_id == real.id).all()
    assert len(intakes) == 1
    # Report says one absorbed
    assert report.get("absorbed_clients") == 1


def test_absorb_with_format_difference(db):
    """Placeholder created from '(207) 555-0202' should be absorbed when
    the user adds the phone as '+12075550202'."""
    placeholder = make_placeholder(db, "(207) 555-0202")
    real = make_real_client(db, "Iris Format")

    report = {"linked_conversations": 0, "linked_messages": 0}
    _absorb_placeholder_clients(db, real.id, "+12075550202", report)
    db.commit()

    assert db.query(Client).filter(Client.id == placeholder.id).first() is None
    assert report["absorbed_clients"] == 1


def test_absorb_does_not_touch_real_client_with_jobs(db):
    """If a candidate has any jobs, refuse absorption — it's not a placeholder."""
    not_a_placeholder = make_placeholder(db, "+12075550303")
    db.add(Job(client_id=not_a_placeholder.id, title="t",
               scheduled_date="2030-01-01"))
    db.commit()

    real = make_real_client(db, "Jack Distinct")
    report = {"linked_conversations": 0, "linked_messages": 0}
    _absorb_placeholder_clients(db, real.id, "+12075550303", report)
    db.commit()

    # Untouched
    assert db.query(Client).filter(Client.id == not_a_placeholder.id).first() is not None
    assert report.get("absorbed_clients", 0) == 0


def test_absorb_does_not_touch_self(db):
    """If the candidate's id is the real client's id, skip — no self-cannibalism."""
    real = make_real_client(db, "Karen Self")
    real.phone = "+12075550404"
    real.source = "sms"
    db.commit()
    report = {"linked_conversations": 0, "linked_messages": 0}
    _absorb_placeholder_clients(db, real.id, "+12075550404", report)
    db.commit()

    # Real client still exists
    assert db.query(Client).filter(Client.id == real.id).first() is not None


def test_absorb_dedupes_contact_phones(db):
    """If the placeholder has a ContactPhone with the same number that the
    real client already has, don't double-add — drop the placeholder's row."""
    placeholder = make_placeholder(db, "+12075550505")
    real = make_real_client(db, "Lou Dedup")
    db.add(ContactPhone(client_id=placeholder.id, phone="+12075550505",
                        is_primary=True, source="twilio"))
    db.add(ContactPhone(client_id=real.id, phone="+12075550505",
                        is_primary=True, source="manual"))
    db.commit()

    report = {"linked_conversations": 0, "linked_messages": 0}
    _absorb_placeholder_clients(db, real.id, "+12075550505", report)
    db.commit()

    phones = db.query(ContactPhone).filter(
        ContactPhone.client_id == real.id,
        ContactPhone.phone == "+12075550505",
    ).all()
    assert len(phones) == 1, f"expected 1 phone after dedup, got {len(phones)}"


def test_absorbs_multiple_placeholders(db):
    """Two placeholders for the same phone (different format variations) →
    both absorbed into the same real client."""
    p1 = make_placeholder(db, "+12075550606")
    p2 = make_placeholder(db, "(207) 555-0606")
    real = make_real_client(db, "Mona Multi")

    report = {"linked_conversations": 0, "linked_messages": 0}
    _absorb_placeholder_clients(db, real.id, "+12075550606", report)
    db.commit()

    assert db.query(Client).filter(Client.id == p1.id).first() is None
    assert db.query(Client).filter(Client.id == p2.id).first() is None
    assert report["absorbed_clients"] == 2
    # Both conversations now on the real client (will be merged at the next
    # step inside _link_and_merge_conversations, not here)
    convs = db.query(Conversation).filter(Conversation.client_id == real.id).all()
    assert len(convs) == 2


# ──────────────────────────────────────────────────────────────────────
# Full flow through _link_and_merge_conversations
# ──────────────────────────────────────────────────────────────────────

def test_full_flow_absorbs_then_merges(db):
    """End-to-end: real client already has one SMS conversation (e.g. from
    a prior outbound). Placeholder gets absorbed, then the dup-merge step
    consolidates everything into one thread."""
    real = make_real_client(db, "Nina Combined")
    # Real client already has a conversation under their existing primary phone
    existing_conv = Conversation(channel="sms", client_id=real.id,
                                 external_contact="2075550707",
                                 status="open", unread_count=2)
    db.add(existing_conv); db.flush()
    db.add(Message(client_id=real.id, conversation_id=existing_conv.id,
                   channel="sms", direction="outbound",
                   to_addr="+12075550707", body="hello from us"))
    db.commit()

    # Now an SMS arrived, was auto-placeholdered
    placeholder = make_placeholder(db, "+12075550707")

    # User adds the phone to the real client
    report = _link_and_merge_conversations(db, real.id, "+12075550707")
    db.commit()

    assert report["absorbed_clients"] == 1, report
    # Placeholder gone
    assert db.query(Client).filter(Client.id == placeholder.id).first() is None
    # Exactly one conversation on the real client (after merge)
    convs = db.query(Conversation).filter(
        Conversation.client_id == real.id,
        Conversation.channel == "sms",
    ).all()
    assert len(convs) == 1, f"expected 1 conv after merge, got {len(convs)}"
    # Both messages survived
    msgs = db.query(Message).filter(Message.conversation_id == convs[0].id).all()
    assert len(msgs) == 2, f"expected 2 messages, got {len(msgs)}"


def test_full_flow_no_placeholder_doesnt_break(db):
    """Sanity: when there's no placeholder, the normal orphan-link flow still
    works as before."""
    orphan = Conversation(channel="sms", client_id=None,
                          external_contact="+12075550808", status="open")
    db.add(orphan); db.commit()
    real = make_real_client(db, "Otis Normal")

    report = _link_and_merge_conversations(db, real.id, "+12075550808")
    db.commit()

    assert report["absorbed_clients"] == 0
    assert report["linked_conversations"] == 1
    db.refresh(orphan)
    assert orphan.client_id == real.id


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
