"""Phase 0: harden recurring schedule generation.

1. Backfill: collapse duplicate (recurring_schedule_id, scheduled_date) jobs.
   Keep the lowest id; cascade-delete dependent rows via FK relationships.
2. Add a partial unique index on jobs(recurring_schedule_id, scheduled_date)
   WHERE recurring_schedule_id IS NOT NULL. This is the database-level
   guarantee that ON CONFLICT DO NOTHING leans on in generate_jobs().

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

    # 1. Find duplicate (schedule_id, date) groups and keep the lowest id.
    #    Hard-delete the others. Visits cascade via the existing FK.
    duplicates = bind.execute(text("""
        SELECT recurring_schedule_id, scheduled_date, array_agg(id ORDER BY id) AS ids
        FROM jobs
        WHERE recurring_schedule_id IS NOT NULL
        GROUP BY recurring_schedule_id, scheduled_date
        HAVING count(*) > 1
    """)).fetchall()

    for sched_id, sched_date, ids in duplicates:
        keep, *drop = ids
        if drop:
            bind.execute(
                text("DELETE FROM jobs WHERE id = ANY(:ids)"),
                {"ids": drop},
            )
            print(
                f"[004] Collapsed {len(drop)} duplicate job(s) for "
                f"schedule={sched_id} date={sched_date}; kept id={keep}"
            )

    # 2. Partial unique index — Postgres permits multiple NULLs so non-recurring
    #    jobs are unaffected.
    op.create_index(
        "uq_jobs_schedule_date",
        "jobs",
        ["recurring_schedule_id", "scheduled_date"],
        unique=True,
        postgresql_where=text("recurring_schedule_id IS NOT NULL"),
    )


def downgrade():
    op.drop_index("uq_jobs_schedule_date", table_name="jobs")
