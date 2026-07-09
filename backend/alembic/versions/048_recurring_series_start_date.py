"""
Alembic migration: series_start_date on recurring_schedules

Companion to 047's series_end_date. generate_dates() always expands from
business_today() forward with no floor, so a schedule created by a "this and
all future" split (POST /api/recurring/{id}/split) with a different day-of-
week than the old rule could generate occurrences BEFORE the intended split
boundary — e.g. splitting a Monday series into a Friday series at a Monday
two weeks out would otherwise start producing Fridays starting THIS week,
not from the split date. series_start_date is an inclusive floor: generation
never produces a date before it. Nullable — the overwhelming majority of
schedules have no such floor.

Alembic version: 048
"""

from alembic import op
import sqlalchemy as sa


revision = "048_recurring_series_start_date"
down_revision = "047_recurring_series_end_date"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "recurring_schedules",
        sa.Column("series_start_date", sa.Date(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("recurring_schedules", "series_start_date")
