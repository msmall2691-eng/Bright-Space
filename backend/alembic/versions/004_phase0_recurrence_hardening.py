"""Phase 0: harden recurring schedule generation.

1. Backfill: collapse duplicate (recurring_schedule_id, scheduled_date) jobs.
   Keep the lowest id; clean up dependent rows since the FKs in this schema
   do NOT have ON DELETE CASCADE:
     - visits.job_id (NOT NULL): delete the duplicates' visits — they are
       duplicates of the keeper's visit by construction (same schedule+date).
     - ical_events.job_id (UNIQUE, nullable): if a drop has a link, move it
       to the keeper only when the keeper has none; otherwise NULL it.
     - invoices.job_id, messages.job_id, activities.job_id (nullable):
       repoint to the keeper to preserve audit/history.
2. Add a partial unique index on jobs(recurring_schedule_id, scheduled_date)
   WHERE recurring_schedule_id IS NOT NULL. This is the database-level
   guarantee that the savepoint+IntegrityError path in generate_jobs() leans on.

Non-recurring jobs (recurring_schedule_id IS NULL) are unaffected.
"""
from alembic import op
from sqlalchemy import text

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()

    duplicates = bind.execute(text("""
        SELECT recurring_schedule_id, scheduled_date, array_agg(id ORDER BY id) AS ids
        FROM jobs
        WHERE recurring_schedule_id IS NOT NULL
        GROUP BY recurring_schedule_id, scheduled_date
        HAVING count(*) > 1
    """)).fetchall()

    for sched_id, sched_date, ids in duplicates:
        keep, *drop = ids
        if not drop:
            continue

        # Repoint history-bearing nullable FKs to the keeper so audit/billing
        # rows remain attached to a live job.
        for tbl in ("invoices", "messages", "activities"):
            bind.execute(
                text(f"UPDATE {tbl} SET job_id = :keep WHERE job_id = ANY(:drop)"),
                {"keep": keep, "drop": drop},
            )

        # ical_events.job_id is UNIQUE: keep at most one link to the keeper.
        keeper_has_ical = bind.execute(
            text("SELECT 1 FROM ical_events WHERE job_id = :keep LIMIT 1"),
            {"keep": keep},
        ).first()
        if keeper_has_ical:
            bind.execute(
                text("UPDATE ical_events SET job_id = NULL WHERE job_id = ANY(:drop)"),
                {"drop": drop},
            )
        else:
            # Promote the lowest-id drop's link to the keeper, NULL the rest.
            promoted = bind.execute(
                text("""
                    SELECT id FROM ical_events
                    WHERE job_id = ANY(:drop)
                    ORDER BY id
                    LIMIT 1
                """),
                {"drop": drop},
            ).first()
            if promoted:
                bind.execute(
                    text("UPDATE ical_events SET job_id = :keep WHERE id = :id"),
                    {"keep": keep, "id": promoted[0]},
                )
                bind.execute(
                    text("UPDATE ical_events SET job_id = NULL WHERE job_id = ANY(:drop)"),
                    {"drop": drop},
                )

        # visits.job_id is NOT NULL — the duplicates' visits are themselves
        # duplicates of the keeper's visit (same schedule+date), so drop them.
        deleted_visits = bind.execute(
            text("DELETE FROM visits WHERE job_id = ANY(:drop)"),
            {"drop": drop},
        ).rowcount

        bind.execute(
            text("DELETE FROM jobs WHERE id = ANY(:ids)"),
            {"ids": drop},
        )
        print(
            f"[004] Collapsed {len(drop)} duplicate job(s) "
            f"(+{deleted_visits} visit(s)) for "
            f"schedule={sched_id} date={sched_date}; kept id={keep}"
        )

    op.create_index(
        "uq_jobs_schedule_date",
        "jobs",
        ["recurring_schedule_id", "scheduled_date"],
        unique=True,
        postgresql_where=text("recurring_schedule_id IS NOT NULL"),
    )


def downgrade():
    op.drop_index("uq_jobs_schedule_date", table_name="jobs")
