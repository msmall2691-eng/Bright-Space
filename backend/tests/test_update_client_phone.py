"""PATCH /api/clients/{id} must never fail the caller because of the
best-effort phone/ContactPhone/SMS-thread-linking side-effect that runs
AFTER the core field commit. update_client()'s own comment says this block
is "best-effort and fully isolated — if it throws, the save still stands;
we log and move on rather than 500" — this test proves that boundary holds
even when the side-effect has real work to do (an existing primary
ContactPhone row to demote, and an existing SMS conversation on the client
that a newly-linked orphan conversation must fold into), which is exactly
the shape of data that exercises every branch of the side-effect block.

Owner report ("I have to click a million menus and it didn't work when I
finally found it") is consistent with this exact failure class: a real save
that 500s in the response because of an unrelated side-effect error.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, ContactPhone, Conversation, Message
from modules.clients.router import update_client, ClientUpdate
from utils.phone import phone_tail


class _Owner:
    id = None
    email = "owner@example.com"
    role = "admin"


@pytest.fixture
def rig():
    """A client with an existing primary ContactPhone and an existing SMS
    conversation, plus an orphan SMS conversation (with an unlinked message)
    that matches the NEW phone's tail — so updating the phone must promote
    a new primary ContactPhone, demote the old one, AND fold the orphan
    conversation into the client's existing SMS thread."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    old_phone = "2075550100"
    new_phone = "2075550199"

    c = Client(name=f"Phone Test {tag}", phone=old_phone,
               phone_tail=phone_tail(old_phone), status="active")
    db.add(c); db.commit(); db.refresh(c)

    old_cp = ContactPhone(client_id=c.id, phone=old_phone, phone_tail=phone_tail(old_phone),
                           is_primary=True, phone_type="mobile", source="manual")
    db.add(old_cp)

    existing_conv = Conversation(client_id=c.id, channel="sms", external_contact=old_phone, status="open")
    db.add(existing_conv)

    orphan_conv = Conversation(client_id=None, channel="sms", external_contact=new_phone, status="open")
    db.add(orphan_conv)
    db.flush()
    orphan_msg = Message(client_id=None, conversation_id=orphan_conv.id, channel="sms",
                          direction="inbound", from_addr=new_phone, to_addr="+15551234567",
                          body="hi", status="received")
    db.add(orphan_msg)
    db.commit()

    yield db, c, old_phone, new_phone

    db.rollback()
    db.query(Message).filter(Message.client_id == c.id).delete(synchronize_session=False)
    db.query(Conversation).filter(Conversation.client_id == c.id).delete(synchronize_session=False)
    db.query(ContactPhone).filter(ContactPhone.client_id == c.id).delete(synchronize_session=False)
    db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
    db.commit(); db.close()


def test_phone_update_with_existing_contactphone_and_conversation_succeeds(rig):
    """The exact scenario the side-effect block exists for: a clean 200 with
    the new phone persisted, the old ContactPhone demoted, a new primary
    ContactPhone created, and the orphan conversation folded in — none of
    which should ever be able to turn a successful save into an error
    response."""
    db, c, old_phone, new_phone = rig

    out = update_client(c.id, ClientUpdate(phone=new_phone), db=db,
                         current_user=_Owner(), org_id=None)

    # The response itself is the save confirmation — no exception escaped.
    # (update_client normalizes to E.164, so compare on the shared tail.)
    assert phone_tail(out["phone"]) == phone_tail(new_phone)
    saved_phone = out["phone"]

    # Persisted for real, not just echoed back.
    db.expire_all()
    fresh = db.query(Client).filter(Client.id == c.id).one()
    assert fresh.phone == saved_phone

    # Side-effect actually ran: new primary ContactPhone, old one demoted.
    phones = {phone_tail(cp.phone): cp.is_primary for cp in db.query(ContactPhone).filter(ContactPhone.client_id == c.id).all()}
    assert phones.get(phone_tail(new_phone)) is True
    assert phones.get(phone_tail(old_phone)) is False

    # The orphan conversation was folded into the client's existing SMS
    # thread rather than left dangling or raising on the unique index.
    convs = db.query(Conversation).filter(Conversation.client_id == c.id, Conversation.channel == "sms").all()
    assert len(convs) == 1


def test_phone_update_side_effect_failure_still_returns_saved_client(rig, monkeypatch):
    """Even if the side-effect block itself blows up, the core field save
    must still be reflected in a clean 200 — the try/except around the
    side-effect (update_client, ~lines 1100-1150) must not let an internal
    exception escape as a 500 once the field commit (line 1094) already
    succeeded."""
    db, c, old_phone, new_phone = rig

    import modules.clients.router as clients_router

    def _boom(*a, **k):
        raise RuntimeError("simulated side-effect failure")

    monkeypatch.setattr(clients_router, "_link_and_merge_conversations", _boom)

    out = update_client(c.id, ClientUpdate(phone=new_phone), db=db,
                         current_user=_Owner(), org_id=None)

    assert phone_tail(out["phone"]) == phone_tail(new_phone)
    db.expire_all()
    fresh = db.query(Client).filter(Client.id == c.id).one()
    assert phone_tail(fresh.phone) == phone_tail(new_phone)
