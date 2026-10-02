"""Crew-to-crew chat — a cleaner messaging another cleaner directly.

What must hold:
- POST /api/crew/chat/{peer_id} sends; the thread reads back oldest-first from
  either side with a correct `mine` flag; loading a thread marks the peer's
  messages to the caller read.
- GET /api/crew/chat/peers lists the OTHER cleaners (never self, never a
  disabled account), name only — no email, no phone — newest conversation
  first, with an unread-from-them count.
- my-day carries unread_peer_messages so the Team tab can badge in one fetch.
- A non-cleaner (office) can't use the crew chat endpoints (403); an unknown,
  non-cleaner, or cross-org peer id is 404 (never 403 — reveals nothing); you
  can't open a thread with yourself.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import CrewPeerMessage, User
from modules.auth.router import get_current_user, current_org_id


class _Cleaner:
    def __init__(self, uid, cleaner_id, name):
        self.id, self.org_id, self.role, self.status, self.active = uid, 1, "cleaner", "active", True
        self.email = f"cleaner-{uid}@example.com"
        self.full_name = name
        self.cleaner_id = cleaner_id


class _Admin:
    id, org_id, role, status, active = 9970, 1, "admin", "active", True
    email = "admin-peer@example.com"
    full_name = "The Office"
    cleaner_id = None


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


IDS = [9961, 9962, 9963, 9964]


@pytest.fixture
def crew():
    """Alice + Bob (chat partners), a disabled cleaner, and a cross-org cleaner
    (org 2) that must be invisible as a peer."""
    tag = uuid.uuid4().hex[:6]
    alice = _Cleaner(9961, f"CT-pc-{tag}-a", "Alice Peer")
    bob = _Cleaner(9962, f"CT-pc-{tag}-b", "Bob Peer")
    db = SessionLocal()
    for u in (alice, bob):
        db.merge(User(id=u.id, email=u.email, full_name=u.full_name, role="cleaner",
                      cleaner_id=u.cleaner_id, org_id=1, password_hash="x"))
    db.merge(User(id=9963, email=f"cleaner-9963-{tag}@example.com", full_name="Zoe Disabled",
                  role="cleaner", cleaner_id=f"CT-pc-{tag}-z", org_id=1,
                  password_hash="x", status="disabled"))
    db.merge(User(id=9964, email=f"cleaner-9964-{tag}@example.com", full_name="Otto Otherorg",
                  role="cleaner", cleaner_id=f"CT-pc-{tag}-o", org_id=2, password_hash="x"))
    db.commit(); db.close()
    yield alice, bob
    _clear()
    db = SessionLocal()
    db.query(CrewPeerMessage).filter(
        CrewPeerMessage.from_user_id.in_(IDS) | CrewPeerMessage.to_user_id.in_(IDS)
    ).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(IDS)).delete(synchronize_session=False)
    db.commit(); db.close()


def test_send_read_and_mine_flag(crew):
    alice, bob = crew
    try:
        r = _as(alice).post(f"/api/crew/chat/{bob.id}", json={"body": "Can you cover Friday?"})
        assert r.status_code == 201 and r.json()["mine"] is True
        _clear()
        r = _as(bob).post(f"/api/crew/chat/{alice.id}", json={"body": "Yep, I've got it"})
        assert r.status_code == 201
        _clear()

        # Bob reads the pair thread: both messages, oldest first, correct side.
        thread = _as(bob).get(f"/api/crew/chat/{alice.id}").json()
        assert [(m["body"], m["mine"]) for m in thread] == [
            ("Can you cover Friday?", False),   # Alice → Bob
            ("Yep, I've got it", True),         # Bob → Alice
        ]
    finally:
        _clear()


def test_load_marks_read_and_badges(crew):
    alice, bob = crew
    try:
        _as(alice).post(f"/api/crew/chat/{bob.id}", json={"body": "grab my caddy"})
        _clear()

        # Bob's peers list shows Alice with one unread; my-day badge shows 1.
        bob_c = _as(bob)
        peers = {p["user_id"]: p for p in bob_c.get("/api/crew/chat/peers").json()}
        assert peers[alice.id]["unread"] == 1
        assert peers[alice.id]["name"] == "Alice Peer"
        # Name only — nothing identifying beyond the display name.
        assert "email" not in peers[alice.id] and "phone" not in peers[alice.id]
        # Inbox-style preview of the newest message; mine=False because Alice
        # sent it (from Bob's point of view).
        assert peers[alice.id]["last_message"] == {"mine": False, "preview": "grab my caddy"}
        assert bob_c.get("/api/crew/my-day").json()["unread_peer_messages"] == 1

        # Opening the thread clears it.
        bob_c.get(f"/api/crew/chat/{alice.id}")
        peers = {p["user_id"]: p for p in bob_c.get("/api/crew/chat/peers").json()}
        assert peers[alice.id]["unread"] == 0
        assert bob_c.get("/api/crew/my-day").json()["unread_peer_messages"] == 0
    finally:
        _clear()


def test_peers_excludes_self_disabled_and_other_org(crew):
    alice, bob = crew
    try:
        ids = {p["user_id"] for p in _as(alice).get("/api/crew/chat/peers").json()}
        assert bob.id in ids            # a real teammate shows
        assert alice.id not in ids      # never yourself
        assert 9963 not in ids          # disabled cleaner hidden
        assert 9964 not in ids          # cross-org cleaner hidden
    finally:
        _clear()


def test_bad_peer_ids_are_404_and_office_is_403(crew):
    alice, _ = crew
    try:
        a = _as(alice)
        assert a.get(f"/api/crew/chat/{alice.id}").status_code == 404   # self
        assert a.get("/api/crew/chat/9964").status_code == 404          # cross-org
        assert a.get(f"/api/crew/chat/{_Admin.id}").status_code == 404  # not a cleaner
        assert a.get("/api/crew/chat/424242").status_code == 404        # unknown
        assert a.post("/api/crew/chat/9964", json={"body": "hi"}).status_code == 404
        _clear()
        # The office is not a crew chat participant.
        office = _as(_Admin())
        assert office.get("/api/crew/chat/peers").status_code == 403
        assert office.get(f"/api/crew/chat/{alice.id}").status_code == 403
    finally:
        _clear()


def test_empty_body_refused(crew):
    alice, bob = crew
    try:
        assert _as(alice).post(f"/api/crew/chat/{bob.id}",
                               json={"body": "   "}).status_code == 422
    finally:
        _clear()
