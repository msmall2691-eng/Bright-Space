"""Add multiple iCals, check-in/out times, house codes, and guest count tracking."""
# This migration adds:
# 1. PropertyIcal table for multiple iCal URLs per property
# 2. Property fields: check_in_time, check_out_time, house_code
# 3. ICalEvent field: guest_count (number of guests for the booking)

from alembic import op
import sqlalchemy as sa
from datetime import datetime

def upgrade():
    # Add new columns to Property
    op.add_column('properties', sa.Column('check_in_time', sa.String(5), nullable=True))  # "14:00"
    op.add_column('properties', sa.Column('check_out_time', sa.String(5), nullable=True))  # "10:00"
    op.add_column('properties', sa.Column('house_code', sa.String(255), nullable=True))

    # Add guest_count to ICalEvent
    op.add_column('ical_events', sa.Column('guest_count', sa.Integer, nullable=True))

    # Create PropertyIcal table for multiple iCals
    op.create_table(
        'property_icals',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('property_id', sa.Integer(), nullable=False),
        sa.Column('url', sa.String(), nullable=False),
        sa.Column('source', sa.String(), nullable=True),  # "airbnb", "vrbo", "manual"
        sa.Column('active', sa.Boolean(), default=True),
        sa.Column('last_synced_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), default=datetime.utcnow),
        sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.Index('ix_property_icals_property_id', 'property_id')
    )

def downgrade():
    op.drop_table('property_icals')
    op.drop_column('ical_events', 'guest_count')
    op.drop_column('properties', 'house_code')
    op.drop_column('properties', 'check_out_time')
    op.drop_column('properties', 'check_in_time')
