"""016 — add public_token to quotes.

Opaque token for the public (no-login) quote accept page link.

Revision ID: 016_quote_public_token
"""
from alembic import op
import sqlalchemy as sa

revision = "016_quote_public_token"
down_revision = "015_skip_sms_reminder"
branch_labels = None
depends_on = None


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def _has_index(bind, table, name) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return name in {ix["name"] for ix in insp.get_indexes(table)}


def upgrade():
    # Guarded: a from-scratch install's quotes table (built straight from
    # today's ORM models) already has public_token from the start.
    bind = op.get_bind()
    if not _has_column(bind, "quotes", "public_token"):
        op.add_column("quotes", sa.Column("public_token", sa.String(64), nullable=True))
    if not _has_index(bind, "quotes", "ix_quotes_public_token"):
        op.create_index("ix_quotes_public_token", "quotes", ["public_token"], unique=True)


def downgrade():
    op.drop_index("ix_quotes_public_token", table_name="quotes")
    op.drop_column("quotes", "public_token")
