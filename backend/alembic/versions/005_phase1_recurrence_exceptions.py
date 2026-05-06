"""Phase 1: durable RecurrenceException model.

Replaces the Phase 0 transient mechanism (cancellations stored only on the
Visit row) with a real RFC-5545-style exception table. Two payoffs:

  1. "Skip next Tuesday" and "move next Tuesday to Wednesday" become first
     class actions with audit trails — operators no longer have to delete
     and recreate Jobs.
  2. The schema now lines up with what Google Calendar speaks (EXDATE +
     RECURRENCE-ID) so the eventual two-way sync (Phase 4) doesn't need
     another migration.

Backfill: every Visit currently in status='cancelled' that's linked to a
recurring schedule becomes a 'skip' exception row. The UNIQUE(schedule_id,
date) constraint plus ON CONFLICT DO NOTHING makes the backfill idempotent.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "recurrence_exceptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "recurring_schedule_id",
            sa.Integer(),
            sa.ForeignKey("recurring_schedules.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("exception_date", sa.Date(), nullable=False, index=True),
        sa.Column("exception_type", sa.String(), nullable=False),
        sa.Column("rescheduled_date", sa.Date(), nullable=True),
        sa.Column("rescheduled_start_time", sa.Time(), nullable=True),
        sa.Column("rescheduled_end_time", sa.Time(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint(
            "recurring_schedule_id",
            "exception_date",
            name="uq_recurrence_exception_schedule_date",
        ),
    )

    # Backfill: convert cancelled Visits on recurring schedules into 'skip'
    # exceptions. Idempotent thanks to the unique constraint.
    bind = op.get_bind()
    bind.execute(text("""
        INSERT INTO recurrence_exceptions
            (recurring_schedule_id, exception_date, exception_type, reason, created_at)
        SELECT DISTINCT
            j.recurring_schedule_id,
            v.scheduled_date,
            'skip',
            'Backfilled from cancelled Visit (Phase 1 migration)',
            CURRENT_TIMESTAMP
        FROM visits v
        JOIN jobs j ON v.job_id = j.id
        WHERE v.status = 'cancelled'
          AND j.recurring_schedule_id IS NOT NULL
        ON CONFLICT (recurring_schedule_id, exception_date) DO NOTHING
    """))


def downgrade():
    op.drop_table("recurrence_exceptions")
