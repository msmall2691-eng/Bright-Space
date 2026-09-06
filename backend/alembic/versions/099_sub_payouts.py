"""
Paying a subcontractor: the ledger.

Subs are VENDORS, not payroll. Square's Labor timecard path carries hours at
an hourly rate — the exact shape a subcontractor's pay must not have — so a
sub's payment currently has no home at all: `marketplace_pay` is computed in
the summary, folded into Gross Pay, silently skipped by the Square push, and
then read off a screen and typed somewhere else by hand.

`sub_payouts` is the ledger that survives whatever payment rail gets picked
later. It records what was owed, for what, and whether it went out — so a
year-to-date total is one query that starts today rather than archaeology next
January. The $600 1099-NEC threshold arrives mid-year, not in December.

- job_id is NULLABLE on purpose: most payouts are for a job, but an
  adjustment, a bonus or a correction is not, and forcing a job onto it would
  mean inventing one.
- amount is dollars (Float), matching agreed_rate and pay_rate_bump. Money is
  not stored in cents anywhere in this schema and this is not the migration to
  start.
- status: due | sent | paid | void. `void` rather than DELETE — a payout that
  was cancelled is a thing that happened.

Revision ID: 099_sub_payouts
Revises: 098_sub_documents
"""
from alembic import op
import sqlalchemy as sa


revision = "099_sub_payouts"
down_revision = "098_sub_documents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sub_payouts",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        # Same crew-ID string space as Job.cleaner_ids — kept alongside user_id
        # so a payout still says who it was for if the login is ever removed.
        sa.Column("cleaner_id", sa.String(), nullable=True, index=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("amount", sa.Float(), nullable=False),
        # due | sent | paid | void
        sa.Column("status", sa.String(16), nullable=False, server_default="due"),
        sa.Column("method", sa.String(32), nullable=True),      # manual | check | ach | square | …
        sa.Column("external_ref", sa.String(128), nullable=True),
        sa.Column("memo", sa.Text(), nullable=True),
        # The work date this pays for — what a year-to-date total is grouped by.
        # Not created_at: a January payout for December work belongs to December.
        sa.Column("earned_on", sa.Date(), nullable=True, index=True),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        # One payout per job per person. Re-running a period must not pay the
        # same cleaning twice, and an idempotent generate is the only safe kind
        # when the button sits next to real money. Adjustments are exempt for
        # free: job_id is NULL on those, and NULLs compare distinct in a unique
        # constraint, so a person can have many adjustments and only ever one
        # payout per actual job.
        sa.UniqueConstraint("user_id", "job_id", name="uq_sub_payouts_user_job"),
    )
    op.create_index("ix_sub_payouts_org_status", "sub_payouts", ["org_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_sub_payouts_org_status", table_name="sub_payouts")
    op.drop_table("sub_payouts")
