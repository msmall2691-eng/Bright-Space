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

from database.rls import apply_org_rls, drop_org_rls, POLICY, USING, TENANT_TABLES

revision = "028_tenant_rls"
down_revision = "027_tenant_org_id"
branch_labels = None
depends_on = None

# Back-compat aliases (the RLS validation test reads these from this module).
TABLES = TENANT_TABLES
_POLICY = POLICY
_USING = USING


def upgrade():
    # Idempotent + Postgres-only; skips tables that don't exist yet at this point
    # in history (e.g. saved_views, added in 029).
    apply_org_rls(op.get_bind())


def downgrade():
    drop_org_rls(op.get_bind())
