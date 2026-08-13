"""Crew accept/decline: job_responses table (crew app Phase 2).

A cleaner's answer to an assignment — "accepted", or "declined" with a
reason. Deliberately a status BESIDE the schedule, never a schedule write:
declining does not touch Job.cleaner_ids (owner decision, crew-app plan #1);
the office sees the flag on the job and decides the reassignment.

One row per (job, cleaner) — changing your mind updates in place; the unique
constraint backstops the upsert against a double-tap race.

org_id makes this a tenant table — paired with the TENANT_TABLES entry in
database/rls.py.

Revision ID: 083_job_responses
Revises: 082_user_emergency_contact
"""
from alembic import op
import sqlalchemy as sa


revision = "083_job_responses"
down_revision = "082_user_emergency_contact"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "job_responses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("job_id", sa.Integer(),
                  sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("cleaner_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("response", sa.String(length=8), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("job_id", "cleaner_id", name="uq_job_response_job_cleaner"),
    )
    op.create_index("ix_job_responses_org_id", "job_responses", ["org_id"])
    op.create_index("ix_job_responses_job_id", "job_responses", ["job_id"])
    op.create_index("ix_job_responses_cleaner_id", "job_responses", ["cleaner_id"])


def downgrade() -> None:
    op.drop_index("ix_job_responses_cleaner_id", table_name="job_responses")
    op.drop_index("ix_job_responses_job_id", table_name="job_responses")
    op.drop_index("ix_job_responses_org_id", table_name="job_responses")
    op.drop_table("job_responses")
