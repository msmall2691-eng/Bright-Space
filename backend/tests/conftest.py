"""Shared fixtures for the tests/ package.

Two pieces of glue these (older) tests need against the current app:

1. Schema: it now comes from Alembic in production, so SQLAlchemy's create_all
   no longer runs at startup. Create it once per session on the shared engine.

2. Auth: the API-key middleware now fails closed (security PR #193), so
   TestClient requests with no credentials get 401. We set a test API key and
   inject it on every TestClient request (scoped to this package via an autouse
   fixture, so the root auth-middleware tests that exercise the 401 path are
   unaffected).
"""
import os

os.environ.setdefault("BRIGHTBASE_API_KEY", "test-api-key")

import pytest

from database.db import engine, SessionLocal
from database.models import Base, Org


@pytest.fixture(scope="session", autouse=True)
def _ensure_schema():
    Base.metadata.create_all(bind=engine)
    # In production this row comes from migration 030b's data seed, which
    # create_all() (schema only, no data) never runs. Dozens of tests
    # hardcode org_id=1 on Client/User/etc rows, relying on that seed having
    # happened — on Postgres the org_id FK enforces it and every one of
    # those inserts fails; SQLite doesn't enforce the FK so it went unnoticed.
    db = SessionLocal()
    try:
        if not db.query(Org).filter(Org.id == 1).first():
            db.add(Org(id=1, name="Maine Cleaning Co", slug="maine-cleaning-co"))
            db.commit()
    finally:
        db.close()
    yield


@pytest.fixture(autouse=True)
def _inject_api_key(monkeypatch):
    """Make TestClient requests carry the API key so the fail-closed middleware
    accepts them. Patches the request method (not __init__), so module-level
    TestClient(app) instances are fine — only the runtime calls are affected."""
    import starlette.testclient as tc
    key = os.environ["BRIGHTBASE_API_KEY"]
    orig = tc.TestClient.request

    def patched(self, method, url, *args, **kwargs):
        headers = dict(kwargs.pop("headers", None) or {})
        headers.setdefault("x-api-key", key)
        return orig(self, method, url, *args, headers=headers, **kwargs)

    monkeypatch.setattr(tc.TestClient, "request", patched)
    yield
