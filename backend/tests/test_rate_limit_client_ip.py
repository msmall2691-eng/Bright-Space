"""Per-IP limits have to be charged to an address the caller cannot choose.

Every rate limit in the app keyed off `request.client.host`. The container runs
with `--forwarded-allow-ips="*"` because Railway's proxy address is not fixed,
and in uvicorn 0.30 that sets `always_trust`, whereupon
ProxyHeadersMiddleware.get_trusted_client_host returns
`x_forwarded_for_hosts[0]` — the LEFTMOST entry, which is whatever the caller
put in the header.

So the key was attacker-chosen. A fresh `X-Forwarded-For` per request reset the
bucket on /api/apply, /api/intake/submit, every public quote and booking route,
and on /api/auth/login — turning a 5/minute cap into an unmetered online
password guess.

The fix charges the LAST entry, the one the trusted proxy appended. That is
correct whether Railway appends to a caller-supplied header or replaces it, and
it does not depend on knowing a proxy CIDR that Railway does not publish.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from ratelimit import client_ip

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    """Reset both limiters around each test.

    Resetting rather than loosening: the tests below deliberately exhaust the
    real production limit, and a cap raised for the test run would make that
    meaningless.
    """
    from ratelimit import _hits, limiter

    def _reset():
        try:
            limiter.reset()
        except Exception:
            pass
        _hits.clear()

    _reset()
    yield
    _reset()


class _Req:
    """Minimal stand-in — client_ip only reads headers and .client."""
    def __init__(self, xff=None, host="10.0.0.9"):
        self.headers = {"x-forwarded-for": xff} if xff is not None else {}
        self.client = type("C", (), {"host": host})() if host else None


# ── which end of the header we charge ───────────────────────────────────────

def test_the_last_entry_wins_because_the_proxy_appended_it():
    # Railway appends the real peer to whatever arrived. Everything to the left
    # of it is caller-authored and worthless.
    assert client_ip(_Req("1.2.3.4, 203.0.113.7")) == "203.0.113.7"
    assert client_ip(_Req("evil, evil, evil, 203.0.113.7")) == "203.0.113.7"


def test_a_single_entry_works_too_in_case_the_proxy_replaces():
    # If Railway overwrites rather than appends there is one entry, and it is
    # the real one. Taking the last is right under both behaviours, which is
    # the reason it is keyed this way.
    assert client_ip(_Req("203.0.113.7")) == "203.0.113.7"


def test_it_falls_back_to_the_socket_without_the_header():
    assert client_ip(_Req(None, host="198.51.100.4")) == "198.51.100.4"
    assert client_ip(_Req("", host="198.51.100.4")) == "198.51.100.4"
    assert client_ip(_Req("   ", host="198.51.100.4")) == "198.51.100.4"


def test_no_header_and_no_socket_is_still_a_key_not_a_crash():
    assert client_ip(_Req(None, host=None)) == "anon"


# ── the bypass itself, end to end ───────────────────────────────────────────

def _apply(spoof, real="203.0.113.7"):
    """POST the public application form, spoofing the leftmost XFF entry."""
    return client.post(
        "/api/apply",
        json={"name": "Spoof Test", "email": f"spoof-{uuid.uuid4().hex[:8]}@example.com"},
        headers={"x-forwarded-for": f"{spoof}, {real}"},
    )


def test_a_fresh_forwarded_for_no_longer_buys_a_fresh_bucket():
    """The whole finding, in one test.

    /api/apply is 10/hour. Every request below comes from the same real client
    but claims a different leftmost address — which is exactly what an attacker
    sends, and what used to work. The eleventh must be refused.
    """
    codes = [_apply(f"10.9.9.{i}").status_code for i in range(11)]
    assert codes[:10] == [201] * 10, codes
    assert codes[10] == 429, f"a spoofed header still bought a fresh bucket: {codes}"


def test_a_genuinely_different_client_still_gets_its_own_bucket():
    """The control. Refusing everyone once one caller is noisy would be a
    different bug, and a worse one on shared rural connections."""
    for i in range(10):
        assert _apply(f"10.9.9.{i}", real="203.0.113.7").status_code == 201
    assert _apply("10.9.9.99", real="203.0.113.7").status_code == 429
    # Same spoofed prefix, genuinely different peer — unaffected.
    assert _apply("10.9.9.99", real="198.51.100.22").status_code == 201


# ── the endpoint that spent tokens for free ─────────────────────────────────

def test_the_crew_ask_endpoint_is_metered(monkeypatch):
    """It had no limit at all.

    Every other endpoint that spends Anthropic tokens is capped
    (modules/ai/router.py: 30/3600 and 12/3600). This one was reachable by any
    cleaner account — including one approved minutes earlier, before a single
    document is on file — and could be looped against the company's API key.
    The prompt hygiene is sound, so this was a cost problem rather than a data
    one, which is the kind nobody notices until the bill.
    """
    from modules.auth.router import current_org_id, get_current_user

    class _Cleaner:
        id, org_id, role, status, active = 9977, 1, "cleaner", "active", True
        email, full_name, cleaner_id = "ask@example.com", "Asker", "CT-ASK"

    class _Msg:
        content = [type("B", (), {"text": "Sure."})()]

    class _Fake:
        class messages:
            @staticmethod
            def create(**kw):
                return _Msg()

    monkeypatch.setattr("modules.ai.router._anthropic_client", lambda: _Fake())
    app.dependency_overrides[get_current_user] = lambda: _Cleaner()
    app.dependency_overrides[current_org_id] = lambda: 1
    try:
        codes = []
        for _ in range(21):
            r = client.post("/api/crew/ask", json={"question": "where am I today?"},
                            headers={"x-forwarded-for": "1.1.1.1, 203.0.113.55"})
            codes.append(r.status_code)
        assert codes[-1] == 429, f"still unmetered: {codes}"
        assert 429 not in codes[:20], f"cut off too early: {codes}"
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(current_org_id, None)
