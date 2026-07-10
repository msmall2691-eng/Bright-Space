"""
Alembic migration: STR turnover dedup hardening

Companion to the ical_sync.py fix for the cancel<->recreate duplicate-turnover
bug (one Airbnb booking spawning hundreds of jobs). Three additions:

1. ical_events.property_ical_id — records which specific PropertyIcal feed
   produced each stored event, so the multi-feed cancellation sweep can tell
   "this booking's own feed says it's gone" apart from "a DIFFERENT feed on
   this property didn't happen to mention it". Nullable: existing rows predate
   this and are treated as unattributed (sync_property's cross-feed union
   check covers them without needing a backfill).
2. property_icals.last_events_seen — the event count from each feed's most
   recent successful sync, used to flag a suspiciously small/partial fetch
   (a feed truncated mid-response can still parse as valid iCal with a handful
   of VEVENTs, which the old "did we see zero events" guard never caught).
3. A partial UNIQUE index on jobs(property_id, scheduled_date, job_type),
   scoped to job_type='str_turnover' and excluding cancelled rows — a DB-level
   backstop so at most one live (non-cancelled) turnover can ever exist per
   property/checkout-date, regardless of what application logic does. Scoped
   to str_turnover specifically (NOT all job types) because residential/
   commercial properties can legitimately have more than one job on the same
   date (e.g. an extra one-off clean alongside a recurring visit) — only STR
   turnovers are 1:1 with a checkout date. Mirrored in Job.__table_args__ (see
   models.py) so the SQLite test schema (Base.metadata.create_all) enforces it
   too, not just Postgres migrations.

Before creating that index, any PRE-EXISTING non-cancelled duplicate turnovers
are collapsed (soft-cancelled, never deleted) so the index creation can't fail
on deploy. The mass of already-cancelled duplicate rows the bug produced are
NOT touched here (harmless — already hidden by the Schedule's default filter);
see scripts/cleanup_ical_turnover_duplicates.py for the opt-in bulk purge of
those, run manually after review (same "don't blind-delete in a migration"
caution as 043_unique_job_quote.py).

Alembic version: 052
"""

from alembic import op
import sqlalchemy as sa


revision = "052_ical_turnover_dedup_hardening"
down_revision = "051_recurring_series_end_occurrences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ical_events",
        sa.Column("property_ical_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "idx_ical_events_property_ical_id", "ical_events", ["property_ical_id"],
    )
    op.add_column(
        "property_icals",
        sa.Column("last_events_seen", sa.Integer(), nullable=True),
    )

    # Collapse pre-existing non-cancelled duplicate turnovers (soft-cancel all
    # but one per property/date) so the unique index below can't fail to
    # build on deploy against data the bug already produced.
    bind = op.get_bind()
    rows = bind.execute(sa.text("""
        SELECT id, property_id, scheduled_date
        FROM jobs
        WHERE status <> 'cancelled' AND job_type = 'str_turnover'
        ORDER BY property_id, scheduled_date, id
    """)).fetchall()
    groups = {}
    for row in rows:
        groups.setdefault((row.property_id, row.scheduled_date), []).append(row.id)
    for ids in groups.values():
        for loser_id in ids[1:]:
            bind.execute(
                sa.text("UPDATE jobs SET status = 'cancelled' WHERE id = :id"),
                {"id": loser_id},
            )

    op.create_index(
        "uq_jobs_turnover_property_date_live", "jobs",
        ["property_id", "scheduled_date", "job_type"], unique=True,
        postgresql_where=sa.text("status <> 'cancelled' AND job_type = 'str_turnover'"),
        sqlite_where=sa.text("status <> 'cancelled' AND job_type = 'str_turnover'"),
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("uq_jobs_turnover_property_date_live", table_name="jobs", if_exists=True)
    op.drop_index("idx_ical_events_property_ical_id", table_name="ical_events", if_exists=True)
    op.drop_column("property_icals", "last_events_seen")
    op.drop_column("ical_events", "property_ical_id")
