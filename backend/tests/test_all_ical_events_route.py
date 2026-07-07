"""Regression: /api/properties/all-ical-events must resolve to its static
handler, not be swallowed by the parametric /{property_id} route.

FastAPI matches routes in registration order. When all-ical-events was
declared after `@router.get("/{property_id}")`, requests hit the int-typed
property lookup first and 422'd before the new role/org gate could run —
the tightening added in the audit-quick-wins PR was silently a no-op.
"""
import os
import sys
from unittest.mock import MagicMock

# Avoid importing google client at test-time.
sys.modules.setdefault("integrations.google_calendar", MagicMock())

from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")

from main import app


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
