"""
BB-OPS-01: rate-limiter instance shared across routers.

Endpoints import `limiter` and decorate handlers with @limiter.limit(...).
The limiter uses in-memory storage by default — fine for Railway's
single-container deploy. If the service ever scales to multiple instances,
switch to Redis: Limiter(key_func=..., storage_uri="redis://...")
"""
import os
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request
from slowapi import Limiter

_storage_uri = os.getenv("RATELIMIT_STORAGE_URI", "memory://")


def client_ip(request: Request) -> str:
    """The address to charge a request to — the LAST X-Forwarded-For entry.

    BB-SEC: every per-IP limit here was bypassable with one header.

    The app runs with `--forwarded-allow-ips="*"` (Dockerfile/railway.json)
    because Railway's proxy address is not fixed. In uvicorn 0.30's
    ProxyHeadersMiddleware that sets `always_trust`, and the client host then
    becomes `x_forwarded_for_hosts[0]` — the LEFTMOST entry, which is whatever
    the caller sent. So `request.client.host`, and therefore both limiters
    below, were attacker-controlled: a fresh `X-Forwarded-For` per request
    reset the bucket on /api/apply, /api/intake/submit, every public quote and
    booking route, and — worst — /api/auth/login, turning a 5/minute cap into
    an unmetered online password guess.

    The last entry is the one the trusted proxy appended, so it is the address
    that actually reached Railway. Taking it is correct whether Railway appends
    to a caller-supplied header (chain: forged…, real) or replaces it (single:
    real) — which is why this is keyed off the last entry rather than pinning a
    proxy CIDR that Railway does not publish and could change.

    Falls back to the socket address when there is no header at all (local dev,
    tests, a direct hit that bypassed the proxy).
    """
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        last = xff.split(",")[-1].strip()
        if last:
            return last
    return request.client.host if request.client else "anon"


limiter = Limiter(
    key_func=client_ip,
    storage_uri=_storage_uri,
    default_limits=[],
)


# ---------------------------------------------------------------------------
# Dependency-based per-IP limiter.
#
# slowapi's @limiter.limit decorator requires a `Request` param on the handler
# and raises if invoked without one — incompatible with endpoints that are also
# unit-tested by direct function calls (the public quote endpoints). This sliding
# -window limiter attaches via `dependencies=[Depends(rate_limit(...))]`, so it
# only runs on real HTTP requests and leaves handler signatures untouched.
# In-memory (per-process) — fine for Railway's single container.
# ---------------------------------------------------------------------------
_hits: "dict[tuple, deque]" = defaultdict(deque)

# `_hits` had no eviction: every distinct key it ever saw kept an entry, in
# every worker, for the life of the process. A slow leak on its own — and an
# unbounded one while the key was forgeable, since each spoofed address minted
# a fresh bucket that nothing would ever revisit to prune.
#
# A bucket is only pruned when its own key is hit again, so keys that go quiet
# are exactly the ones that never clean themselves up. Hence an occasional
# sweep rather than per-call bookkeeping: O(keys) every _SWEEP_EVERY requests
# instead of on every one.
_MAX_IDLE_SECONDS = 3600        # the widest window any caller uses today
_SWEEP_EVERY = 500
_since_sweep = 0


def _sweep(now: float) -> None:
    dead = [k for k, dq in _hits.items()
            if not dq or now - dq[-1] > _MAX_IDLE_SECONDS]
    for k in dead:
        _hits.pop(k, None)


def rate_limit(max_requests: int, window_seconds: int, scope: str = ""):
    """FastAPI dependency factory: at most ``max_requests`` per ``window_seconds``
    per client IP (bucketed per ``scope`` so endpoints don't share a budget)."""
    def _dep(request: Request):
        key = (scope, client_ip(request))
        now = time.monotonic()
        dq = _hits[key]
        cutoff = now - window_seconds
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if len(dq) >= max_requests:
            raise HTTPException(status_code=429, detail="Too many requests — please slow down and try again shortly.")
        dq.append(now)

        global _since_sweep
        _since_sweep += 1
        if _since_sweep >= _SWEEP_EVERY:
            _since_sweep = 0
            _sweep(now)
    return _dep
