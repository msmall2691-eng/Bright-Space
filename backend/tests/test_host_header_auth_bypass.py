"""BB-SEC-16: a poisoned Host header must not bypass the auth middleware.

Starlette < 0.47.2 (we ship 0.38.6) rebuilds `request.url` from the Host header
without validating it — CVE-2026-48710. A request line of

    GET /api/clients HTTP/1.1
    Host: victim/abc?x=

reconstructs to `http://victim/abc?x=/api/clients`, whose parsed `.path` is
`/abc`. The ROUTER still dispatches on the real `/api/clients` and runs that
handler — but APIKeyMiddleware used to gate on `request.url.path`, saw `/abc`,
decided it was a non-/api/ SPA route, and skipped auth. Result: the protected
handler ran unauthenticated.

The fix reads `scope["path"]` — the path the router itself dispatched on — so
the auth decision and the routing decision cannot disagree.

Driven at the raw ASGI layer on purpose. TestClient sends a well-formed Host
and would never reproduce this; the whole point is a Host the transport would
normally reject, so the app must not depend on the transport to reject it.
"""
import asyncio

import pytest

from main import app

PROTECTED = "/api/clients"


def _asgi_get(path: str, host: str, *, api_key_env: str):
    """Call the real app with a chosen raw path and Host header. Returns
    (status, body_bytes)."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "server": ("testserver", 80),
        "client": ("9.9.9.9", 5555),
        "headers": [(b"host", host.encode())],
    }
    out = {"status": None, "chunks": []}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.start":
            out["status"] = msg["status"]
        elif msg["type"] == "http.response.body":
            out["chunks"].append(msg.get("body", b""))

    asyncio.get_event_loop().run_until_complete(app(scope, receive, send))
    return out["status"], b"".join(out["chunks"])


@pytest.fixture
def api_key(monkeypatch):
    """A configured master key makes the bypass maximally dangerous: the
    skipped-auth request would otherwise 401 on the missing key. With it set,
    a successful bypass reaches a handler as the synthetic admin."""
    monkeypatch.setenv("BRIGHTBASE_API_KEY", "test-master-key-BB-SEC-16")
    yield


def test_an_honest_host_on_a_protected_route_is_rejected(api_key):
    """Control: without a credential, the protected route is 401. If this ever
    stops holding, the bypass test below proves nothing."""
    status, _ = _asgi_get(PROTECTED, "testserver", api_key_env="test-master-key-BB-SEC-16")
    assert status == 401, "protected route was reachable without auth even with an honest Host"


def test_a_poisoned_host_does_not_bypass_auth(api_key):
    """The exploit. A Host that poisons request.url.path must still be gated on
    the real routed path — same 401 as the honest request, not a 200."""
    status, body = _asgi_get(
        PROTECTED, "testserver/abc?x=", api_key_env="test-master-key-BB-SEC-16"
    )
    assert status == 401, (
        f"AUTH BYPASS: poisoned Host reached {PROTECTED} and returned {status} "
        f"({body[:120]!r})"
    )


def test_several_poisoning_shapes_are_all_gated(api_key):
    """`/`, `?` and `#` all move the path boundary during re-parse. None may
    open a protected route."""
    for host in ("testserver/x", "testserver/a?b=", "testserver#/y", "testserver/api/apply"):
        status, _ = _asgi_get(PROTECTED, host, api_key_env="test-master-key-BB-SEC-16")
        assert status == 401, f"poisoned Host {host!r} bypassed auth ({status})"


def test_a_genuinely_public_route_still_opens():
    """The fix must not over-correct into blocking real public traffic. The
    apply form is public by exact match and has no Host trickery."""
    status, _ = _asgi_get("/api/apply", "testserver", api_key_env="")
    # 405 (GET on a POST route) or 422 — anything but 401 proves the middleware
    # let it through to the handler rather than gating it.
    assert status != 401, "a public route was wrongly gated"
