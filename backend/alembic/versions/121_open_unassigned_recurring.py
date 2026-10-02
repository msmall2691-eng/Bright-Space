"""Put existing unassigned recurring visits on the bench.

Owner decision (Sept 2026), reversing the older "only office-marked jobs are
claimable" rule for RECURRING work: an unassigned recurring occurrence should be
grabbable by any cleared sub, one visit at a time, without the office posting it
by hand. New occurrences get this at generation (modules/recurring/router.py);
this backfills the ones already on the books.

DATA migration, no schema change. For every FUTURE, scheduled, UNASSIGNED
recurring occurrence (recurring_schedule_id set, cleaner_ids empty, job_type not
a turnover) that isn't already open, flip open_for_claims=True. It stays an
offer — the sub requests and the office approves (brightbase-marketplace Rule 0).

Deliberately does NOT seed posted_rate here: a pre-existing occurrence simply
shows "name your price" on the board (a fully supported claim path) until the
office prices it, whereas newly generated occurrences seed the rate from
billed × default-pay % at creation. Keeping the backfill to the one boolean
keeps it dialect-safe (SQLite/Postgres) and free of the settings-service and
per-row float math a rate seed would drag in.

Idempotent: the WHERE skips rows already open, so a re-run is a no-op. Batched so
one long UPDATE never locks the jobs table on the single Railway container.
Only marketplace VISIBILITY changes — time, assignment, and existence are
untouched (scheduling-invariants: no writeback, no auto-delete, no new tick).

Revision ID: 121_open_unassigned_recurring
Revises: 120_property_standing_cleaner
"""
import json
from datetime import date

import sqlalchemy as sa
from alembic import op

revision = "121_open_unassigned_recurring"
down_revision = "120_property_standing_cleaner"
branch_labels = None
depends_on = None


def _is_empty_cleaner_ids(raw) -> bool:
    """cleaner_ids is a JSON column: SQLite hands back the raw TEXT, Postgres a
    parsed list. Empty == NULL, '[]', or a list of length 0."""
    if raw is None:
        return True
    if isinstance(raw, (list, tuple)):
        return len(raw) == 0
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return True
        try:
            parsed = json.loads(s)
            return not parsed
        except (ValueError, TypeError):
            return False
    return False


def upgrade() -> None:
    conn = op.get_bind()
    # Candidate rows: future, scheduled, recurring, non-turnover, not already
    # open. Emptiness of cleaner_ids is decided in Python (dialect-safe JSON).
    rows = conn.execute(
        sa.text(
            "SELECT id, cleaner_ids FROM jobs "
            "WHERE recurring_schedule_id IS NOT NULL "
            "AND open_for_claims = :is_open "
            "AND status = 'scheduled' "
            "AND job_type <> 'str_turnover' "
            "AND scheduled_date >= :today"
        ),
        {"is_open": False, "today": date.today()},
    ).fetchall()

    to_open = [r._mapping["id"] for r in rows if _is_empty_cleaner_ids(r._mapping["cleaner_ids"])]

    for i in range(0, len(to_open), 500):
        batch = to_open[i:i + 500]
        conn.execute(
            sa.text("UPDATE jobs SET open_for_claims = :is_open WHERE id IN :ids")
            .bindparams(sa.bindparam("ids", expanding=True)),
            {"is_open": True, "ids": batch},
        )


def downgrade() -> None:
    # No-op by design: once applied, an opened occurrence is indistinguishable
    # from one the office opened by hand, so a blanket close would shut offers
    # that weren't ours. The flag is harmless and reversible per-row by the
    # office. Schema is unchanged, so there is nothing structural to revert.
    pass
