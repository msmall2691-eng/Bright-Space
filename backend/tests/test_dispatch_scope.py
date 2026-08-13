"""GET /api/dispatch/employees is staff PII — cleaner/client logins must not
reach it. Before the fix it had no require_role, so only the global middleware
gated it and any authenticated principal could pull the full roster.

Native as of the Connecteam removal: the endpoint reads cleaner users from OUR
database (keyed by crew ID, the value assignment writes into Job.cleaner_ids)
instead of Connecteam's employee list — so the roster tests seed Users."""
import uuid

import pytest
from fastapi.testclient import TestClient

from main import app
from database.db import SessionLocal
from database.models import User
from modules.auth.router import get_current_user, current_org_id


class _Role:
    def __init__(self, role):
        self.id, self.org_id, self.role, self.status, self.active = 7501, 1, role, "active", True
        self.email = f"{role}@example.com"


@pytest.fixture
def api():
    app.dependency_overrides[current_org_id] = lambda: 1
    yield TestClient(app)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def _mk_cleaner(db, **kw):
    defaults = dict(
        email=f"disp-{uuid.uuid4().hex[:8]}@example.com",
        role="cleaner", status="active", active=True, org_id=1,
        auth_provider="password",
    )
    defaults.update(kw)
    u = User(**defaults)
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_roster_blocked_for_field_roles(api):
    for role in ("cleaner", "client"):
        app.dependency_overrides[get_current_user] = lambda r=role: _Role(r)
        resp = api.get("/api/dispatch/employees")
        assert resp.status_code == 403, f"{role} should be blocked from the employee roster"


def test_roster_is_native_cleaner_users(api):
    """Internal roles get the native roster: cleaner users with a crew ID, id ==
    cleaner_id (the assignable value). No crew ID, deactivated, or disabled →
    not assignable → not listed."""
    db = SessionLocal()
    listed = _mk_cleaner(db, full_name="Dispatch Native", cleaner_id=f"CT-{uuid.uuid4().hex[:6]}")
    no_id = _mk_cleaner(db, full_name="No Crew Id", cleaner_id=None)
    inactive = _mk_cleaner(db, full_name="Off Roster", cleaner_id=f"CT-{uuid.uuid4().hex[:6]}",
                           active=False, status="disabled")
    ids = [listed.id, no_id.id, inactive.id]
    try:
        app.dependency_overrides[get_current_user] = lambda: _Role("manager")
        resp = api.get("/api/dispatch/employees")
        assert resp.status_code == 200, resp.text
        rows = {r["id"]: r for r in resp.json()}
        assert listed.cleaner_id in rows
        assert rows[listed.cleaner_id]["name"] == "Dispatch Native"
        assert rows[listed.cleaner_id]["user_id"] == listed.id
        assert inactive.cleaner_id not in rows
        assert all(r["id"] for r in rows.values())   # never an empty/undefined id
    finally:
        db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
        db.commit(); db.close()
