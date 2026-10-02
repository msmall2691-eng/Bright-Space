"""Additive hardening on the jobs table: boolean server_defaults + a series index.

Two safe, additive changes surfaced by the schema audit — no data change, no
behavior change, and nothing that touches scheduling authority or sync
(scheduling-invariants R8: additive only, checked).

1. server_default=false on the five NOT NULL boolean flags on `jobs`
   (calendar_invite_sent, sms_reminder_sent, skip_sms_reminder, dispatched,
   open_for_claims). They had a Python-side default=False but no DDL default, so
   a RAW insert that omits them (the Postgres RLS/tenancy tests do exactly this,
   and migration 122 added server_default to Client.recurring_open_to_crew for
   the same reason) trips the NOT NULL constraint. This closes that latent
   raw-insert hazard. ORM inserts are unaffected — they already fill False.

2. An index on jobs.recurring_schedule_id. Recurring generation and the
   recurring-doctor / schedule-verifier health scans filter a 7,000+ row jobs
   table by series; there was no index, so each was a full scan. A plain index
   (the table is small enough that CONCURRENTLY isn't needed; the migration runs
   pre-deploy before the new container serves).

Reversible: downgrade drops the index and removes the defaults (the column
values are untouched either way).

Revision ID: 126_jobs_server_defaults_and_series_index
Revises: 125_invoice_stripe_checkout
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "126_jobs_server_defaults_and_series_index"
down_revision: Union[str, None] = "125_invoice_stripe_checkout"
branch_labels = None
depends_on = None

_BOOL_FLAGS = [
    "calendar_invite_sent",
    "sms_reminder_sent",
    "skip_sms_reminder",
    "dispatched",
    "open_for_claims",
]


def upgrade() -> None:
    # Defaults first: on SQLite batch_alter_table rebuilds the table (and copies
    # existing indexes), so set the defaults before adding the new index.
    with op.batch_alter_table("jobs") as b:
        for col in _BOOL_FLAGS:
            b.alter_column(
                col,
                existing_type=sa.Boolean(),
                existing_nullable=False,
                server_default=sa.false(),
            )
    op.create_index("ix_jobs_recurring_schedule_id", "jobs", ["recurring_schedule_id"])


def downgrade() -> None:
    op.drop_index("ix_jobs_recurring_schedule_id", table_name="jobs")
    with op.batch_alter_table("jobs") as b:
        for col in _BOOL_FLAGS:
            b.alter_column(
                col,
                existing_type=sa.Boolean(),
                existing_nullable=False,
                server_default=None,
            )
