"""schema-guardian — the structural invariants a machine can hold.

The full authoring-time checklist lives in the `schema-guardian` skill (money is
float dollars, calendar days are Date, FK columns get an index, …). Most of it
needs human judgement. This file pins the ones that are mechanically checkable —
right now, the one that has actually bitten.

**Every table that carries org_id must be registered for Row-Level Security.**
Migration 095 exists precisely because two tables carried org_id for *months*
with no RLS backstop on Postgres — listed nowhere, silently unprotected. Being
absent from `TENANT_TABLES` isn't a style nit; it's a tenant-isolation hole that
CI stays green through. This test fails the moment a new org_id table is added
without being registered (or explicitly exempted with a reason).
"""
import database.models  # noqa: F401 — importing populates Base.metadata
from database.base import Base
from database.rls import TENANT_TABLES

# Tables that carry org_id but are deliberately NOT under RLS. Each MUST have a
# reason here — an unexplained entry defeats the whole guardrail.
RLS_EXEMPT_ORG_TABLES = {
    # Auth resolves the user BEFORE any org context exists — the login/lookup
    # query runs with app.current_org_id unset, so an RLS policy on users would
    # block sign-in. Deliberately unscoped; see migration 095's docstring.
    # Revisit if users ever gets an org-scoped access path.
    "users",
}


def test_every_org_id_table_is_registered_for_rls():
    org_tables = {t.name for t in Base.metadata.tables.values() if "org_id" in t.columns}
    unregistered = org_tables - set(TENANT_TABLES) - RLS_EXEMPT_ORG_TABLES
    assert not unregistered, (
        "These tables carry org_id but are not in database/rls.py TENANT_TABLES, "
        "so they have NO Postgres RLS backstop (the migration-095 trap). Add each "
        "to TENANT_TABLES and call apply_org_rls for it in the SAME migration that "
        "creates the table — or, if it is intentionally unscoped, add it to "
        f"RLS_EXEMPT_ORG_TABLES above WITH a reason. Offenders: {sorted(unregistered)}"
    )


def test_tenant_tables_have_no_stale_entries():
    """A TENANT_TABLES entry that names no real table protects nothing —
    apply_org_rls skips tables that don't exist, so a typo or a rename silently
    drops a table's RLS. Keep the list honest."""
    stale = set(TENANT_TABLES) - set(Base.metadata.tables)
    assert not stale, (
        "TENANT_TABLES entries with no matching table (typo or rename?) — each "
        f"silently protects nothing: {sorted(stale)}"
    )
