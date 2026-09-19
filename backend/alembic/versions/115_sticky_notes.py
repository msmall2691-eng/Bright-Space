"""115 — sticky notes (per-user Home-dashboard notes).

Adds the `sticky_notes` table: a member's pinned Home notes, scoped per-user AND
per-workspace (org_id), so each person's notes follow them across devices
instead of living in one browser's localStorage.

As a new tenant table it joins the MT-3 Row-Level Security backstop
(Postgres-only, same policy as migration 028/029) so a query that forgot its org
filter still can't leak across workspaces. Idempotent + dialect-guarded.

Revision ID: 115_sticky_notes
"""
from alembic import op
import sqlalchemy as sa

revision = "115_sticky_notes"
down_revision = "114_invoice_public_token"
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
    if "sticky_notes" not in set(insp.get_table_names()):
        op.create_table(
            "sticky_notes",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("org_id", sa.Integer(), nullable=False),
            sa.Column("body", sa.Text(), nullable=False, server_default=""),
            sa.Column("color", sa.String(length=16), nullable=False, server_default="amber"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_sticky_notes_user_id", "sticky_notes", ["user_id"])
        op.create_index("ix_sticky_notes_org_id", "sticky_notes", ["org_id"])

    # MT-3: extend the RLS backstop to this new tenant table (Postgres-only).
    if bind.dialect.name == "postgresql":
        op.execute('ALTER TABLE "sticky_notes" ENABLE ROW LEVEL SECURITY')
        op.execute('ALTER TABLE "sticky_notes" FORCE ROW LEVEL SECURITY')
        op.execute(f'DROP POLICY IF EXISTS {_POLICY} ON "sticky_notes"')
        op.execute(
            f'CREATE POLICY {_POLICY} ON "sticky_notes" '
            f'USING ({_USING}) WITH CHECK ({_USING})'
        )


def downgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if bind.dialect.name == "postgresql":
        op.execute(f'DROP POLICY IF EXISTS {_POLICY} ON "sticky_notes"')
    if "sticky_notes" in set(insp.get_table_names()):
        op.drop_index("ix_sticky_notes_org_id", table_name="sticky_notes")
        op.drop_index("ix_sticky_notes_user_id", table_name="sticky_notes")
        op.drop_table("sticky_notes")
