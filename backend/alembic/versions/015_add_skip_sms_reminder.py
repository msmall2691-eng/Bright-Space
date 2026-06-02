"""015 — add skip_sms_reminder to jobs.

Per-booking SMS reminder suppression (hybrid model): reminders are sent by
default; staff can opt a single job out without disabling the whole system.

Revision ID: 015_skip_sms_reminder
"""
from alembic import op
import sqlalchemy as sa

revision = "015_skip_sms_reminder"
down_revision = "014_quote_email_tracking"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "jobs",
        sa.Column("skip_sms_reminder", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )
    op.create_index(
        "idx_jobs_skip_reminder", "jobs",
        ["skip_sms_reminder", "scheduled_date"],
    )


def downgrade():
    op.drop_index("idx_jobs_skip_reminder", table_name="jobs")
    op.drop_column("jobs", "skip_sms_reminder")
