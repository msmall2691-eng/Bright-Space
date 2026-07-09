"""
Alembic migration: customer confirm/reschedule-request fields on jobs

Part 2 Tier 2 roadmap item: reminder SMS/email currently tells the customer
to "reply" if they need to reschedule, but a reply just lands in the comms
inbox with no structured signal — staff have to notice and connect it back
to the specific job. This adds a public-token confirm link (mirrors the
Quote public_token pattern) so a customer can confirm the visit or flag a
reschedule request that lands as a queued item for staff, rather than
relying on someone reading a text reply.

Alembic version: 050
"""

from alembic import op
import sqlalchemy as sa


revision = "050_job_public_token"
down_revision = "049_fix_schema_drift_from_scratch"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("public_token", sa.String(length=64), nullable=True))
    op.create_index("ix_jobs_public_token", "jobs", ["public_token"], unique=True)
    op.add_column("jobs", sa.Column("customer_confirmed_at", sa.DateTime(), nullable=True))
    op.add_column("jobs", sa.Column("reschedule_requested_at", sa.DateTime(), nullable=True))
    op.add_column("jobs", sa.Column("reschedule_request_message", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "reschedule_request_message")
    op.drop_column("jobs", "reschedule_requested_at")
    op.drop_column("jobs", "customer_confirmed_at")
    op.drop_index("ix_jobs_public_token", table_name="jobs")
    op.drop_column("jobs", "public_token")
