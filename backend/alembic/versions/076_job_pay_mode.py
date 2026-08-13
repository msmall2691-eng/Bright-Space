"""Native payroll: per-job pay-mode override.

Lets the office override how a single job is paid — pay a weekend airbnb hourly
instead of the automatic piece rate, or force a piece rate — without touching
the shop defaults. Additive only (R8): one nullable column on jobs. NULL =
"auto" (the existing automatic rule). No RLS change (same table).

Revision ID: 076_job_pay_mode
Revises: 075_user_pay_rate_deep
"""
from alembic import op
import sqlalchemy as sa


revision = "076_job_pay_mode"
down_revision = "075_user_pay_rate_deep"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("pay_mode", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "pay_mode")
