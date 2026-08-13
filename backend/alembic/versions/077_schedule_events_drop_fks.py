"""Phase 2 activation: drop the FK constraints on schedule_events.

An append-only, immutable event log must OUTLIVE the rows it records. Migration
068 created schedule_events with job_id -> jobs.id (ON DELETE CASCADE) and
org_id -> orgs.id. Both are wrong for this table:

  * CASCADE erases a deleted job's history — the `deleted` event included.
  * Worse, the dual-write listener inserts a `deleted` event in the SAME
    transaction that removes the job; with the job_id FK still present, that
    insert violates it against the just-removed row on Postgres and rolls back
    the job deletion entirely.

So drop both FKs before the log is turned on (SCHEDULE_EVENT_LOG_ENABLED). The
columns and indexes stay; org_id remains a denormalized tenant tag that RLS
scopes by value, not by FK. schedule_events is empty in every environment at
this point (the flag has never been on), so this is a pure constraint change
with no data implications.

Additive/safe (R8): no table or column dropped, the log stays dark until the
flag flips, and downgrade restores the constraints. No-op off Postgres — SQLite
builds schedule_events from the (now FK-less) model via create_all.

Revision ID: 077_schedule_events_drop_fks
Revises: 076_job_pay_mode
"""
from alembic import op

# Renumbered 074 -> 077: the payroll PRs (#677/#678) landed 074_time_entry_miles
# off the same 073 parent, so this re-chains onto the current head to keep a
# single linear head.
revision = "077_schedule_events_drop_fks"
down_revision = "076_job_pay_mode"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    # Drop every FK on schedule_events by its real name (robust to whatever
    # naming convention migration 068 produced). The table only carries the
    # job_id and org_id FKs, both of which must go.
    rows = bind.exec_driver_sql(
        "SELECT conname FROM pg_constraint "
        "WHERE conrelid = 'schedule_events'::regclass AND contype = 'f'"
    ).fetchall()
    for (conname,) in rows:
        op.execute(f'ALTER TABLE schedule_events DROP CONSTRAINT IF EXISTS "{conname}"')


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.create_foreign_key(
        "schedule_events_org_id_fkey", "schedule_events", "orgs",
        ["org_id"], ["id"],
    )
    op.create_foreign_key(
        "schedule_events_job_id_fkey", "schedule_events", "jobs",
        ["job_id"], ["id"], ondelete="CASCADE",
    )
