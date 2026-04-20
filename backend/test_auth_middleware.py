#!/usr/bin/env python3
"""
Tests for backend/auth.py — APIKeyMiddleware behavior.

The bug we're guarding against:
    Starlette's BaseHTTPMiddleware.dispatch() runs BELOW FastAPI's exception
    handlers. So when the original code did `raise HTTPException(401, ...)`
    inside dispatch(), the exception escaped the stack as an unhandled error
    and the client saw a generic 500 — not the 401 we intended.

These tests assert that:
  - Public paths bypass auth entirely, even with no API key set.
  - When BRIGHTBASE_API_KEY is unset, all requests are allowed (dev mode).
  - When BRIGHTBASE_API_KEY is set, missing key → 401 (not 500).
  - When BRIGHTBASE_API_KEY is set, wrong key → 403 (not 500).
  - When BRIGHTBASE_API_KEY is set, right key → 200 (or whatever the route
    actually returns — never 401/403/500).
  - Both header (X-API-Key) and query param (api_key) are accepted, since
    the middleware supports the query-param form for WebSocket connections.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

# Make backend importable when run from project root or backend/
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from auth import APIKeyMiddleware, _is_public  # noqa: E402


# ──────────────────────────────────────────────────────────────────────
# A minimal Starlette app that exercises the middleware directly,
# so we don't have to spin up the whole BrightBase app + DB.
# ──────────────────────────────────────────────────────────────────────


async def _ok(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


def _make_app() -> Starlette:
    app = Starlette(routes=[
        Route("/api/health", _ok),         # public
        Route("/api/config", _ok),         # public
        Route("/api/jobs", _ok),           # gated
        Route("/api/properties", _ok),     # gated
        Route("/api/admin/foo", _ok),      # gated
        Route("/", _ok),                   # SPA root → public per _is_public
    ])
    app.add_middleware(APIKeyMiddleware)
    return app


# ──────────────────────────────────────────────────────────────────────
# _is_public unit tests — make sure the prefix list does what we think.
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path", [
    "/api/health",
    "/api/config",
    "/api/intake/submit",
    "/api/comms/twilio/webhook",
    "/api/booking",
    "/api/booking/anything",
    "/api/agents",
    "/ws/agent/foo",
    "/assets/main.js",
    "/",
    "/dashboard",
    "/clients/123",
])
def test_is_public_allows(path: str) -> None:
    assert _is_public(path) is True, f"{path!r} should be public"


@pytest.mark.parametrize("path", [
    "/api/jobs",
    "/api/clients",
    "/api/properties",
    "/api/admin/ical-sync-now",
    "/api/scheduling",
])
def test_is_public_rejects(path: str) -> None:
    assert _is_public(path) is False, f"{path!r} should require auth"


# ──────────────────────────────────────────────────────────────────────
# End-to-end tests through the middleware.
# ──────────────────────────────────────────────────────────────────────

def test_no_api_key_set_allows_everything():
    """Dev mode: BRIGHTBASE_API_KEY unset → all requests allowed."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": ""}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/jobs")
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}


def test_public_path_works_even_with_key_set():
    """Public paths never need auth, even when an API key is configured."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": "secret123"}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/health")
        assert r.status_code == 200, r.text


def test_missing_key_returns_401_not_500():
    """The bug: this used to be 500. Should be 401."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": "secret123"}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/jobs")
        assert r.status_code == 401, f"got {r.status_code}: {r.text}"
        assert "Missing API key" in r.text


def test_wrong_key_returns_403_not_500():
    """Wrong key should be 403, not 500."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": "secret123"}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/jobs", headers={"X-API-Key": "wrong-key"})
        assert r.status_code == 403, f"got {r.status_code}: {r.text}"
        assert "Invalid API key" in r.text


def test_correct_key_via_header_succeeds():
    """Right key in X-API-Key header → 200."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": "secret123"}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/jobs", headers={"X-API-Key": "secret123"})
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
        assert r.json() == {"ok": True}


def test_correct_key_via_query_param_succeeds():
    """Right key in ?api_key=... query param → 200 (used by WebSocket clients)."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": "secret123"}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/jobs?api_key=secret123")
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"


def test_wrong_query_param_returns_403():
    """Wrong key via query param → 403."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": "secret123"}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/jobs?api_key=nope")
        assert r.status_code == 403, f"got {r.status_code}: {r.text}"


def test_admin_route_requires_auth():
    """Specifically test the admin/ical-sync-now-style path that surfaced the bug in prod."""
    with patch.dict(os.environ, {"BRIGHTBASE_API_KEY": "secret123"}, clear=False):
        client = TestClient(_make_app())
        r = client.get("/api/admin/foo")
        # Before fix: 500. After fix: 401.
        assert r.status_code == 401, f"got {r.status_code}: {r.text}"


def test_uses_constant_time_comparison():
    """Sanity: secrets.compare_digest is used, not == (timing-attack defense)."""
    import auth as auth_module
    src = open(auth_module.__file__).read()
    assert "secrets.compare_digest" in src, (
        "auth.py should use secrets.compare_digest for the key check"
    )
    # And we're explicitly NOT using HTTPException any more, to avoid the
    # BaseHTTPMiddleware → 500 trap.
    assert "raise HTTPException" not in src, (
        "auth.py should return JSONResponse, not raise HTTPException, "
        "to avoid the BaseHTTPMiddleware → 500 issue."
    )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
