"""
Native marketplace pivot: request-then-approve claiming with negotiable rate.

Phase 3's open_for_claims + crew_router.claim_job was first-come-first-served
at whatever pay rate was already on the claimer's account (an EMPLOYEE model).
The shop is moving to independent subcontractors: the office posts a job with
an asking rate, subs REQUEST it (optionally countering the rate), and the
office picks who gets it. Nothing here removes the employee-payroll columns
(pay_rate_residential/rental, pay_mode, pay_rate_bump) — a shop mid-transition
can still have hourly logins — but the marketplace flow no longer touches or
assumes them.

- jobs.posted_rate: the flat rate (dollars, matching pay_rate_bump's Float
  convention) the office sets when flipping a job open_for_claims. NULL when
  not currently posted.
- jobs.agreed_rate: the FINAL rate once a request is approved — either the
  posted rate or the winning sub's counter-offer. This is what payroll/
  invoicing should read for a marketplace job, not posted_rate (which is
  just the asking price and may never match what was agreed).
- job_claim_requests: one row per (job, cleaner) request. Multiple subs can
  request the same open job; approving one auto-declines the rest (done in
  application code, not a DB trigger, to keep the notification/activity-log
  side effects in one place — see modules/scheduling/router.py).

Revision ID: 097_job_claim_requests
Revises: 096_recurring_cancelled_at
"""
from alembic import op
import sqlalchemy as sa


revision = "097_job_claim_requests"
down_revision = "096_recurring_cancelled_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("posted_rate", sa.Float(), nullable=True))
    op.add_column("jobs", sa.Column("agreed_rate", sa.Float(), nullable=True))

    op.create_table(
        "job_claim_requests",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        # Same crew-ID string space as Job.cleaner_ids / User.cleaner_id.
        sa.Column("cleaner_id", sa.String(), nullable=False, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        # NULL = "I'll take your posted rate"; set = a counter-offer.
        sa.Column("requested_rate", sa.Float(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        # "pending" | "approved" | "declined" | "withdrawn"
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decided_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_job_claim_requests_job_status", "job_claim_requests", ["job_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_job_claim_requests_job_status", table_name="job_claim_requests")
    op.drop_table("job_claim_requests")
    op.drop_column("jobs", "agreed_rate")
    op.drop_column("jobs", "posted_rate")
