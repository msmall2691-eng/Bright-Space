"""Per-category push-notification preferences (migration 094).

Opt-OUT model: NULL/missing key = category ON; only an explicit `false`
turns one off, so nobody's existing notifications go silent on deploy day.

  * GET  /api/push/preferences  — fresh user's full category map, all
    categories for their role, explicit true/false (never a guessed default).
  * PATCH /api/push/preferences — partial {category: bool} merge, 422 on an
    unknown or wrong-role category (office can't touch crew-only categories
    and vice versa).
  * services/push_service.notify_user / notify_staff actually skip a
    subscription whose owner has that category off — the real webpush send
    is mocked at `_send_one`, matching tests/test_crew_assignment_push.py's
    established seam.
"""
import uuid

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal, get_db
from database.models import PushSubscription, User
from modules.auth.router import get_current_user, current_org_id
from services import push_service


def _mk_user(ids_users, role, *, prefs=None):
    db = SessionLocal()
    u = User(email=f"np-{uuid.uuid4().hex[:10]}@example.com", role=role,
             org_id=1, status="active", active=True, full_name=f"Np {role}",
             cleaner_id=f"NP-{uuid.uuid4().hex[:8]}" if role == "cleaner" else None,
             notification_prefs=prefs)
    db.add(u); db.commit(); db.refresh(u)
    ids_users.append(u.id); uid = u.id; db.close()
    return uid


def _mk_sub(ids_subs, user_id, org_id=1):
    db = SessionLocal()
    s = PushSubscription(org_id=org_id, user_id=user_id,
                          endpoint=f"https://push.example/{uuid.uuid4().hex}",
                          p256dh="p256dh-key", auth="auth-key")
    db.add(s); db.commit(); db.refresh(s)
    ids_subs.append(s.id); sid = s.id; db.close()
    return sid


@pytest.fixture
def ids():
    made = {"users": [], "subs": []}
    yield made
    db = SessionLocal()
    db.query(PushSubscription).filter(PushSubscription.id.in_(made["subs"] or [0])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made["users"] or [0])).delete(synchronize_session=False)
    db.commit(); db.close()


def _as(user_id):
    """Override get_current_user the way the real dependency works — reading
    through the SAME cached `Depends(get_db)` session the route uses — so a
    PATCH that mutates the returned User and calls db.commit() actually
    persists, instead of mutating a detached object from a throwaway session."""
    def _override(db=Depends(get_db)):
        return db.query(User).filter(User.id == user_id).first()
    app.dependency_overrides[get_current_user] = _override
    app.dependency_overrides[current_org_id] = lambda: 1
    return TestClient(app)


def _clear():
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


@pytest.fixture
def sends(monkeypatch):
    """Capture actual webpush sends at the `_send_one` seam (below
    notify_user/notify_staff) so the gating logic under test — not the real
    network call — decides what fires."""
    sent = []

    def fake_send_one(subscription, payload, ttl=43200):
        sent.append({"endpoint": subscription["endpoint"], "payload": payload})
        return 200

    monkeypatch.setattr(push_service, "push_enabled", lambda: True)
    monkeypatch.setattr(push_service, "_send_one", fake_send_one)
    return sent


# ── GET defaults ──────────────────────────────────────────────────────────

def test_get_preferences_default_all_on_office(ids):
    uid = _mk_user(ids["users"], "admin")
    api = _as(uid)
    try:
        r = api.get("/api/push/preferences")
        assert r.status_code == 200
    finally:
        _clear()
    assert r.json() == {"requests": True, "messages": True, "quotes": True, "crew": True}


def test_get_preferences_default_all_on_crew(ids):
    uid = _mk_user(ids["users"], "cleaner")
    api = _as(uid)
    try:
        r = api.get("/api/push/preferences")
        assert r.status_code == 200
    finally:
        _clear()
    # open_jobs joined the set when posting a job started notifying the bench.
    # It defaults ON like the rest, and — because the gate is opt-OUT (a missing
    # key reads as true) — every existing crew member with prefs already stored
    # gets it without a migration or a re-consent.
    assert r.json() == {
        "job_assignments": True, "open_jobs": True, "office_messages": True,
        "time_off": True, "digest": True,
    }


# ── PATCH persists, GET reflects ────────────────────────────────────────────

def test_patch_persists_and_get_reflects(ids):
    uid = _mk_user(ids["users"], "manager")
    api = _as(uid)
    try:
        r = api.patch("/api/push/preferences", json={"quotes": False})
        assert r.status_code == 200
        assert r.json()["quotes"] is False
        assert r.json()["requests"] is True   # untouched categories stay on

        r2 = api.get("/api/push/preferences")
        assert r2.json() == {"requests": True, "messages": True, "quotes": False, "crew": True}

        # A second, different patch merges rather than clobbering the first.
        r3 = api.patch("/api/push/preferences", json={"crew": False})
        assert r3.json() == {"requests": True, "messages": True, "quotes": False, "crew": False}
    finally:
        _clear()


def test_patch_crew_persists(ids):
    uid = _mk_user(ids["users"], "cleaner")
    api = _as(uid)
    try:
        r = api.patch("/api/push/preferences", json={"digest": False})
        assert r.status_code == 200
        r2 = api.get("/api/push/preferences")
        assert r2.json()["digest"] is False
        assert r2.json()["job_assignments"] is True
    finally:
        _clear()


# ── Role validation ─────────────────────────────────────────────────────────

def test_patch_rejects_crew_category_for_office_role(ids):
    uid = _mk_user(ids["users"], "admin")
    api = _as(uid)
    try:
        r = api.patch("/api/push/preferences", json={"job_assignments": False})
    finally:
        _clear()
    assert r.status_code == 422


def test_patch_rejects_office_category_for_crew_role(ids):
    uid = _mk_user(ids["users"], "cleaner")
    api = _as(uid)
    try:
        r = api.patch("/api/push/preferences", json={"quotes": False})
    finally:
        _clear()
    assert r.status_code == 422


def test_patch_rejects_unknown_category(ids):
    uid = _mk_user(ids["users"], "admin")
    api = _as(uid)
    try:
        r = api.patch("/api/push/preferences", json={"not_a_real_category": False})
    finally:
        _clear()
    assert r.status_code == 422


# ── push_service gating: an opted-out category never fires ─────────────────

def test_notify_user_skips_when_category_off(ids, sends):
    uid = _mk_user(ids["users"], "cleaner", prefs={"job_assignments": False})
    _mk_sub(ids["subs"], uid)

    sent = push_service.notify_user(uid, "New job for you", "body",
                                     category="job_assignments")
    assert sent == 0
    assert sends == []

    # A category NOT turned off still sends.
    sent2 = push_service.notify_user(uid, "Your day at a glance", "body",
                                      category="digest")
    assert sent2 == 1
    assert len(sends) == 1


def test_notify_user_uncategorized_always_sends(ids, sends):
    uid = _mk_user(ids["users"], "cleaner", prefs={"job_assignments": False, "digest": False,
                                           "office_messages": False, "time_off": False})
    _mk_sub(ids["subs"], uid)
    sent = push_service.notify_user(uid, "BrightBase", "test push")   # category=None
    assert sent == 1


def test_notify_staff_skips_subscription_whose_owner_opted_out(ids, sends):
    on_uid = _mk_user(ids["users"], "admin")
    off_uid = _mk_user(ids["users"], "manager", prefs={"crew": False})
    _mk_sub(ids["subs"], on_uid)
    _mk_sub(ids["subs"], off_uid)

    sent = push_service.notify_staff(None, "Open job claimed", "body",
                                      org_id=1, category="crew")
    assert sent == 1
    assert len(sends) == 1


def test_notify_staff_uncategorized_ignores_prefs(ids, sends):
    off_uid = _mk_user(ids["users"], "admin", prefs={"requests": False, "messages": False,
                                             "quotes": False, "crew": False})
    _mk_sub(ids["subs"], off_uid)
    sent = push_service.notify_staff(None, "BrightBase", "test push", org_id=1)
    assert sent == 1
