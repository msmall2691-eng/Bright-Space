"""Add quotes system tables.

Revision ID: 013_quotes_system
Revises: 012_add_property_profiles
Create Date: 2026-05-26 15:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '013_quotes_system'
down_revision = '012_add_property_profiles'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create quotes table
    op.create_table(
        'quotes',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.func.gen_random_uuid()),
        sa.Column('quote_number', sa.String(50), nullable=False),
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('property_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('title', sa.String(255), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('subtotal', sa.Numeric(precision=12, scale=2), nullable=False, server_default='0'),
        sa.Column('tax_amount', sa.Numeric(precision=12, scale=2), nullable=False, server_default='0'),
        sa.Column('discount_amount', sa.Numeric(precision=12, scale=2), nullable=False, server_default='0'),
        sa.Column('total_amount', sa.Numeric(precision=12, scale=2), nullable=False, server_default='0'),
        sa.Column('status', sa.String(50), nullable=False, server_default='draft'),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('viewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('declined_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('preferred_day', sa.Integer(), nullable=True),
        sa.Column('preferred_time', sa.String(50), nullable=True),
        sa.Column('signature_data', postgresql.JSON(), nullable=True),
        sa.Column('accepted_by_name', sa.String(255), nullable=True),
        sa.Column('accepted_by_email', sa.String(255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('workspace_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.CheckConstraint("status IN ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'archived')", name='check_quote_status'),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['workspace_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('quote_number', name='uq_quote_number')
    )
    op.create_index('idx_quotes_client_id', 'quotes', ['client_id'])
    op.create_index('idx_quotes_property_id', 'quotes', ['property_id'])
    op.create_index('idx_quotes_status', 'quotes', ['status'])
    op.create_index('idx_quotes_created_by', 'quotes', ['created_by'])
    op.create_index('idx_quotes_workspace_id', 'quotes', ['workspace_id'])
    op.create_index('idx_quotes_created_at', 'quotes', ['created_at'], postgresql_order_by='created_at DESC')

    # Create quote_line_items table
    op.create_table(
        'quote_line_items',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.func.gen_random_uuid()),
        sa.Column('quote_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('description', sa.String(500), nullable=False),
        sa.Column('service_type', sa.String(100), nullable=True),
        sa.Column('quantity', sa.Numeric(precision=10, scale=2), nullable=False, server_default='1'),
        sa.Column('unit', sa.String(50), nullable=True),
        sa.Column('unit_price', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('line_total', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('display_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['quote_id'], ['quotes.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('idx_quote_line_items_quote_id', 'quote_line_items', ['quote_id'])
    op.create_index('idx_quote_line_items_display_order', 'quote_line_items', ['quote_id', 'display_order'])

    # Create quote_requests table
    op.create_table(
        'quote_requests',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.func.gen_random_uuid()),
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('requester_name', sa.String(255), nullable=False),
        sa.Column('requester_email', sa.String(255), nullable=False),
        sa.Column('requester_phone', sa.String(20), nullable=True),
        sa.Column('property_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('service_type', sa.String(100), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('preferred_date', sa.Date(), nullable=True),
        sa.Column('preferred_time', sa.String(50), nullable=True),
        sa.Column('status', sa.String(50), nullable=False, server_default='pending'),
        sa.Column('quote_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('workspace_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.CheckConstraint("status IN ('pending', 'assigned', 'quoted', 'archived')", name='check_quote_request_status'),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['quote_id'], ['quotes.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['workspace_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('idx_quote_requests_client_id', 'quote_requests', ['client_id'])
    op.create_index('idx_quote_requests_status', 'quote_requests', ['status'])
    op.create_index('idx_quote_requests_quote_id', 'quote_requests', ['quote_id'])


def downgrade() -> None:
    op.drop_index('idx_quote_requests_quote_id', table_name='quote_requests')
    op.drop_index('idx_quote_requests_status', table_name='quote_requests')
    op.drop_index('idx_quote_requests_client_id', table_name='quote_requests')
    op.drop_table('quote_requests')

    op.drop_index('idx_quote_line_items_display_order', table_name='quote_line_items')
    op.drop_index('idx_quote_line_items_quote_id', table_name='quote_line_items')
    op.drop_table('quote_line_items')

    op.drop_index('idx_quotes_created_at', table_name='quotes')
    op.drop_index('idx_quotes_workspace_id', table_name='quotes')
    op.drop_index('idx_quotes_created_by', table_name='quotes')
    op.drop_index('idx_quotes_status', table_name='quotes')
    op.drop_index('idx_quotes_property_id', table_name='quotes')
    op.drop_index('idx_quotes_client_id', table_name='quotes')
    op.drop_table('quotes')
