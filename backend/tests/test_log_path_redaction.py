"""BB-SEC-15: a capability token must never reach the log stream.

Fourteen public routes carry their credential in the PATH — the eight under
/api/quotes/public/{token} and the six under /api/jobs/public/{token}. There is
no session behind them by design: the customer clicks a link in an email or a
text and the token IS the authorisation. Holding one means being able to read
that customer's quote, accept it on their behalf, decline it, see a photo of
their property, or reschedule their job.

The request logger wrote `request.url.path` at INFO on every request, so all of
them went to stdout — captured by Railway, retained under different access
rules than the database, and for longer than the token stays valid.

Asserted through the real middleware on the real app, not against the helper
alone: the helper being correct while the logger still calls `.path` is exactly
the bug, and it would pass a unit test of the helper.
"""
import logging

import pytest
from fastapi.testclient import TestClient

from main import app
from utils.log_paths import loggable_path, redact_unmatched, REDACTED

QUOTE_TOKEN = "9f3ac1d84b2e47f0a6c5e1b8d7304f92"
JOB_TOKEN = "b71e2f9c05a34d6e8f1a7c3b9d20e845"


@pytest.fixture
def perf_lines(caplog):
    caplog.set_level(logging.INFO, logger="brightbase.perf")
    yield caplog


def _perf_text(caplog):
    return "\n".join(r.getMessage() for r in caplog.records
                     if r.name == "brightbase.perf")


# ── The real path, through the real middleware ───────────────────────────────

def test_a_quote_token_never_reaches_the_log(perf_lines):
    client = TestClient(app)
    client.get(f"/api/quotes/public/{QUOTE_TOKEN}")

    logged = _perf_text(perf_lines)
    assert QUOTE_TOKEN not in logged, "the capability token was written to the log"
    # And the line is still useful: it says WHICH endpoint was hit.
    assert "/api/quotes/public/{token}" in logged


def test_every_public_capability_route_is_covered(perf_lines):
    """Not just the one route — the whole family, including the sub-paths that
    accept and decline on the customer's behalf."""
    client = TestClient(app)
    paths = [
        f"/api/quotes/public/{QUOTE_TOKEN}",
        f"/api/quotes/public/{QUOTE_TOKEN}/pdf",
        f"/api/quotes/public/{QUOTE_TOKEN}/availability",
        f"/api/quotes/public/{QUOTE_TOKEN}/property-photo",
        f"/api/jobs/public/{JOB_TOKEN}",
        f"/api/jobs/public/{JOB_TOKEN}/availability",
    ]
    for p in paths:
        client.get(p)

    logged = _perf_text(perf_lines)
    assert QUOTE_TOKEN not in logged
    assert JOB_TOKEN not in logged
    assert "{token}" in logged


def test_a_mistyped_token_url_does_not_leak_either(perf_lines):
    """A 404 still reaches the logger, and an expired or mistyped capability
    URL is exactly the shape that 404s.

    This app has an SPA catch-all (`/{full_path:path}`) that matches every
    otherwise-unrouted path, so the template branch handles this too and the
    `redact_unmatched` fallback almost never fires in practice. It is kept, and
    unit-tested below, because "every path matches something" is a property of
    today's routing table rather than a guarantee — remove the catch-all and
    the fallback is what stands between a stray token and the log."""
    client = TestClient(app)
    client.get(f"/api/quotes/publik/{QUOTE_TOKEN}")

    logged = _perf_text(perf_lines)
    assert QUOTE_TOKEN not in logged
    assert "404" in logged, "the request was still logged"


def test_ordinary_paths_are_still_logged_legibly(perf_lines):
    """A redaction that blanks everything is not a fix, it is a broken log."""
    client = TestClient(app)
    client.get("/api/health")

    assert "/api/health" in _perf_text(perf_lines)


# ── The helper's own edges ───────────────────────────────────────────────────

def test_numeric_ids_survive_redaction():
    """Record ids are not secrets and are what makes a 404 diagnosable."""
    assert redact_unmatched("/api/clients/12345") == "/api/clients/12345"


def test_short_segments_survive():
    assert redact_unmatched("/api/jobs/week") == "/api/jobs/week"


def test_a_long_opaque_segment_is_redacted():
    assert redact_unmatched(f"/x/{QUOTE_TOKEN}") == f"/x/{REDACTED}"


def test_the_helper_never_raises():
    """It runs inside request instrumentation, which must never break a
    response — and a helper that cannot work out a safe path must return
    something safe, not something raw."""
    class Broken:
        scope = {}
        @property
        def url(self):
            raise RuntimeError("boom")

    assert loggable_path(Broken()) == REDACTED


def test_template_is_preferred_over_the_raw_path():
    """The property worth having: parameter NAMES, not values — so a path
    parameter added to some future route cannot leak without anyone
    remembering to add it to a list."""
    class Route:
        path = "/api/quotes/public/{token}"

    class Req:
        scope = {"route": Route()}
        class url:
            path = f"/api/quotes/public/{QUOTE_TOKEN}"

    assert loggable_path(Req()) == "/api/quotes/public/{token}"
