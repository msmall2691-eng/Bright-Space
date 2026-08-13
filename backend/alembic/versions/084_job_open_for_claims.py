"""Crew open-jobs board: jobs.open_for_claims (crew app Phase 3).

The office flips this flag to put a job "up for grabs" on every cleaner's
Schedule tab; the first successful claim (POST /api/crew/jobs/{id}/claim)
adds the claimer to cleaner_ids and flips it back off, atomically. Owner
decision #2: only office-marked jobs are claimable — being unassigned does
NOT make a job open.

Additive: one boolean with a server default of false, so existing rows and
the running old code are untouched (R8).

Revision ID: 084_job_open_for_claims
Revises: 083_job_responses
"""
from alembic import op
import sqlalchemy as sa


revision = "084_job_open_for_claims"
down_revision = "083_job_responses"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column("open_for_claims", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("jobs", "open_for_claims")
