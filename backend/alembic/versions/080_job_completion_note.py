"""Crew mark-done: the note a cleaner leaves when completing a job.

"Lockbox was empty", "we're low on towels" — typed on the phone at clock-out
time and read by the office on the job page and the activity feed. Deliberately
its OWN column rather than an append to jobs.notes: _auto_create_draft_invoice
copies jobs.notes onto the customer-facing invoice, and a crew field report
must never leak onto a client's bill.

Additive only (R8): one nullable column on jobs. No RLS change (same table).

Revision ID: 080_job_completion_note
Revises: 079_drop_connecteam_tables
"""
from alembic import op
import sqlalchemy as sa


revision = "080_job_completion_note"
down_revision = "079_drop_connecteam_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("completion_note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "completion_note")
