"""Backfill NULL org_id on tenant rows so RLS stops hiding them (BB-SEC-24).

WHY
---
Migration 027 ran `UPDATE {table} SET org_id = 1 WHERE org_id IS NULL` over the
then-current tenant tables. It held for the rows alive that day and nothing
re-ran it. A census against PRODUCTION Postgres — the one database/rls.py says
had never been run — found it has not held since:

    schedule_events    11,205 NULL of 11,448    integration_events  1,540 of 1,585
    activities            648 of  1,006         messages              517 of 1,304
    conversations          85 of    126

Those rows are not junk, and they are still being produced: comms/router.py
deliberately leaves org_id unset for inbound SMS/voice from an UNKNOWN sender
(no client to inherit from), and database/db.py::_backfill_conversations()
mints a Conversation inheriting that NULL on every boot. They are
disproportionately NEW INBOUND LEADS. (The ingest sites are fixed separately;
this migration repairs the rows already written.)

WHY IT MATTERS
--------------
apply_org_rls() issues ENABLE *and* FORCE ROW LEVEL SECURITY, and the policy is

    org_id = current_setting('app.current_org_id', true)::int
    OR current_setting('app.current_org_id', true) IS NULL

A NULL-org row satisfies NEITHER arm once a route sets the GUC, so Postgres
drops it before any application predicate runs. 278 routes already depend on
`current_org_id`, which is why activities and integration_events are already
partly invisible on those routes — a row shows on one screen and not another
depending on whether that route happened to take the dependency. No
application-level filter can undo that; the rows must actually carry an org.
Hence a data migration.

A NULL org_id has always MEANT the default workspace — database/rls.py and
modules/ai/router.py::_org() both say so — so this writes down what the code
already asserts rather than inventing an owner.

SCOPE, and the one table deliberately left out
----------------------------------------------
Covers every table in TENANT_TABLES except `schedule_events`.

`schedule_events` is the canonical append-only event log of the scheduling
contract (.claude/skills/scheduling-invariants): "append-only. immutable.
ordered." Rewriting rows in it — even a tenancy column — is not this
migration's call to make. It is also not currently necessary: no route that
sets the GUC reads that table, so nothing is hidden by leaving it alone. If a
route ever does, that backfill should be its own decision, taken explicitly.

`ical_events` IS included, and that is deliberate. It is the iCal inbox
staging table, whose rows are likewise "immutable — a changed booking is a new
row, not an update". But that rule governs BOOKING FACTS: a changed
reservation must arrive as a new row rather than an edit. org_id is not a
booking fact; it is an internal tenancy column that should have been populated
at ingest, and the contract separately notes staging is safe to truncate and
re-ingest. A GUC-setting route does read this table, so leaving it out would
keep turnover bookings hidden. No date, uid, property or status is touched.

`users` is untouched: not a tenant table, excluded from RLS and from 027, and
rls.py's note says switching it on needs its own audit.

SAFETY
------
- Idempotent: every statement is `WHERE org_id IS NULL`, so a second run is a
  no-op. Re-run it freely if a deploy times out part way.
- Batched with per-batch commits (AUTOCOMMIT), so no single long lock on a
  table the app is serving from, and a partial run leaves committed progress
  that a re-run simply continues.
- Touches exactly one column, only on rows that have no owner. Never deletes,
  never moves a job, never changes a date, an amount or an assignment.
- Assigns the lowest-id Org, matching modules/auth/router.py::_default_org_id
  and 027's `= 1`.

Revision ID: 129_backfill_null_org_tenant_rows
Revises: 128_invoice_due_date_d_backfill
"""
import sqlalchemy as sa
from alembic import op

from database.rls import TENANT_TABLES

# Plain (un-annotated) assignments — same revision STRINGS, so Alembic's
# recorded history is unchanged, but now the regex-based single-head guard
# (tests/test_alembic_single_head.py) can see this revision. In the annotated
# `revision: str = ...` form it was invisible to that guard, which masked the
# chain the moment a later plain-form migration (130) chained off it.
revision = "129_backfill_null_org_tenant_rows"
down_revision = "128_invoice_due_date_d_backfill"
branch_labels = None
depends_on = None

# The canonical append-only event log — see the module docstring.
EXCLUDED = {"schedule_events"}

BATCH = 500


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())

    default_org = bind.execute(
        sa.text("SELECT id FROM orgs ORDER BY id ASC LIMIT 1")
    ).scalar()
    if default_org is None:
        # No workspace exists yet (fresh database) — nothing can be orphaned.
        return

    # Batched, but on ALEMBIC'S OWN CONNECTION — deliberately not a second
    # AUTOCOMMIT connection.
    #
    # The first version of this migration opened `engine.connect()` so each
    # batch could commit independently, per the usual advice about not holding
    # a write lock during a long backfill. CI caught why that is wrong here:
    #
    #     ERROR: relation "clients" does not exist
    #     STATEMENT: UPDATE "clients" SET org_id = $1 WHERE "id" IN (...)
    #
    # A fresh connection does not inherit the session's `search_path`, and
    # tests/test_migrations_from_scratch.py builds the schema per session, so
    # the new connection could not see the tables at all. In production it
    # would have happened to work against `public` — which is worse, because
    # the bug would only ever have shown up somewhere else.
    #
    # The lock argument does not apply at this size anyway: the one large table
    # (schedule_events, ~11k rows) is excluded by design, and what remains is a
    # few thousand rows across small tables. Batching is kept because it avoids
    # one enormous statement and keeps each step cheap; idempotency does the
    # work that per-batch commits were there for, since a failed run rolls back
    # and a re-run simply redoes it.

    def _run(sql, params):
        return bind.execute(sa.text(sql), params)

    for table in TENANT_TABLES:
        if table in EXCLUDED or table not in existing:
            continue
        cols = {c["name"] for c in insp.get_columns(table)}
        if "org_id" not in cols:
            continue
        pk = (insp.get_pk_constraint(table) or {}).get("constrained_columns") or []
        if len(pk) != 1:
            # Composite or absent PK: fall back to one guarded statement. These
            # tables are small, and the predicate keeps it idempotent.
            _run(f'UPDATE "{table}" SET org_id = :oid WHERE org_id IS NULL',
                 {"oid": default_org})
            continue
        key = pk[0]
        while True:
            res = _run(
                f'UPDATE "{table}" SET org_id = :oid WHERE "{key}" IN ('
                f'  SELECT "{key}" FROM "{table}" WHERE org_id IS NULL LIMIT :lim'
                f")",
                {"oid": default_org, "lim": BATCH},
            )
            if not res.rowcount:
                break


def downgrade() -> None:
    # BB-SEC-24: deliberately a no-op, and that is the honest answer rather than
    # a missing one.
    #
    # These rows always belonged to the default workspace — that is what a NULL
    # org_id meant — so there is nothing to "restore". Re-NULLing them would not
    # return the database to a prior truth; it would re-hide live conversations,
    # leads and invoices behind RLS, which is the outage this migration exists
    # to end. There is also no record of which rows were NULL before, so a
    # faithful reversal is not expressible.
    #
    # If this has to come out, the rollback is the pre-migration backup named in
    # the PR body, not a downgrade.
    pass
