"""Native payroll: per-cleaner deep-clean pay rate.

Deep cleans are paid a distinct (usually higher) hourly rate than a regular
residential clean. This adds the per-cleaner override column, parallel to
pay_rate_residential / pay_rate_rental. Additive only (R8): one nullable column
on users. NULL = use the shop default (Settings pay_rate_deep_clean). No RLS
change (same table).

Revision ID: 075_user_pay_rate_deep
Revises: 074_time_entry_miles
"""
from alembic import op
import sqlalchemy as sa


revision = "075_user_pay_rate_deep"
down_revision = "074_time_entry_miles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("pay_rate_deep", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "pay_rate_deep")
