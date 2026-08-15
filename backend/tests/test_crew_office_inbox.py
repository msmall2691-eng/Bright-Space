"""Office crew inbox — the Messages page's Crew view.

What must hold:
- GET /api/crew/threads is office-only and lists one row per cleaner with the
  last-message preview + unread-from-cleaner count, newest activity first
  (threadless cleaners last, alphabetical).
- Opening a thread (office GET /messages/{user_id}) marks the cleaner's
  messages read, so the thread list and summary counts drop.
- POST /api/crew/messages/broadcast fans one message into each targeted
  cleaner's normal thread (default: every non-disabled cleaner; user_ids
  narrows it), is office-only, and rejects empty bodies.
- /api/comms/conversations/summary carries crew_unread_messages /
  crew_unread_threads so the Messages badge covers both inboxes in one poll.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import CrewMessage, User
from modules.auth.router import get_current_user, current_org_id


class _Cleaner:
    def __init__(self, uid, cleaner_id, name):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = name
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9950, 1, "admin", "active", True
    email = "admin@example.com"
    full_name = "The Office"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def crew_pair():
    """Two real cleaner rows (threads/broadcast query the users table) plus a
    disabled third that broadcast must skip."""
    tag = uuid.uuid4().hex[:6]
    users = [
        _Cleaner(9951, f"CT-oi-{tag}-a", "Alice Inbox"),
        _Cleaner(9952, f"CT-oi-{tag}-b", "Bob Inbox"),
    ]
    db = SessionLocal()
    for u in users:
        db.merge(User(id=u.id, email=u.email, full_name=u.full_name, role="cleaner",
                      cleaner_id=u.cleaner_id, org_id=1, password_hash="x"))
    db.merge(User(id=9953, email=f"cleaner-9953-{tag}@example.com", full_name="Zoe Disabled",
                  role="cleaner", cleaner_id=f"CT-oi-{tag}-z", org_id=1,
                  password_hash="x", status="disabled"))
    db.commit(); db.close()
    yield users
    _clear()
    db = SessionLocal()
    db.query(CrewMessage).filter(CrewMessage.user_id.in_([9951, 9952, 9953])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_([9951, 9952, 9953])).delete(synchronize_session=False)
    db.commit(); db.close()


def _rows_for(client, ids):
    return [r for r in client.get("/api/crew/threads").json() if r["user_id"] in ids]


def test_threads_list_unread_and_order(crew_pair):
    alice, bob = crew_pair
    try:
        # Alice writes first, Bob second → Bob's thread is newest.
        _as(alice).post("/api/crew/messages", json={"body": "Out of towels"})
        _clear()
        _as(bob).post("/api/crew/messages", json={"body": "Van won't start"})
        _clear()

        office = _as(_Admin())
        rows = _rows_for(office, {alice.id, bob.id, 9953})
        by_id = {r["user_id"]: r for r in rows}
        assert by_id[alice.id]["unread"] == 1
        assert by_id[alice.id]["last_message"]["body"] == "Out of towels"
        assert by_id[bob.id]["unread"] == 1
        # Newest activity first among threads with messages.
        assert [r["user_id"] for r in rows if r["last_activity"]] == [bob.id, alice.id]
        # The threadless (disabled) cleaner still appears, sorted after.
        assert by_id[9953]["last_message"] is None

        # Opening Alice's thread marks her messages read → unread drops to 0.
        office.get(f"/api/crew/messages/{alice.id}")
        by_id = {r["user_id"]: r for r in _rows_for(office, {alice.id, bob.id})}
        assert by_id[alice.id]["unread"] == 0
        assert by_id[bob.id]["unread"] == 1
    finally:
        _clear()


def test_threads_is_office_only(crew_pair):
    alice, _ = crew_pair
    try:
        assert _as(alice).get("/api/crew/threads").status_code == 403
    finally:
        _clear()


def test_broadcast_targets_and_gates(crew_pair):
    alice, bob = crew_pair
    try:
        office = _as(_Admin())
        # Empty body refused.
        assert office.post("/api/crew/messages/broadcast", json={"body": "   "}).status_code == 422

        # Default fan-out: every non-disabled cleaner — the disabled row is skipped.
        r = office.post("/api/crew/messages/broadcast", json={"body": "Park behind the shop"})
        assert r.status_code == 201
        sent_ids = set(r.json()["user_ids"])
        assert {alice.id, bob.id} <= sent_ids
        assert 9953 not in sent_ids

        # Narrowed fan-out: only Bob.
        r = office.post("/api/crew/messages/broadcast",
                        json={"body": "Bob — grab the tall ladder", "user_ids": [bob.id]})
        assert r.status_code == 201 and r.json() == {"sent": 1, "user_ids": [bob.id]}
        _clear()

        # Each copy is a normal office message in the cleaner's own thread.
        bodies = [m["body"] for m in _as(bob).get("/api/crew/messages").json()]
        assert bodies == ["Park behind the shop", "Bob — grab the tall ladder"]
        _clear()
        alice_bodies = [m["body"] for m in _as(alice).get("/api/crew/messages").json()]
        assert alice_bodies == ["Park behind the shop"]
        _clear()

        # Cleaners can't broadcast.
        assert _as(alice).post("/api/crew/messages/broadcast",
                               json={"body": "hi"}).status_code == 403
    finally:
        _clear()


def test_comms_summary_carries_crew_unread(crew_pair):
    alice, _ = crew_pair
    try:
        office = _as(_Admin())
        base = office.get("/api/comms/conversations/summary").json()
        assert "crew_unread_messages" in base and "crew_unread_threads" in base
        _clear()

        _as(alice).post("/api/crew/messages", json={"body": "Lockbox was empty"})
        _clear()

        office = _as(_Admin())
        after = office.get("/api/comms/conversations/summary").json()
        assert after["crew_unread_messages"] == base["crew_unread_messages"] + 1
        assert after["crew_unread_threads"] == base["crew_unread_threads"] + 1

        # Office reads the thread → both counts fall back to baseline.
        office.get(f"/api/crew/messages/{alice.id}")
        again = office.get("/api/comms/conversations/summary").json()
        assert again["crew_unread_messages"] == base["crew_unread_messages"]
        assert again["crew_unread_threads"] == base["crew_unread_threads"]
    finally:
        _clear()
