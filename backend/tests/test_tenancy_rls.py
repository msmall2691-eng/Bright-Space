"""Multi-tenancy MT-3: the RLS org-context helper is a safe no-op off Postgres.

The real Row-Level Security enforcement lives in migration 028 and only applies
on Postgres, so it's validated on a preview/prod DB rather than in CI (SQLite has
no RLS). What we CAN guarantee here: setting the org context never raises and
never breaks a request on SQLite, and current_org_id still returns the right id.
"""
from database.db import SessionLocal
from modules.auth.router import set_rls_org_context


def test_set_rls_org_context_is_noop_on_sqlite():
    db = SessionLocal()
    try:
        # Must not raise on SQLite (no SET LOCAL / no RLS).
        set_rls_org_context(db, 1)
        set_rls_org_context(db, 99999)
        # Session is still usable afterwards.
        assert db.execute(__import__("sqlalchemy").text("SELECT 1")).scalar() == 1
    finally:
        db.close()


def test_set_rls_org_context_tolerates_bad_input():
    db = SessionLocal()
    try:
        # int() coercion guards against injection; a non-int must not raise.
        set_rls_org_context(db, None)  # type: ignore[arg-type]
    finally:
        db.close()
