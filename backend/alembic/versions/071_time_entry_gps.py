"""Native crew time clock: capture GPS at clock-in.

Phase 2b of the native crew app. Additive only (R8): three nullable columns on
time_entries for the browser geolocation captured when a cleaner clocks in.
Best-effort — NULL when the device denied location; a punch is never blocked on
GPS. No RLS change (same table).

Revision ID: 071_time_entry_gps
Revises: 070_time_entries
"""
from alembic import op
import sqlalchemy as sa


revision = "071_time_entry_gps"
down_revision = "070_time_entries"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("time_entries", sa.Column("clock_in_lat", sa.Float(), nullable=True))
    op.add_column("time_entries", sa.Column("clock_in_lng", sa.Float(), nullable=True))
    op.add_column("time_entries", sa.Column("clock_in_accuracy_m", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("time_entries", "clock_in_accuracy_m")
    op.drop_column("time_entries", "clock_in_lng")
    op.drop_column("time_entries", "clock_in_lat")
