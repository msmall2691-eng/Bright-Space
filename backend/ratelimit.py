"""
BB-OPS-01: rate-limiter instance shared across routers.

Endpoints import `limiter` and decorate handlers with @limiter.limit(...), or
attach `rate_limit(...)` as a dependency. Both keep their counters in the
worker process that served the request, which is why every cap declared in this
app is divided by the worker count before it is enforced — see WORKERS below.

The old note here said in-memory storage was "fine for Railway's
single-container deploy, switch to Redis if we ever scale to multiple
instances." That was the wrong axis. It is not instances, it is worker
PROCESSES, and the container has run four of them since the 502 fix
(Dockerfile: --workers ${UVICORN_WORKERS:-4}). Four independent counters meant
every cap was silently ~4x looser than the number written next to it: probing
production showed /api/auth/login, declared 5/minute, taking about twenty
before it refused, and which worker a request landed on decided whether it was
refused at all.
"""
import logging
import os
import re
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request
from slowapi import Limiter

_storage_uri = os.getenv("RATELIMIT_STORAGE_URI", "memory://")

# ---------------------------------------------------------------------------
# Per-worker caps.
#
# uvicorn runs N worker processes and the kernel hands each incoming connection
# to whichever one is ready, so a client's requests are spread across all of
# them. Neither limiter shares state between processes, so a cap of 5 is really
# 5 PER WORKER — N times what it says.
#
# The honest fix is shared storage (Redis), and RATELIMIT_STORAGE_URI is here
# for the day that exists. Until then the caps are divided so the number in the
# router is what a caller actually gets.
#
# WORKERS is read from the same env var uvicorn is given, and the start command
# exports the resolved value so both see one number. Unset means one process —
# local dev, and the test suite, which never runs uvicorn at all.
def _worker_count() -> int:
    """How many processes are sharing these caps.

    Falls back to 1 on anything unparseable instead of raising. This runs at
    import, so a typo in a Railway variable would otherwise take the container
    down with a ValueError from inside the rate limiter — and uvicorn would
    reject the same value itself a moment later with a message that actually
    names the problem. Under-dividing is the wrong direction, so it says so in
    the log rather than passing silently.
    """
    raw = os.getenv("UVICORN_WORKERS")
    if not raw:
        return 1
    try:
        return max(1, int(raw))
    except ValueError:
        logging.getLogger(__name__).warning(
            "UVICORN_WORKERS=%r is not a number; rate-limit caps will not be "
            "divided and are effectively per-worker.", raw)
        return 1


WORKERS = _worker_count()


def per_worker(limit: int) -> int:
    """Divide a declared cap into the per-process share that enforces it.

    Rounded UP, deliberately. Rounding down would enforce 5/minute as
    floor(5/4)=1 per worker, so a person who mistypes their password once could
    be refused the second try — and unevenly, since it depends which worker
    took the request. Rounding up costs at most WORKERS-1 requests above the
    declared cap in the worst case (8/minute instead of 5, rather than 20), and
    never refuses somebody who stayed inside the number they were told.
    """
    return max(1, -(-limit // WORKERS))


def _scale_limit_string(value: str) -> str:
    """Apply per_worker() to a slowapi limit string ("5/minute", "10/hour").

    Applied by the Limiter subclass below so the ~10 existing
    @limiter.limit("N/unit") call sites scale without being touched — and so a
    new one cannot be added that quietly skips the division.
    """
    out = []
    for part in value.split(";"):
        m = re.match(r"^\s*(\d+)(.*)$", part)
        out.append(f"{per_worker(int(m.group(1)))}{m.group(2)}" if m else part)
    return ";".join(out)


class _PerWorkerLimiter(Limiter):
    """slowapi's Limiter with every declared cap divided by the worker count."""

    def limit(self, limit_value, *args, **kwargs):
        if isinstance(limit_value, str):
            limit_value = _scale_limit_string(limit_value)
        return super().limit(limit_value, *args, **kwargs)



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


limiter = _PerWorkerLimiter(
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
    per client IP (bucketed per ``scope`` so endpoints don't share a budget).

    ``max_requests`` is the cap across the whole service; ``_hits`` lives in one
    worker, so what each process enforces is its share of it (see per_worker).
    """
    per_process = per_worker(max_requests)

    def _dep(request: Request):
        key = (scope, client_ip(request))
        now = time.monotonic()
        dq = _hits[key]
        cutoff = now - window_seconds
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if len(dq) >= per_process:
            raise HTTPException(status_code=429, detail="Too many requests — please slow down and try again shortly.")
        dq.append(now)

        global _since_sweep
        _since_sweep += 1
        if _since_sweep >= _SWEEP_EVERY:
            _since_sweep = 0
            _sweep(now)
    return _dep
