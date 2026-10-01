"""Attach a property to existing property-less jobs and recurring series.

The require-a-property guardrail stops NEW property-less records (#1004); this
fixes the ones already on the books. Prod drifted to allow NULL
Job.property_id / RecurringSchedule.property_id despite the models, and a job or
series with no property is the root of most of the duplicate/stale-visit drift
the workflow audit found.

Auto-fix where safe (services/property_backfill.resolve_backfill_property_id):
  - client has exactly ONE property      → attach it,
  - client has NONE but has an address   → create one from it and attach,
  - client has MULTIPLE / none + no addr → LEFT as NULL for human review.

DATA migration, no schema change. Idempotent (only touches rows still NULL, and
a client's created-this-run property is reused for their other orphaned rows).
No-op on a fresh schema, where property_id is NOT NULL and nothing is orphaned —
the real NULLs only exist on the drifted prod DB. Marketplace/scheduling state
is untouched: it only fills the property FK (scheduling-invariants: no writeback,
no auto-delete, no new tick). The counts are logged for the deploy record.

NOTE: #1002 (Stripe) also introduced a migration 124 in parallel. If that lands
first, rewire this one's down_revision to chain behind it (124→125) rather than
leaving two heads off 123.

Revision ID: 124_backfill_job_property
Revises: 123_rehide_unopted_recurring
"""
import logging

import sqlalchemy as sa
from alembic import op
from sqlalchemy.orm import Session

revision = "124_backfill_job_property"
down_revision = "123_rehide_unopted_recurring"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")


def _backfill(sess, table):
    from services.property_backfill import resolve_backfill_property_id
    rows = sess.execute(sa.text(
        f"SELECT id, client_id, org_id FROM {table} WHERE property_id IS NULL"
    )).fetchall()
    fixed = 0
    skipped = 0
    for r in rows:
        m = r._mapping
        pid = resolve_backfill_property_id(sess, m["client_id"], m.get("org_id"))
        if pid is None:
            skipped += 1
            continue
        sess.execute(
            sa.text(f"UPDATE {table} SET property_id = :pid WHERE id = :id"),
            {"pid": pid, "id": m["id"]},
        )
        fixed += 1
    log.info("[124 backfill] %s: attached %d, left %d for review", table, fixed, skipped)
    return fixed, skipped


def upgrade() -> None:
    sess = Session(bind=op.get_bind())
    try:
        _backfill(sess, "jobs")
        _backfill(sess, "recurring_schedules")
        sess.flush()
    finally:
        sess.close()


def downgrade() -> None:
    # No-op by design: an attached property is now indistinguishable from one set
    # by hand, and the auto-created properties are real records the app uses.
    # Nulling them back out would re-create the drift this fixes. Schema is
    # unchanged, so there is nothing structural to revert.
    pass
