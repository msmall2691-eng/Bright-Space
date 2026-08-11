"""GET /api/dispatch/employees is staff PII — cleaner/client logins must not
reach it. Before the fix it had no require_role, so only the global middleware
gated it and any authenticated principal could pull the full roster."""
import pytest
from fastapi.testclient import TestClient

from main import app
from modules.auth.router import get_current_user


class _Role:
    def __init__(self, role):
        self.id, self.org_id, self.role, self.status, self.active = 7501, 1, role, "active", True
        self.email = f"{role}@example.com"


@pytest.fixture
def api():
    yield TestClient(app)
    app.dependency_overrides.pop(get_current_user, None)


def test_roster_blocked_for_field_roles(api):
    for role in ("cleaner", "client"):
        app.dependency_overrides[get_current_user] = lambda r=role: _Role(r)
        resp = api.get("/api/dispatch/employees")
        assert resp.status_code == 403, f"{role} should be blocked from the employee roster"


def test_roster_allowed_for_internal_roles(api):
    # Internal roles pass the role gate. Connecteam isn't configured in tests,
    # so the call gets past auth and fails at the integration (503/502) — the
    # point is it is NOT a 403.
    app.dependency_overrides[get_current_user] = lambda: _Role("manager")
    resp = api.get("/api/dispatch/employees")
    assert resp.status_code != 403
