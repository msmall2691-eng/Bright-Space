"""
Alembic migration: add jobs.connecteam_synced_schedule

Companion to the reconcile-sweep drift fix (audit finding #4, July 2026):
"if deleting the old shift fails during a reschedule, the cleaner's
Connecteam shift stays at the old time — and the reconcile tick never fixes
time drift, only missing shifts." There's no Connecteam read API wired up
in this codebase to ask "what time does shift X actually represent", so
instead we snapshot the {scheduled_date, start_time, end_time} BrightBase
pushed at the time of the last successful dispatch. The reconcile sweep
compares that snapshot to the job's current schedule; a mismatch means the
job moved since the shift was pushed, regardless of whether the delete-then-
recreate on the original reschedule fully succeeded.

Alembic version: 055
"""
from alembic import op
import sqlalchemy as sa


revision = "055_connecteam_synced_schedule"
down_revision = "054_connecteam_push_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column("connecteam_synced_schedule", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("jobs", "connecteam_synced_schedule")
