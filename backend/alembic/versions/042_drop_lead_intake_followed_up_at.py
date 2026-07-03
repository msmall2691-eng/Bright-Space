"""042 — drop dead lead_intakes.followed_up_at column.

Writable via the PATCH endpoint and echoed back by GET, but nothing on
the frontend either sends or displays it. Grep for the field name only
hits the generated types.ts/openapi.json — no page or component reads
or writes it. Same argument as migration 041's dead-columns batch:
if it's write-only from the app's perspective, it's not being used.

Downgrade re-adds the column nullable, so a rollback restores the
schema without needing a backfill.

Revision ID: 042_drop_lead_intake_followed_up_at
"""
from alembic import op
import sqlalchemy as sa

revision = "042_drop_lead_intake_followed_up_at"
down_revision = "041_drop_dead_columns"
branch_labels = None
depends_on = None


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade():
    bind = op.get_bind()
    if _has_column(bind, "lead_intakes", "followed_up_at"):
        op.drop_column("lead_intakes", "followed_up_at")


def downgrade():
    bind = op.get_bind()
    if not _has_column(bind, "lead_intakes", "followed_up_at"):
        op.add_column("lead_intakes", sa.Column("followed_up_at", sa.DateTime(), nullable=True))
