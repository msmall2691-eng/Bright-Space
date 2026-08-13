"""Native payroll: per-job hourly pay bump.

The shop's real-world rule: a two-cleaner deep clean or a weekday immediate
turnover sometimes pays "+$1/hr" — offered during the week, per job, on top of
whatever each cleaner's normal hourly rate is. This column holds those extra
dollars-per-hour; NULL/0 = no bump. Applied to HOURLY pay only (piece-rate jobs
pay the property's flat turnover rate; a bump would be meaningless there).

Additive only (R8): one nullable column on jobs. No RLS change (same table).

Revision ID: 078_job_pay_rate_bump
Revises: 077_schedule_events_drop_fks
"""
from alembic import op
import sqlalchemy as sa


revision = "078_job_pay_rate_bump"
down_revision = "077_schedule_events_drop_fks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("pay_rate_bump", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "pay_rate_bump")
