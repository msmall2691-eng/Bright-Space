"""020 — capture customer quote responses (change request / decline).

Persist the customer's change-request message and decline reason/name on the
quote itself (previously only an activity-log line), so the owner can see and act
on the response.

Revision ID: 020_quote_response_capture
"""
from alembic import op
import sqlalchemy as sa

revision = "020_quote_response_capture"
down_revision = "019_property_custom_fields"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("quotes", sa.Column("requested_changes_message", sa.Text(), nullable=True))
    op.add_column("quotes", sa.Column("requested_changes_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("quotes", sa.Column("declined_reason", sa.Text(), nullable=True))
    op.add_column("quotes", sa.Column("declined_by_name", sa.String(length=255), nullable=True))


def downgrade():
    op.drop_column("quotes", "declined_by_name")
    op.drop_column("quotes", "declined_reason")
    op.drop_column("quotes", "requested_changes_at")
    op.drop_column("quotes", "requested_changes_message")
