"""
Alembic migration: Add quote email tracking
Alembic version: 014

Add new table to track quote email deliveries and status
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '014_quote_email_tracking'
down_revision = '013_quotes_system'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create quote_emails table for tracking email deliveries
    op.create_table(
        'quote_emails',
        sa.Column('id', sa.String(36), nullable=False),
        sa.Column('quote_id', sa.String(36), nullable=False),
        sa.Column('recipient_email', sa.String(255), nullable=False),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('delivery_status', sa.String(50), nullable=False, server_default='sent'),
        sa.Column('email_id', sa.String(255), nullable=True),  # Resend email ID
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['quote_id'], ['quotes.id'], ondelete='CASCADE'),
    )

    # Add indexes for common queries
    op.create_index('idx_quote_emails_quote_id', 'quote_emails', ['quote_id'])
    op.create_index('idx_quote_emails_sent_at', 'quote_emails', ['sent_at'])
    op.create_index('idx_quote_emails_status', 'quote_emails', ['delivery_status'])
    op.create_index('idx_quote_emails_email_id', 'quote_emails', ['email_id'], unique=True)

    # Add check constraint for valid delivery statuses
    op.create_check_constraint(
        'quote_emails_valid_status',
        'quote_emails',
        "delivery_status IN ('sent', 'delivered', 'bounced', 'complained', 'failed')"
    )


def downgrade() -> None:
    # Remove the table
    op.drop_table('quote_emails')
