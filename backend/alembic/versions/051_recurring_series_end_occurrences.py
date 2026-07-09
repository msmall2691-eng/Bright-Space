"""
Alembic migration: series_end_occurrences on recurring_schedules

Companion to 047's series_end_date. series_end_date is the exclusive date
boundary generate_dates() actually enforces; this new column records the
user's ORIGINAL "ends after N occurrences" choice purely for display
fidelity — re-opening the edit form should show "Ends after 10 visits"
again, not a computed date, matching Google Calendar's recurrence UI.
NULL means the series either never ends or ends on an explicit date (not
an occurrence count).

Alembic version: 051
"""

from alembic import op
import sqlalchemy as sa


revision = "051_recurring_series_end_occurrences"
down_revision = "050_job_public_token"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "recurring_schedules",
        sa.Column("series_end_occurrences", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("recurring_schedules", "series_end_occurrences")
