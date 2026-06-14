"""028 — multi-tenancy MT-3: Postgres Row-Level Security backstop.

Enables RLS on every tenant table so a query that forgot its org filter (MT-2)
can't leak across tenants. Policy reads the per-transaction GUC
`app.current_org_id`, set by the current_org_id dependency on each scoped request:

    USING (org_id = current_setting('app.current_org_id', true)::int
           OR current_setting('app.current_org_id', true) IS NULL)

The `true` (missing_ok) second arg means: when the GUC is NOT set — background
jobs (scheduler, gcal sync), migrations, psql — the policy is a NO-OP (sees all
rows), so nothing breaks. When a request HAS set it (every MT-2 endpoint), rows
are filtered to that org even if the handler's own filter was missing. FORCE is
used so the table owner (the app's DB role on Railway) is also subject to it.

POSTGRES-ONLY: SQLite (CI/tests) has no RLS, so the whole migration no-ops there.
That means RLS is validated on a Railway preview/prod DB, not in CI.

Revision ID: 028_tenant_rls
"""
from alembic import op
import sqlalchemy as sa

revision = "028_tenant_rls"
down_revision = "027_tenant_org_id"
branch_labels = None
depends_on = None

# Same set as migration 027 (every table that gained org_id).
TABLES = [
    "clients", "properties", "property_icals", "ical_events", "recurring_schedules",
    "recurrence_exceptions", "jobs", "visits", "lead_intakes", "invoices",
    "conversations", "messages", "opportunities", "contact_emails", "contact_phones",
    "activities", "quotes", "quote_requests", "quote_emails", "cleaner_time_off",
    "integration_events",
]

_POLICY = "bb_org_isolation"
_USING = (
    "org_id = current_setting('app.current_org_id', true)::int "
    "OR current_setting('app.current_org_id', true) IS NULL"
)


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # RLS is Postgres-only; SQLite/CI no-ops.
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())
    for table in TABLES:
        if table not in existing:
            continue
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE "{table}" FORCE ROW LEVEL SECURITY')
        op.execute(f'DROP POLICY IF EXISTS {_POLICY} ON "{table}"')
        op.execute(
            f'CREATE POLICY {_POLICY} ON "{table}" '
            f'USING ({_USING}) WITH CHECK ({_USING})'
        )


def downgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())
    for table in TABLES:
        if table not in existing:
            continue
        op.execute(f'DROP POLICY IF EXISTS {_POLICY} ON "{table}"')
        op.execute(f'ALTER TABLE "{table}" NO FORCE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY')
