"""Pins the July-2026 (July 12) audit's backend hardening fixes:

  #8a — PATCH/DELETE /api/fields/{id} and POST /api/quotes/requests/ had no
        require_role dependency, so any authenticated user (any role — a
        'cleaner' JWT included) could delete field definitions or create
        quote-request records reserved for staff.
  #8b — JWT_SECRET now fails closed at import time instead of minting a
        random per-process secret (which broke sessions unpredictably under
        --workers 4, since each worker got a DIFFERENT random secret).
  #8c — the AI-agent WebSocket now fails CLOSED, not open, when
        BRIGHTBASE_API_KEY is unset — matching auth.py's HTTP middleware.
"""
import importlib
import os
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient

import auth_jwt
from auth_jwt import create_jwt, SECRET_KEY, ALGORITHM
from database.db import SessionLocal
from database.models import User
from main import app

client = TestClient(app)


def _make_cleaner_user():
    db = SessionLocal()
    email = f"cleaner-{uuid.uuid4().hex[:8]}@example.com"
    user = User(email=email, role="cleaner", full_name="Test Cleaner", active=True, status="active")
    db.add(user)
    db.commit()
    db.refresh(user)
    db.close()
    return user


def _cleanup_user(user_id):
    db = SessionLocal()
    db.query(User).filter(User.id == user_id).delete(synchronize_session=False)
    db.commit()
    db.close()


# ── #8a: role gates on field-definitions PATCH/DELETE and quote-requests POST ──

def test_cleaner_role_cannot_patch_field_definition():
    user = _make_cleaner_user()
    try:
        token = create_jwt(user.id, user.email, user.role)
        r = client.patch(
            "/api/fields/999999",
            json={"name": "Hacked"},
            headers={"Authorization": f"Bearer {token}"},
        )
        # 403 (role rejected) is the fix under test; 404 (route reached, no
        # such field) would mean the role gate is STILL missing — either way
        # this must NOT be a 200/204.
        assert r.status_code == 403, r.text
    finally:
        _cleanup_user(user.id)


def test_cleaner_role_cannot_delete_field_definition():
    user = _make_cleaner_user()
    try:
        token = create_jwt(user.id, user.email, user.role)
        r = client.delete(
            "/api/fields/999999",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 403, r.text
    finally:
        _cleanup_user(user.id)


def test_cleaner_role_cannot_create_quote_request():
    user = _make_cleaner_user()
    try:
        token = create_jwt(user.id, user.email, user.role)
        r = client.post(
            "/api/quotes/requests/",
            json={"requester_name": "Someone", "service_type": "residential"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 403, r.text
    finally:
        _cleanup_user(user.id)


def test_quote_request_is_stamped_with_creator_org():
    """BB-MT-01: POST /api/quotes/requests/ had no org_id dependency at all
    (same class of gap as admin's CSV client import) — every staff-created
    quote request landed with org_id NULL and surfaced on every workspace's
    queue via the NULL-tolerant _org() filter."""
    from database.models import LeadIntake

    db = SessionLocal()
    email = f"admin-org-{uuid.uuid4().hex[:8]}@example.com"
    user = User(email=email, role="admin", full_name="Org Admin", active=True,
               status="active", org_id=31)
    db.add(user)
    db.commit()
    db.refresh(user)
    db.close()
    try:
        token = create_jwt(user.id, user.email, user.role)
        r = client.post(
            "/api/quotes/requests/",
            json={"requester_name": "Org Stamped Requester",
                 "requester_email": f"org-stamped-{uuid.uuid4().hex[:8]}@example.com",
                 "service_type": "residential"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 201, r.text
        db2 = SessionLocal()
        try:
            intake = db2.query(LeadIntake).filter(LeadIntake.id == r.json()["id"]).one()
            assert intake.org_id == 31
        finally:
            db2.query(LeadIntake).filter(LeadIntake.id == r.json()["id"]).delete(synchronize_session=False)
            db2.commit()
            db2.close()
    finally:
        _cleanup_user(user.id)


def test_admin_role_can_still_patch_field_definition():
    """Sanity check: the fix gates by ROLE, not by breaking the endpoint
    entirely — an admin JWT must still reach it (404 for a nonexistent id,
    not 403)."""
    db = SessionLocal()
    email = f"admin-{uuid.uuid4().hex[:8]}@example.com"
    user = User(email=email, role="admin", full_name="Test Admin", active=True, status="active")
    db.add(user)
    db.commit()
    db.refresh(user)
    db.close()
    try:
        token = create_jwt(user.id, user.email, user.role)
        r = client.patch(
            "/api/fields/999999",
            json={"name": "X"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 404, r.text
    finally:
        _cleanup_user(user.id)


# ── #8b: JWT_SECRET fails closed at import time ─────────────────────────────

def test_jwt_secret_unset_raises_at_import():
    """Reload auth_jwt with JWT_SECRET removed from the environment and
    confirm it raises instead of minting a random per-process secret (which
    used to cause random session invalidation under multi-worker uvicorn)."""
    saved = os.environ.pop("JWT_SECRET", None)
    try:
        with pytest.raises(RuntimeError, match="JWT_SECRET"):
            importlib.reload(auth_jwt)
    finally:
        if saved is not None:
            os.environ["JWT_SECRET"] = saved
        importlib.reload(auth_jwt)  # restore normal module state for other tests


# ── #8c: WS agent endpoint fails closed when BRIGHTBASE_API_KEY unset ──────

def test_ws_agent_rejects_connection_when_api_key_unset_and_no_jwt():
    saved = os.environ.pop("BRIGHTBASE_API_KEY", None)
    try:
        with pytest.raises(Exception):
            # starlette's TestClient raises on the server closing the
            # handshake with a non-1000 code before accept().
            with client.websocket_connect("/ws/agent/test-agent"):
                pass
    finally:
        if saved is not None:
            os.environ["BRIGHTBASE_API_KEY"] = saved


def test_ws_agent_accepts_valid_jwt_even_when_api_key_unset():
    """A valid JWT must still authenticate the WS connection — only the
    API-key fallback is unavailable when BRIGHTBASE_API_KEY is unset."""
    user = _make_cleaner_user()
    saved = os.environ.pop("BRIGHTBASE_API_KEY", None)
    try:
        token = create_jwt(user.id, user.email, user.role)
        # "test-agent" isn't a configured agent, so the handler accepts the
        # connection (auth passed) and then sends a normal "agent not found"
        # error over the open socket. That distinguishes it from an auth
        # rejection, which closes the socket with code 1008 BEFORE any
        # message is ever sent — a rejected connection here would raise
        # inside websocket_connect()/receive_json(), not hand back JSON.
        with client.websocket_connect(f"/ws/agent/test-agent?token={token}") as ws:
            msg = ws.receive_json()
            assert msg.get("type") == "error"
            assert "not found" in msg.get("content", "").lower()
    finally:
        if saved is not None:
            os.environ["BRIGHTBASE_API_KEY"] = saved
        _cleanup_user(user.id)
