"""Native crew time clock: capture miles per punch.

Closes the last parity gap with Connecteam's payroll — the native clock now
records the miles a cleaner enters at clock-out, so the native payroll path can
reimburse mileage instead of hardcoding $0. Additive only (R8): one nullable
column on time_entries. NULL = not entered → treated as 0 in payroll. No RLS
change (same table).

Revision ID: 074_time_entry_miles
Revises: 073_time_entry_one_open
"""
from alembic import op
import sqlalchemy as sa


revision = "074_time_entry_miles"
down_revision = "073_time_entry_one_open"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("time_entries", sa.Column("miles", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("time_entries", "miles")
