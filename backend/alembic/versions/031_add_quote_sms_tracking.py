"""
Alembic migration: Add quote SMS tracking
Alembic version: 031

Add new table to track quote SMS deliveries and status,
parallel to the existing quote_emails table for email tracking.
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "031_quote_sms_tracking"
down_revision = "030_backfill_opportunities"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "quote_sms",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("org_id", sa.Integer, sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("quote_id", sa.Integer, sa.ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("recipient_phone", sa.String(30), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("delivery_status", sa.String(50), nullable=False, server_default="sent"),
        sa.Column("message_sid", sa.String(64), nullable=True, unique=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_index("idx_quote_sms_quote_id", "quote_sms", ["quote_id"])
    op.create_index("idx_quote_sms_sent_at", "quote_sms", ["sent_at"])
    op.create_index("idx_quote_sms_status", "quote_sms", ["delivery_status"])
    op.create_index("idx_quote_sms_message_sid", "quote_sms", ["message_sid"], unique=True)


def downgrade() -> None:
    op.drop_table("quote_sms")
