"""Enforce one open time-clock punch per cleaner per org.

Additive only (R8): a partial UNIQUE index on time_entries(org_id, cleaner_id)
WHERE clock_out_at IS NULL, so a cleaner can have at most one punch in progress.
Backstops the endpoint's pre-check against a concurrent double clock-in (which
would otherwise double-count once both punches close). Mirrors the Job turnover
uniqueness index (postgresql_where + sqlite_where) so it holds in both dialects.

Revision ID: 073_time_entry_one_open
Revises: 072_user_pay_rates
"""
from alembic import op
import sqlalchemy as sa


revision = "073_time_entry_one_open"
down_revision = "072_user_pay_rates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "uq_time_entry_one_open_per_cleaner",
        "time_entries",
        ["org_id", "cleaner_id"],
        unique=True,
        postgresql_where=sa.text("clock_out_at IS NULL"),
        sqlite_where=sa.text("clock_out_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_time_entry_one_open_per_cleaner", table_name="time_entries")
