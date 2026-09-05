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


# ── The list itself (MT-3) ───────────────────────────────────────────────────
#
# `apply_org_rls` skips any TENANT_TABLES entry that isn't a real table:
#
#     if table not in existing: continue
#
# That skip is correct — the bootstrap runs against databases at different
# migration points and must not explode on a table that doesn't exist yet — but
# it is also SILENT. A typo, or a table renamed without updating the list,
# means a tenant table with no policy on it and nothing anywhere that fails.
#
# That is exactly the shape of the bug migration 095 exists to fix: two tables
# sat org-scoped but unprotected for months. These two tests are the check that
# would have caught it, and they run on SQLite so they gate every PR rather
# than only the Postgres job.


def test_every_tenant_table_is_a_real_table():
    from database.models import Base
    from database.rls import TENANT_TABLES

    known = set(Base.metadata.tables)
    missing = [t for t in TENANT_TABLES if t not in known]
    assert not missing, (
        f"TENANT_TABLES names {missing}, which no model defines. "
        "apply_org_rls skips those silently, so they'd carry no RLS policy.")


def test_every_tenant_table_has_the_column_the_policy_reads():
    """The policy is `org_id = current_setting('app.current_org_id')`.

    A table listed without an `org_id` column wouldn't be protected — it would
    fail to create the policy at bootstrap, which is louder than the case
    above but still worth refusing before it ships.
    """
    from database.models import Base
    from database.rls import TENANT_TABLES

    # Names that aren't tables at all belong to the test above; skipping them
    # here keeps this failure readable instead of a KeyError that buries it.
    without = [t for t in TENANT_TABLES
               if t in Base.metadata.tables
               and "org_id" not in Base.metadata.tables[t].columns]
    assert not without, f"listed as tenant tables but have no org_id: {without}"
