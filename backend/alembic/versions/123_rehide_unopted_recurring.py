"""Re-hide recurring visits opened globally, keeping only opted-in customers.

Migration 121 opened EVERY unassigned recurring visit to the crew board. The
owner then scoped that to specific customers (Client.recurring_open_to_crew,
migration 122). This closes the ones that shouldn't be open any more: a future,
scheduled, unassigned recurring occurrence (recurring_schedule_id set, not a
turnover) whose customer is NOT opted in gets open_for_claims=False and its
auto-seeded posted_rate cleared.

Two rows are deliberately left open:
  - any whose customer IS opted in (that's the behavior they chose), and
  - any that already has a PENDING claim request — a sub is mid-ask on it, and
    yanking it off the board would orphan their request. The office can resolve
    or re-hide those by hand.

DATA migration, no schema change. Idempotent (re-run closes nothing new).
Batched so one UPDATE never locks the jobs table on the single Railway
container. Marketplace VISIBILITY only — time, assignment, existence untouched
(scheduling-invariants: no writeback, no auto-delete, no new tick). Caveat: a
recurring occurrence the office opened BY HAND before this will also be closed
(it's indistinguishable from an auto-opened one); the office simply re-opens it.

Revision ID: 123_rehide_unopted_recurring
Revises: 122_client_recurring_open_to_crew
"""
from datetime import date

import sqlalchemy as sa
from alembic import op

revision = "123_rehide_unopted_recurring"
down_revision = "122_client_recurring_open_to_crew"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    opted_in = {
        r._mapping["id"]
        for r in conn.execute(
            sa.text("SELECT id FROM clients WHERE recurring_open_to_crew = :t"),
            {"t": True},
        ).fetchall()
    }
    pending_job_ids = {
        r._mapping["job_id"]
        for r in conn.execute(
            sa.text("SELECT DISTINCT job_id FROM job_claim_requests WHERE status = 'pending'")
        ).fetchall()
    }

    candidates = conn.execute(
        sa.text(
            "SELECT id, client_id FROM jobs "
            "WHERE recurring_schedule_id IS NOT NULL "
            "AND open_for_claims = :is_open "
            "AND status = 'scheduled' "
            "AND job_type <> 'str_turnover' "
            "AND scheduled_date >= :today"
        ),
        {"is_open": True, "today": date.today()},
    ).fetchall()

    to_close = [
        r._mapping["id"] for r in candidates
        if r._mapping["client_id"] not in opted_in
        and r._mapping["id"] not in pending_job_ids
    ]

    for i in range(0, len(to_close), 500):
        batch = to_close[i:i + 500]
        conn.execute(
            sa.text(
                "UPDATE jobs SET open_for_claims = :closed, posted_rate = NULL "
                "WHERE id IN :ids"
            ).bindparams(sa.bindparam("ids", expanding=True)),
            {"closed": False, "ids": batch},
        )


def downgrade() -> None:
    # No-op by design: this re-hides visits that migration 121 opened and that
    # the owner no longer wants open. Re-opening them blindly would reinstate the
    # global behavior 122/123 exist to undo. Schema is unchanged; there is
    # nothing structural to revert.
    pass
