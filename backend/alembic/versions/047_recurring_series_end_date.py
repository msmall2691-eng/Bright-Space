"""
Alembic migration: series_end_date on recurring_schedules

Supports Jobber-style "this and all future" edits: splitting a series at a
chosen date ends the current RecurringSchedule's generation at that boundary
(series_end_date, exclusive of further dates) and a new RecurringSchedule
picks up from there with the edited rule. Nullable — an open-ended schedule
(the overwhelming majority) has no end boundary.

Alembic version: 047
"""

from alembic import op
import sqlalchemy as sa


revision = "047_recurring_series_end_date"
down_revision = "046_dedupe_quote_address_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "recurring_schedules",
        sa.Column("series_end_date", sa.Date(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("recurring_schedules", "series_end_date")
