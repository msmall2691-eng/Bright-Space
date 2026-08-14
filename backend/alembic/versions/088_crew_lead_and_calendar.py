"""Crew lead visibility + personal calendar feeds: two users columns.

- can_view_full_schedule: admin-flagged lead cleaners see the whole month
  schedule in the crew app (titles/times/names only — access details stay
  scoped to their own jobs). Set only via the admin users PATCH.
- calendar_token: secret for the per-cleaner read-only iCal feed
  (/api/crew-cal/{token}.ics) that Google/Apple Calendar subscribe to. A
  projection by construction — calendars PULL it; BrightBase never writes
  to anyone's calendar and no background sync exists (scheduling-invariants
  R1/R2 clean). NULL until the cleaner first requests their link; rotating
  it revokes the old URL.

Additive (R8).

Revision ID: 088_crew_lead_and_calendar
Revises: 087_cleaner_week_availability
"""
from alembic import op
import sqlalchemy as sa


revision = "088_crew_lead_and_calendar"
down_revision = "087_cleaner_week_availability"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("can_view_full_schedule", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )
    op.add_column("users", sa.Column("calendar_token", sa.String(length=64), nullable=True))
    op.create_index("ix_users_calendar_token", "users", ["calendar_token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_calendar_token", table_name="users")
    op.drop_column("users", "calendar_token")
    op.drop_column("users", "can_view_full_schedule")
