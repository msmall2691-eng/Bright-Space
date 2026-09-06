"""A cap of 5 has to mean 5, not 5 in each of four processes.

uvicorn runs `--workers ${UVICORN_WORKERS:-4}` and the kernel hands each
connection to whichever worker is ready, so one client's requests spread across
all of them. Neither limiter shares state between processes, so every declared
cap was really that many PER WORKER.

Probing production after #770 shipped: 30 failed logins against
/api/auth/login, declared 5/minute, produced seven 429s — the first at attempt
14, then 401s again, then alternating. Not a bypass (the header fix held), but
the number in the router was about a quarter of what it claimed, and which
worker took the request decided whether it was refused at all.

Fixed by dividing each cap by the worker count. Pinned below: the divisor, the
rounding direction, and — the part that matters to a person rather than a bot —
that a caller who stays inside the DECLARED number is never refused.

These tests set `ratelimit.WORKERS` directly rather than re-importing the
module. Reloading it swaps out `_hits` and `limiter` while main.py's routers
still hold the originals, which silently breaks the sibling test file.
"""
import pytest
from fastapi import HTTPException

import ratelimit


class _Req:
    """Same caller every time: one real peer behind the proxy."""
    headers = {"x-forwarded-for": "1.2.3.4, 203.0.113.9"}
    client = type("C", (), {"host": "10.0.0.1"})()


# ── reading the divisor from the environment ────────────────────────────────

def test_no_env_var_means_one_process(monkeypatch):
    """Local dev and the test suite never run uvicorn, so nothing is divided.

    Also why the sibling file can still exhaust real caps: those assertions
    would be measuring the divisor, not the limit, if this were not 1.
    """
    monkeypatch.delenv("UVICORN_WORKERS", raising=False)
    assert ratelimit._worker_count() == 1
    assert ratelimit.WORKERS == 1, "the suite must run undivided"


def test_the_production_worker_count_is_read(monkeypatch):
    monkeypatch.setenv("UVICORN_WORKERS", "4")
    assert ratelimit._worker_count() == 4


def test_a_junk_value_falls_back_to_one_rather_than_crashing_the_app(monkeypatch):
    """This runs at import.

    An unparseable value used to raise ValueError from inside the rate limiter
    and take the container down before anything logged a reason — and uvicorn
    would reject the same value moments later with a message that actually
    names the problem.
    """
    for bad in ("", "auto", "four", "0", "-3"):
        monkeypatch.setenv("UVICORN_WORKERS", bad)
        assert ratelimit._worker_count() == 1, bad


# ── the rounding direction, which is the user-facing decision ───────────────

def test_rounding_up_protects_the_caller_who_stayed_inside_the_number(monkeypatch):
    """5/minute over 4 workers rounds to 2, not 1.

    Rounding down gives floor(5/4)=1, so a person who mistypes their password
    once could be refused the second attempt — unevenly, depending which worker
    answered. Rounding up costs at most WORKERS-1 above the declared cap in the
    worst case (8/minute instead of 5, rather than the ~20 it was).
    """
    monkeypatch.setattr(ratelimit, "WORKERS", 4)
    assert ratelimit.per_worker(5) == 2                 # login, portal-link
    assert ratelimit.per_worker(10) == 3                # /api/apply
    assert ratelimit.per_worker(120) == 30

    for declared in (5, 10, 12, 20, 30, 60, 120):
        per = ratelimit.per_worker(declared)
        assert per >= 1
        # Never stricter than declared, and never more than one worker's share
        # looser — the whole point of the change.
        assert declared <= per * 4 < declared + 4


def test_a_cap_smaller_than_the_worker_count_never_becomes_zero(monkeypatch):
    monkeypatch.setattr(ratelimit, "WORKERS", 8)
    assert ratelimit.per_worker(1) == 1
    assert ratelimit.per_worker(5) == 1


def test_one_worker_divides_nothing(monkeypatch):
    monkeypatch.setattr(ratelimit, "WORKERS", 1)
    assert [ratelimit.per_worker(n) for n in (1, 5, 10, 120)] == [1, 5, 10, 120]


# ── both limiters, not just the one I remembered ────────────────────────────

def test_the_slowapi_decorator_strings_are_scaled_too(monkeypatch):
    """The ten @limiter.limit("N/unit") sites scale without being edited.

    Done inside the Limiter subclass on purpose: a call site added later cannot
    quietly skip the division by forgetting to wrap its number.
    """
    monkeypatch.setattr(ratelimit, "WORKERS", 4)
    assert ratelimit._scale_limit_string("5/minute") == "2/minute"
    assert ratelimit._scale_limit_string("30/hour") == "8/hour"
    assert ratelimit._scale_limit_string("120/hour;10/minute") == "30/hour;3/minute"
    assert isinstance(ratelimit.limiter, ratelimit._PerWorkerLimiter)


def test_an_unparseable_limit_string_is_passed_through_untouched(monkeypatch):
    # Better slowapi's own error than a mangled string it half-accepts.
    monkeypatch.setattr(ratelimit, "WORKERS", 4)
    assert ratelimit._scale_limit_string("per minute") == "per minute"


def test_the_dependency_limiter_enforces_the_divided_cap(monkeypatch):
    """End to end: one worker holding a 20-request cap refuses at 5."""
    monkeypatch.setattr(ratelimit, "WORKERS", 4)
    dep = ratelimit.rate_limit(20, 3600, "probe_divided")
    try:
        for _ in range(5):
            dep(_Req())
        with pytest.raises(HTTPException) as e:
            dep(_Req())
        assert e.value.status_code == 429
    finally:
        ratelimit._hits.pop(("probe_divided", "203.0.113.9"), None)


def test_the_same_cap_undivided_takes_all_twenty(monkeypatch):
    """The control. Without it the test above passes on a limiter that simply
    refuses at 5 for some unrelated reason."""
    monkeypatch.setattr(ratelimit, "WORKERS", 1)
    dep = ratelimit.rate_limit(20, 3600, "probe_undivided")
    try:
        for _ in range(20):
            dep(_Req())
        with pytest.raises(HTTPException):
            dep(_Req())
    finally:
        ratelimit._hits.pop(("probe_undivided", "203.0.113.9"), None)


def test_the_cap_is_fixed_when_the_dependency_is_built(monkeypatch):
    """Routers build these at import, so the division happens once, not per
    request — a hot path shouldn't redo arithmetic that cannot change."""
    monkeypatch.setattr(ratelimit, "WORKERS", 4)
    dep = ratelimit.rate_limit(20, 3600, "probe_frozen")
    monkeypatch.setattr(ratelimit, "WORKERS", 1)   # as if re-read later
    try:
        for _ in range(5):
            dep(_Req())
        with pytest.raises(HTTPException):
            dep(_Req())
    finally:
        ratelimit._hits.pop(("probe_frozen", "203.0.113.9"), None)
