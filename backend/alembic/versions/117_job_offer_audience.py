"""Limit which cleaners see an open offer.

Every cleared sub used to see every open job. This adds an optional audience on
the job: when set, only the listed cleaners are shown the offer on their board.
NULL / empty = everyone (the prior behavior), so this is additive and inert
until the office chooses to narrow an offer.

This is a MARKETPLACE VISIBILITY column, not schedule state. It does not change
a job's time, assignment, or existence, adds no background tick, and no
projection writes to it (scheduling-invariants R1/R2/R8 clean — additive only).
It stays an offer: a targeted sub still requests or accepts and the office still
decides, so "offered, never assigned" holds (brightbase-marketplace Rule 0).

`offer_audience` is a JSON list of cleaner_ids (same id space as
Job.cleaner_ids). No RLS row of its own — it rides the jobs table, already a
tenant table with an org policy.

Revision ID: 117_job_offer_audience
Revises: 116_crew_peer_messages
"""
import sqlalchemy as sa
from alembic import op

revision = "117_job_offer_audience"
down_revision = "116_crew_peer_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable, no default backfill: an absent audience already reads as
    # "everyone" everywhere it's checked, so existing open jobs keep their
    # org-wide visibility with no data migration.
    op.add_column("jobs", sa.Column("offer_audience", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "offer_audience")
