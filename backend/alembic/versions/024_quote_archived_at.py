"""024 — add quotes.archived_at for soft-delete.

Additive nullable column: archived quotes are hidden from lists but recoverable,
and their linked jobs/emails are preserved. Safe + idempotent across dialects.

Revision ID: 024_quote_archived_at
"""
from alembic import op
import sqlalchemy as sa

revision = "024_quote_archived_at"
down_revision = "023_quotes_valid_until_date"
branch_labels = None
depends_on = None


def _has_column(bind, table, column) -> bool:
    return column in {c["name"] for c in sa.inspect(bind).get_columns(table)}


def upgrade():
    bind = op.get_bind()
    if not _has_column(bind, "quotes", "archived_at"):
        op.add_column("quotes", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    bind = op.get_bind()
    if _has_column(bind, "quotes", "archived_at"):
        op.drop_column("quotes", "archived_at")
