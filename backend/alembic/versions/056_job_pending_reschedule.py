"""
Alembic migration: pending customer self-reschedule (double-book approval)

Customers can self-reschedule from the confirm link. When they pick an OPEN
slot the visit moves immediately. When they pick a BUSY slot (a double-book),
the requested move is held here as a pending approval instead — the owner
approves (applies it) or declines (clears it). Recurring customers also choose
"this visit" or "this and all future", stored as the scope.

Alembic version: 056
"""

from alembic import op
import sqlalchemy as sa


revision = "056_job_pending_reschedule"
down_revision = "055_connecteam_synced_schedule"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("reschedule_requested_date", sa.Date(), nullable=True))
    op.add_column("jobs", sa.Column("reschedule_requested_start_time", sa.Time(), nullable=True))
    op.add_column("jobs", sa.Column("reschedule_requested_end_time", sa.Time(), nullable=True))
    op.add_column("jobs", sa.Column("reschedule_requested_scope", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "reschedule_requested_scope")
    op.drop_column("jobs", "reschedule_requested_end_time")
    op.drop_column("jobs", "reschedule_requested_start_time")
    op.drop_column("jobs", "reschedule_requested_date")
