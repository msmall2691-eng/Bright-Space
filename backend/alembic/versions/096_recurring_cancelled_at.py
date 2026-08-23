"""Give a cancelled recurring series its own state.

Additive only (R8): one nullable timestamp on recurring_schedules. Nothing
about generation changes — `active` stays the single authority on whether a
series produces visits, so this column can never disagree with it about work.

WHY: cancelling and pausing were byte-identical in the database (both set
`active=false`; only the button copy differed), so a series the owner
cancelled came back reading "Paused" and stayed in the list. Reported as
"when I try to cancel or delete them they don't go away".

NULL means "not cancelled", which is exactly how every existing row should
read, so there is no backfill and no deploy-day change to what anyone sees.
Resuming a series clears it — a series you're generating visits for again is
not a cancelled one.

Revision ID: 096_recurring_cancelled_at
Revises: 095_rls_backfill_ugauth_push
"""
from alembic import op
import sqlalchemy as sa

revision = "096_recurring_cancelled_at"
down_revision = "095_rls_backfill_ugauth_push"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "recurring_schedules",
        sa.Column("cancelled_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("recurring_schedules", "cancelled_at")
