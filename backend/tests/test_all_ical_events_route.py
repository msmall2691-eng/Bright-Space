"""Regression: /api/properties/all-ical-events must resolve to its static
handler, not be swallowed by the parametric /{property_id} route.

FastAPI matches routes in registration order. When all-ical-events was
declared after `@router.get("/{property_id}")`, requests hit the int-typed
property lookup first and 422'd before the new role/org gate could run —
the tightening added in the audit-quick-wins PR was silently a no-op.
"""
import os

import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")

from main import app


@pytest.fixture(autouse=True)
def _no_gcal_push():
    """Stub the Google Calendar write for THIS MODULE ONLY, and put it back.

    This file used to do `sys.modules.setdefault("integrations.google_calendar",
    MagicMock())` at import time, which does not stub anything — it replaces the
    module for the whole pytest process, permanently, for every test that
    imports it afterwards. Unittest's patch restores; sys.modules does not.

    It went unnoticed while the hand-maintained `testpaths` happened to collect
    the poisoning files late. Globbing tests/ changed the order, and a bare
    MagicMock's call result is a TRUTHY Mock rather than None — so the
    free/busy guard started reporting "0 conflicting event(s)" and refusing
    bookings, and unrelated files asserted on Mock objects. Fifteen tests in
    five files, none of them about Google Calendar.

    The real `create_event` already returns None when no credentials are
    configured, so this is belt-and-braces rather than load-bearing — but it is
    scoped, and it undoes itself.
    """
    with patch("integrations.google_calendar.create_event", return_value=None):
        yield


def test_all_ical_events_hits_static_handler_not_property_id_route():
    """The route must NOT return 422 (int coercion failure from the
    parametric `/{property_id}` handler). 401 is expected because the test
    client has no JWT / API key — which itself proves the request landed on
    a real handler that the auth middleware then blocked, not on FastAPI's
    422 body validation."""
    r = TestClient(app).get("/api/properties/all-ical-events")
    assert r.status_code != 422, (
        f"/all-ical-events was shadowed by /{{property_id}} — "
        f"status={r.status_code}, body={r.text}"
    )
