"""Postgres Row-Level Security for multi-tenant isolation (MT-3).

Shared by Alembic migration 028 (the upgrade path for existing DBs) and the
fresh-DB bootstrap (scripts/db_bootstrap.py), so both apply byte-identical
policies. No-op on non-Postgres (SQLite has no RLS).

Policy: every tenant table only exposes rows for the request's org, read from
the per-transaction GUC `app.current_org_id` (set by the current_org_id
dependency). When the GUC is unset — background jobs, migrations, psql — the
policy is a no-op (sees all rows), so nothing breaks. FORCE makes even the
table owner subject to it.
"""
import sqlalchemy as sa

# Every table that carries org_id (migration 027) plus saved_views (029).
TENANT_TABLES = [
    "clients", "properties", "property_icals", "ical_events", "recurring_schedules",
    "recurrence_exceptions", "jobs", "lead_intakes", "invoices",
    "conversations", "messages", "opportunities", "contact_emails", "contact_phones",
    "activities", "quotes", "cleaner_time_off",
    "integration_events", "saved_views",
]

POLICY = "bb_org_isolation"
USING = (
    "org_id = current_setting('app.current_org_id', true)::int "
    "OR current_setting('app.current_org_id', true) IS NULL"
)


def apply_org_rls(bind, tables=None):
    """Enable + FORCE RLS and (re)create the org-isolation policy on each tenant
    table that exists. Idempotent. No-op off Postgres."""
    if bind.dialect.name != "postgresql":
        return
    existing = set(sa.inspect(bind).get_table_names())
    for table in (tables or TENANT_TABLES):
        if table not in existing:
            continue
        bind.exec_driver_sql(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        bind.exec_driver_sql(f'ALTER TABLE "{table}" FORCE ROW LEVEL SECURITY')
        bind.exec_driver_sql(f'DROP POLICY IF EXISTS {POLICY} ON "{table}"')
        bind.exec_driver_sql(
            f'CREATE POLICY {POLICY} ON "{table}" USING ({USING}) WITH CHECK ({USING})'
        )


def drop_org_rls(bind, tables=None):
    """Reverse apply_org_rls. Idempotent. No-op off Postgres."""
    if bind.dialect.name != "postgresql":
        return
    existing = set(sa.inspect(bind).get_table_names())
    for table in (tables or TENANT_TABLES):
        if table not in existing:
            continue
        bind.exec_driver_sql(f'DROP POLICY IF EXISTS {POLICY} ON "{table}"')
        bind.exec_driver_sql(f'ALTER TABLE "{table}" NO FORCE ROW LEVEL SECURITY')
        bind.exec_driver_sql(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY')
