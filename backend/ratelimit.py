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
from slowapi.util import get_remote_address

_storage_uri = os.getenv("RATELIMIT_STORAGE_URI", "memory://")

limiter = Limiter(
    key_func=get_remote_address,
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


def rate_limit(max_requests: int, window_seconds: int, scope: str = ""):
    """FastAPI dependency factory: at most ``max_requests`` per ``window_seconds``
    per client IP (bucketed per ``scope`` so endpoints don't share a budget)."""
    def _dep(request: Request):
        ip = request.client.host if request.client else "anon"
        key = (scope, ip)
        now = time.monotonic()
        dq = _hits[key]
        cutoff = now - window_seconds
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if len(dq) >= max_requests:
            raise HTTPException(status_code=429, detail="Too many requests — please slow down and try again shortly.")
        dq.append(now)
    return _dep
