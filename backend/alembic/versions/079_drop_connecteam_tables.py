"""Connecteam removal (final step): drop its tables and Job columns.

The integration is fully deleted from the codebase — no code reads or writes
these anymore (crew scheduling, time clock, and payroll are native). Dropping
them last, in their own migration, so the code deletion and the schema change
revert independently:

  * connecteam_outbox        — the transactional shift-sync outbox (061)
  * connecteam_push_runs     — "push open shifts" background-run tracking (054)
  * jobs.connecteam_shift_ids       — shift ids of the pushed schedule
  * jobs.connecteam_synced_schedule — snapshot for drift detection (055)

Downgrade recreates the shapes (empty) so the ladder replays cleanly both ways.
batch_alter_table keeps the column drops portable to SQLite (local dev).

Revision ID: 079_drop_connecteam_tables
Revises: 078_job_pay_rate_bump
"""
from alembic import op
import sqlalchemy as sa


revision = "079_drop_connecteam_tables"
down_revision = "078_job_pay_rate_bump"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("connecteam_outbox")
    op.drop_table("connecteam_push_runs")
    with op.batch_alter_table("jobs") as batch:
        batch.drop_column("connecteam_shift_ids")
        batch.drop_column("connecteam_synced_schedule")


def downgrade() -> None:
    with op.batch_alter_table("jobs") as batch:
        batch.add_column(sa.Column("connecteam_shift_ids", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("connecteam_synced_schedule", sa.JSON(), nullable=True))
    op.create_table(
        "connecteam_push_runs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("range_start", sa.Date(), nullable=True),
        sa.Column("range_end", sa.Date(), nullable=True),
        sa.Column("considered", sa.Integer()),
        sa.Column("pushed", sa.Integer()),
        sa.Column("skipped", sa.Integer()),
        sa.Column("errors", sa.JSON()),
        sa.Column("error_message", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
    )
    op.create_table(
        "connecteam_outbox",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("op", sa.String(length=16), nullable=False),
        sa.Column("dedupe_key", sa.String(length=200), nullable=False, unique=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("processed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("idx_connecteam_outbox_status", "connecteam_outbox", ["status", "created_at"])
