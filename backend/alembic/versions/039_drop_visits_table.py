"""039 — retire the visits table (PR-C of Job/Visit unification).

Third and final step of docs/job-visit-unification.md.

PR-A added completion columns to jobs; PR-B moved the frontend to /api/jobs
and /api/jobs/{id}/complete. This migration finishes the job:

  1. Backfill any visits row whose completion data hasn't already been mirrored
     onto its Job. `jobs` was written to by the new /api/jobs/{id}/complete
     endpoint, but old Visits completed via PATCH /api/visits/{id} still hold
     the source of truth for pre-migration completions. For each visits row
     whose Job has a NULL completed_at / checklist_results / photos, copy the
     Visit's values onto the Job.
  2. Drop the row-level-security policy on visits (Postgres only; no-op on
     SQLite) so the table drop isn't blocked.
  3. Drop the visits table.

Downgrade is best-effort: recreate the visits schema from the migration-018
shape plus the org_id column added in 027; do NOT try to reconstruct the row
history — the completion columns still live on jobs, and the schedule
generators re-populate visits on next boot if needed. See §5.4 of the
design doc.

Revision ID: 039_drop_visits_table
"""
from alembic import op
import sqlalchemy as sa

from database.rls import apply_org_rls, drop_org_rls

revision = "039_drop_visits_table"
down_revision = "038_job_completion_columns"
branch_labels = None
depends_on = None


def _has_table(bind, name) -> bool:
    return name in set(sa.inspect(bind).get_table_names())


def upgrade():
    bind = op.get_bind()

    if _has_table(bind, "visits"):
        # DISTINCT ON (job_id) picks the most-recently-completed Visit per Job.
        # Cross-dialect: Postgres supports DISTINCT ON; SQLite (tests) doesn't
        # know that syntax, so run the equivalent MAX-completed_at join there.
        if bind.dialect.name == "postgresql":
            op.execute(sa.text("""
                UPDATE jobs
                SET
                    completed_at      = COALESCE(jobs.completed_at, v.completed_at),
                    completed_by      = COALESCE(jobs.completed_by, v.completed_by),
                    checklist_results = COALESCE(jobs.checklist_results, v.checklist_results),
                    photos            = CASE
                                            WHEN jobs.photos IS NULL OR jobs.photos::text = '[]'
                                                THEN COALESCE(v.photos, jobs.photos)
                                            ELSE jobs.photos
                                        END
                FROM (
                    SELECT DISTINCT ON (job_id)
                        job_id, completed_at, completed_by, checklist_results, photos
                    FROM visits
                    WHERE completed_at IS NOT NULL
                       OR checklist_results IS NOT NULL
                       OR photos IS NOT NULL
                    ORDER BY job_id, completed_at DESC NULLS LAST, id DESC
                ) v
                WHERE jobs.id = v.job_id
                  AND (jobs.completed_at IS NULL
                       OR jobs.completed_by IS NULL
                       OR jobs.checklist_results IS NULL)
            """))
        else:
            # SQLite fallback: iterate in Python. Small enough tables in tests
            # that this doesn't matter for perf.
            conn = bind
            rows = conn.execute(sa.text("""
                SELECT job_id, completed_at, completed_by, checklist_results, photos
                FROM visits
                WHERE completed_at IS NOT NULL
                   OR checklist_results IS NOT NULL
                   OR photos IS NOT NULL
            """)).fetchall()
            per_job = {}
            for r in rows:
                # Last one wins by insertion order — matches the DISTINCT ON
                # newest-first Postgres path within this simple test context.
                per_job[r.job_id] = r
            for job_id, r in per_job.items():
                conn.execute(sa.text("""
                    UPDATE jobs
                    SET completed_at      = COALESCE(completed_at, :ca),
                        completed_by      = COALESCE(completed_by, :cb),
                        checklist_results = COALESCE(checklist_results, :cr),
                        photos            = CASE
                                              WHEN photos IS NULL OR photos = '[]'
                                                  THEN COALESCE(:ph, photos)
                                              ELSE photos
                                            END
                    WHERE id = :jid
                """), {
                    "ca": r.completed_at,
                    "cb": r.completed_by,
                    "cr": r.checklist_results,
                    "ph": r.photos,
                    "jid": job_id,
                })

        drop_org_rls(bind, tables=["visits"])
        op.drop_table("visits")


def downgrade():
    bind = op.get_bind()

    if not _has_table(bind, "visits"):
        op.create_table(
            "visits",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("org_id", sa.Integer(), nullable=True),
            sa.Column(
                "job_id", sa.Integer(),
                sa.ForeignKey("jobs.id"), nullable=False, index=True,
            ),
            sa.Column("scheduled_date", sa.Date(), nullable=False, index=True),
            sa.Column("start_time", sa.Time(), nullable=False),
            sa.Column("end_time", sa.Time(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default="scheduled"),
            sa.Column("cleaner_ids", sa.JSON(), server_default="[]"),
            sa.Column("ical_source", sa.String(), nullable=True),
            sa.Column("ical_uid", sa.String(), nullable=True, index=True),
            sa.Column("ical_synced_at", sa.DateTime(), nullable=True),
            sa.Column("gcal_event_id", sa.String(), nullable=True),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
            sa.Column("completed_by", sa.Integer(), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("checklist_results", sa.JSON(), nullable=True),
            sa.Column("photos", sa.JSON(), server_default="[]"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("ical_source", "ical_uid", name="uq_visit_ical_source_uid"),
        )
        op.create_index("ix_visits_org_id", "visits", ["org_id"])
        op.create_index("idx_visit_scheduled_date_status", "visits", ["scheduled_date", "status"])
        op.create_index("idx_visit_job_date", "visits", ["job_id", "scheduled_date"])
        apply_org_rls(bind, tables=["visits"])
