"""
Test the "backwards case" for client contact phone management & SMS linking.

The backwards case: SMS arrives (or is sent) BEFORE a client has the matching
phone number on file. Later, a contact phone is added to a client and we expect
the existing SMS conversation(s) and orphan messages to be retroactively linked
to that client. Duplicate SMS conversations for the same client should merge
into a single thread.

This file covers:
  1. Pure orphan-conversation linking — outbound SMS sent to unknown number
     creates an orphan conversation, then phone is added to a client → linked.
  2. Phone format fuzziness — orphan stored as "(207) 555-1234" matches a phone
     added as "+12075551234".
  3. Duplicate conversation merge — a client ends up with two SMS conversations
     (e.g. one orphan from a tail match + one already linked) → merged into one.
  4. Orphan message re-pointing — Messages with client_id=None and a matching
     from_addr get their client_id set on phone-add.
  5. Other-client-owns-it skip — conversation already linked to client B is NOT
     stolen when phone is added to client A (silent skip is the intended behavior).
  6. update_client primary-phone change — PATCH /api/clients/{id} with a new
     phone field also triggers the link-and-merge backfill.
  7. Placeholder-client → real-client gap — documents the case where an
     inbound SMS auto-created a placeholder client (name = phone number) and
     the same phone is later added to a real, named client. The current
     implementation does NOT relink across clients (only orphan conversations
     get linked), so this test ASSERTS the current behavior and flags the gap.

Run:  python backend/test_contact_phone_backwards.py
"""
import sys
import os

# Add the backend dir to path so imports work
sys.path.insert(0, os.path.dirname(__file__))

# Use a dedicated test DB
os.environ["DATABASE_URL"] = "sqlite:///./test_contact_phone_backwards.db"

# Wipe stale test DB so each run starts clean
db_path = os.path.join(os.path.dirname(__file__), "test_contact_phone_backwards.db")
if os.path.exists(db_path):
    os.remove(db_path)

from database.db import init_db, SessionLocal
init_db()

from fastapi.testclient import TestClient
from main import app
from database.models import (
    Client, Conversation, Message, ContactPhone,
)
from modules.clients.router import _link_and_merge_conversations, _phone_tail

api = TestClient(app)

PASS = "\033[92m PASS \033[0m"
FAIL = "\033[91m FAIL \033[0m"
SKIP = "\033[93m XFAIL \033[0m"  # documented current limitation
results = []


def check(name, condition, detail=""):
    status = PASS if condition else FAIL
    results.append(condition)
    print(f"  {status} {name}" + (f" — {detail}" if detail and not condition else ""))
    return condition


def xfail(name, condition, detail=""):
    """Expected failure — documents a current gap. Doesn't count against pass total."""
    status = SKIP
    print(f"  {status} {name}" + (f" — {detail}" if detail else ""))


def make_client(name, phone=None, email=None):
    """Helper: create a client via the API and return the dict."""
    payload = {"name": name}
    if phone:
        payload["phone"] = phone
    if email:
        payload["email"] = email
    r = api.post("/api/clients", json=payload)
    assert r.status_code in (200, 201), f"create client failed: {r.status_code} {r.text}"
    return r.json()


def fresh_session():
    """Get a fresh DB session for direct model manipulation."""
    return SessionLocal()


print("\n=== Contact Phone Backwards-Case Tests ===\n")


# ── 1. Orphan conversation gets linked when phone is added ────────
print("1. Orphan conv gets linked when phone is added via POST /phones")
db = fresh_session()
try:
    # Simulate: outbound SMS was sent earlier with no client_id, leaving an
    # orphan conversation + orphan message in the DB.
    orphan_conv = Conversation(
        channel="sms",
        client_id=None,
        external_contact="+12075550001",
        status="open",
    )
    db.add(orphan_conv)
    db.flush()
    orphan_msg = Message(
        conversation_id=orphan_conv.id,
        client_id=None,
        channel="sms",
        direction="outbound",
        from_addr="+18005550000",
        to_addr="+12075550001",
        body="Hey, are you the owner of the Ocean View property?",
    )
    db.add(orphan_msg)
    db.commit()
    orphan_conv_id = orphan_conv.id
    orphan_msg_id = orphan_msg.id
finally:
    db.close()

# Now create a client and add that phone via the API
c = make_client("Jane Backwards-Case")
r = api.post(f"/api/clients/{c['id']}/phones", json={
    "phone": "+12075550001",
    "phone_type": "mobile",
    "is_primary": True,
})
check("POST /phones returns 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
body = r.json()
check("response includes linked report",
      isinstance(body.get("linked"), dict),
      f"got {body}")
check("at least 1 conversation linked",
      body.get("linked", {}).get("linked_conversations", 0) >= 1)
check("at least 1 message linked",
      body.get("linked", {}).get("linked_messages", 0) >= 1)

# Verify in the DB
db = fresh_session()
try:
    conv = db.query(Conversation).filter(Conversation.id == orphan_conv_id).first()
    msg = db.query(Message).filter(Message.id == orphan_msg_id).first()
    check("orphan conversation now linked to client", conv.client_id == c["id"],
          f"conv.client_id={conv.client_id}, expected {c['id']}")
    check("orphan message now linked to client", msg.client_id == c["id"],
          f"msg.client_id={msg.client_id}, expected {c['id']}")
finally:
    db.close()
print()


# ── 2. Phone format fuzziness — last-10-digit match ───────────────
print("2. Phone formats: orphan stored as (207) 555-1234, phone added as +1...")
db = fresh_session()
try:
    orphan = Conversation(
        channel="sms", client_id=None,
        external_contact="(207) 555-1234",  # human-formatted
        status="open",
    )
    db.add(orphan)
    db.commit()
    orphan_id = orphan.id
finally:
    db.close()

c2 = make_client("Bob Format-Fuzz")
r = api.post(f"/api/clients/{c2['id']}/phones", json={
    "phone": "+12075551234",  # E.164
    "phone_type": "mobile",
    "is_primary": True,
})
check("POST /phones returns 200", r.status_code == 200)
linked = r.json().get("linked", {})
check("conversation in different format got linked",
      linked.get("linked_conversations", 0) >= 1,
      f"linked report: {linked}")

db = fresh_session()
try:
    conv = db.query(Conversation).filter(Conversation.id == orphan_id).first()
    check("conversation re-linked across formats", conv.client_id == c2["id"])
finally:
    db.close()
print()


# ── 3. Duplicate conversation merge ───────────────────────────────
print("3. Two SMS conversations for the same client → merged into one")
c3 = make_client("Carol Duplicate")
db = fresh_session()
try:
    # First conversation — already linked to Carol
    conv_a = Conversation(
        channel="sms", client_id=c3["id"],
        external_contact="+12075552222",
        status="open", unread_count=2,
    )
    db.add(conv_a)
    db.flush()
    db.add(Message(conversation_id=conv_a.id, client_id=c3["id"],
                   channel="sms", direction="inbound",
                   from_addr="+12075552222", body="hi"))
    db.add(Message(conversation_id=conv_a.id, client_id=c3["id"],
                   channel="sms", direction="outbound",
                   to_addr="+12075552222", body="hello"))

    # Second orphan conversation with same tail (different format)
    conv_b = Conversation(
        channel="sms", client_id=None,
        external_contact="2075552222",  # same tail, different format
        status="open", unread_count=1,
    )
    db.add(conv_b)
    db.flush()
    db.add(Message(conversation_id=conv_b.id, client_id=None,
                   channel="sms", direction="inbound",
                   from_addr="2075552222", body="follow up"))
    db.commit()
    conv_a_id, conv_b_id = conv_a.id, conv_b.id
finally:
    db.close()

# Add the phone to Carol — should link conv_b to Carol AND merge with conv_a
r = api.post(f"/api/clients/{c3['id']}/phones", json={
    "phone": "+12075552222",
    "phone_type": "mobile",
    "is_primary": True,
})
check("POST /phones returns 200", r.status_code == 200)
linked = r.json().get("linked", {})
check("merge report shows >= 1 merged",
      linked.get("merged_conversations", 0) >= 1,
      f"linked: {linked}")

db = fresh_session()
try:
    convs = db.query(Conversation).filter(
        Conversation.client_id == c3["id"],
        Conversation.channel == "sms",
    ).all()
    check("only 1 SMS conversation remains for Carol",
          len(convs) == 1, f"found {len(convs)}: {[c.id for c in convs]}")
    if convs:
        keeper = convs[0]
        msgs = db.query(Message).filter(Message.conversation_id == keeper.id).all()
        check("all 3 messages live in the keeper conversation",
              len(msgs) == 3, f"found {len(msgs)}")
        check("unread_counts merged (2 + 1 = 3)",
              keeper.unread_count == 3, f"got {keeper.unread_count}")
finally:
    db.close()
print()


# ── 4. Orphan message re-pointing (no conversation) ───────────────
print("4. Orphan messages with no conversation get client_id set on phone-add")
db = fresh_session()
try:
    loose_msg = Message(
        conversation_id=None,
        client_id=None,
        channel="sms",
        direction="inbound",
        from_addr="+12075553333",
        to_addr="+18005550000",
        body="loose orphan, no conv",
    )
    db.add(loose_msg)
    db.commit()
    loose_msg_id = loose_msg.id
finally:
    db.close()

c4 = make_client("Dan Loose-Message")
r = api.post(f"/api/clients/{c4['id']}/phones", json={
    "phone": "207-555-3333",
    "phone_type": "mobile",
    "is_primary": True,
})
check("POST /phones returns 200", r.status_code == 200)

db = fresh_session()
try:
    m = db.query(Message).filter(Message.id == loose_msg_id).first()
    check("loose orphan message now linked to client",
          m.client_id == c4["id"],
          f"got client_id={m.client_id}, expected {c4['id']}")
finally:
    db.close()
print()


# ── 5. Other-client-owns-it: silent skip is intended behavior ─────
print("5. Conversation owned by client B is NOT stolen when phone added to A")
c_owner = make_client("Eve Owner")
c_other = make_client("Frank Other")
db = fresh_session()
try:
    eve_conv = Conversation(
        channel="sms", client_id=c_owner["id"],
        external_contact="+12075554444",
        status="open",
    )
    db.add(eve_conv)
    db.commit()
    eve_conv_id = eve_conv.id
finally:
    db.close()

# Frank tries to claim the same phone
r = api.post(f"/api/clients/{c_other['id']}/phones", json={
    "phone": "+12075554444",
    "phone_type": "mobile",
    "is_primary": True,
})
check("POST /phones returns 200", r.status_code == 200)

db = fresh_session()
try:
    eve_conv = db.query(Conversation).filter(Conversation.id == eve_conv_id).first()
    check("conversation still owned by Eve (NOT stolen)",
          eve_conv.client_id == c_owner["id"],
          f"got client_id={eve_conv.client_id}, expected {c_owner['id']}")
finally:
    db.close()
print()


# ── 6. PATCH /clients/{id} with new phone also triggers backfill ──
print("6. PATCH /api/clients/{id} with a new phone triggers link-and-merge")
c6 = make_client("Grace Patch-Backfill")
db = fresh_session()
try:
    orphan = Conversation(
        channel="sms", client_id=None,
        external_contact="+12075555555",
        status="open",
    )
    db.add(orphan)
    db.commit()
    orphan_id = orphan.id
finally:
    db.close()

r = api.patch(f"/api/clients/{c6['id']}", json={"phone": "+12075555555"})
check("PATCH /clients returns 200", r.status_code == 200, f"got {r.status_code}")

db = fresh_session()
try:
    conv = db.query(Conversation).filter(Conversation.id == orphan_id).first()
    check("orphan linked after PATCH client.phone",
          conv.client_id == c6["id"],
          f"got client_id={conv.client_id}")

    # And a ContactPhone row should mirror the primary
    cp = db.query(ContactPhone).filter(
        ContactPhone.client_id == c6["id"],
        ContactPhone.phone == "+12075555555",
    ).first()
    check("primary phone mirrored into ContactPhone",
          cp is not None and cp.is_primary,
          f"cp={cp}")
finally:
    db.close()
print()


# ── 7. Placeholder-client absorption (now works!) ────────────────
print("7. Inbound SMS auto-creates placeholder client; later we add the")
print("   same phone to a real, named client → placeholder gets absorbed")
# Step A: simulate inbound SMS from unknown number → placeholder client
twilio_payload = {
    "From": "+12075556666",
    "To": "+18005550000",
    "Body": "Hi, asking about a quote for my Airbnb",
    "MessageSid": "SMtest_backwards_001",
}
r = api.post("/api/comms/twilio/webhook", data=twilio_payload)
check("Twilio webhook returns 200", r.status_code == 200, f"got {r.status_code}")

db = fresh_session()
try:
    placeholder = db.query(Client).filter(Client.phone == "+12075556666").first()
    check("placeholder client created", placeholder is not None,
          f"no client with phone +12075556666")
    placeholder_id = placeholder.id if placeholder else None
finally:
    db.close()

# Step B: user creates a REAL client and adds the same phone
c7 = make_client("Hank Real-Client")
r = api.post(f"/api/clients/{c7['id']}/phones", json={
    "phone": "+12075556666",
    "phone_type": "mobile",
    "is_primary": True,
})
check("POST /phones returns 200", r.status_code == 200)
# The response should include the absorption report
body = r.json()
check("response linked report shows absorption",
      body.get("linked", {}).get("absorbed_clients", 0) >= 1,
      f"linked={body.get('linked')}")

db = fresh_session()
try:
    convs_for_placeholder = db.query(Conversation).filter(
        Conversation.client_id == placeholder_id,
        Conversation.channel == "sms",
    ).all()
    convs_for_real = db.query(Conversation).filter(
        Conversation.client_id == c7["id"],
        Conversation.channel == "sms",
    ).all()

    # ASSERT new behavior — placeholder absorbed into real client:
    check("placeholder client deleted after absorption",
          db.query(Client).filter(Client.id == placeholder_id).first() is None)
    check("placeholder no longer owns any SMS conversation",
          len(convs_for_placeholder) == 0)
    check("real client now owns the SMS conversation",
          len(convs_for_real) >= 1,
          f"got {len(convs_for_real)} conversations")
finally:
    db.close()
print()


# ── 8. Direct unit test of _phone_tail (sanity) ───────────────────
print("8. _phone_tail sanity")
check("E.164 → last 10",      _phone_tail("+12075551234") == "2075551234")
check("formatted → last 10",   _phone_tail("(207) 555-1234") == "2075551234")
check("dotted → last 10",      _phone_tail("207.555.1234") == "2075551234")
check("short number passthru", _phone_tail("5551234") == "5551234")
check("None → None",           _phone_tail(None) is None)
check("empty → None",          _phone_tail("") is None)
print()


# ── Summary ────────────────────────────────────────────────────────
passed = sum(results)
total = len(results)
print(f"{'='*60}")
if passed == total:
    print(f"\033[92m  ALL {total} TESTS PASSED\033[0m")
else:
    print(f"\033[91m  {passed}/{total} tests passed ({total - passed} failed)\033[0m")
print(f"{'='*60}")
print("Note: XFAIL rows above document known gaps and don't count toward pass/fail.\n")

sys.exit(0 if passed == total else 1)
