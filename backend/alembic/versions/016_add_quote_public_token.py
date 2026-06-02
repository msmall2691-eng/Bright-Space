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


def upgrade():
    op.add_column("quotes", sa.Column("public_token", sa.String(64), nullable=True))
    op.create_index("ix_quotes_public_token", "quotes", ["public_token"], unique=True)


def downgrade():
    op.drop_index("ix_quotes_public_token", table_name="quotes")
    op.drop_column("quotes", "public_token")
