"""029 — saved views (Twenty-style per-user list presets).

Adds the `saved_views` table: a named bundle of a list page's
filters/sort/columns/layout (`config` JSON), scoped per-user AND per-workspace
(org_id), so each member curates their own views in isolation.

As a new tenant table it also joins the MT-3 Row-Level Security backstop
(Postgres-only, same policy as migration 028) so a query that forgot its org
filter still can't leak across workspaces. Idempotent + dialect-guarded.

Revision ID: 029_saved_views
"""
from alembic import op
import sqlalchemy as sa

revision = "029_saved_views"
down_revision = "028_tenant_rls"
branch_labels = None
depends_on = None

_POLICY = "bb_org_isolation"
_USING = (
    "org_id = current_setting('app.current_org_id', true)::int "
    "OR current_setting('app.current_org_id', true) IS NULL"
)


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "saved_views" not in set(insp.get_table_names()):
        op.create_table(
            "saved_views",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("org_id", sa.Integer(), nullable=False),
            sa.Column("entity_type", sa.String(length=40), nullable=False),
            sa.Column("name", sa.String(length=120), nullable=False),
            sa.Column("config", sa.JSON(), nullable=False),
            sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_saved_views_user_id", "saved_views", ["user_id"])
        op.create_index("ix_saved_views_org_id", "saved_views", ["org_id"])
        op.create_index("ix_saved_views_entity_type", "saved_views", ["entity_type"])

    # MT-3: extend the RLS backstop to this new tenant table (Postgres-only).
    if bind.dialect.name == "postgresql":
        op.execute('ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY')
        op.execute('ALTER TABLE "saved_views" FORCE ROW LEVEL SECURITY')
        op.execute(f'DROP POLICY IF EXISTS {_POLICY} ON "saved_views"')
        op.execute(
            f'CREATE POLICY {_POLICY} ON "saved_views" '
            f'USING ({_USING}) WITH CHECK ({_USING})'
        )


def downgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if bind.dialect.name == "postgresql":
        op.execute(f'DROP POLICY IF EXISTS {_POLICY} ON "saved_views"')
    if "saved_views" in set(insp.get_table_names()):
        op.drop_index("ix_saved_views_entity_type", table_name="saved_views")
        op.drop_index("ix_saved_views_org_id", table_name="saved_views")
        op.drop_index("ix_saved_views_user_id", table_name="saved_views")
        op.drop_table("saved_views")
