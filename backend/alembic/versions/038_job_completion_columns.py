"""038 — add completion columns to jobs (PR-A of Job/Visit unification).

Adds the four fields Visit uniquely holds onto Job: completed_at, completed_by,
checklist_results, photos. This is the additive half of the unification — the
Visit table is retained for now so writes/reads keep working via the existing
visits_router; PR-C runs a follow-up migration that backfills any Visit rows
carrying completion data onto Job and drops the visits table.

See docs/job-visit-unification.md for the full 3-PR sequence.

Revision ID: 038_job_completion_columns
"""
from alembic import op
import sqlalchemy as sa

revision = "038_job_completion_columns"
down_revision = "037_drop_property_ical_url"
branch_labels = None
depends_on = None


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade():
    bind = op.get_bind()

    if not _has_column(bind, "jobs", "completed_at"):
        op.add_column("jobs", sa.Column("completed_at", sa.DateTime(), nullable=True))
    if not _has_column(bind, "jobs", "completed_by"):
        op.add_column("jobs", sa.Column("completed_by", sa.Integer(), nullable=True))
        # FK is optional on SQLite; declare on Postgres for prod parity.
        if bind.dialect.name == "postgresql":
            op.create_foreign_key(
                "fk_jobs_completed_by",
                "jobs", "users",
                ["completed_by"], ["id"], ondelete="SET NULL",
            )
    if not _has_column(bind, "jobs", "checklist_results"):
        op.add_column("jobs", sa.Column("checklist_results", sa.JSON(), nullable=True))
    if not _has_column(bind, "jobs", "photos"):
        # Default to empty list so old rows read back as [] instead of null.
        op.add_column("jobs", sa.Column("photos", sa.JSON(), nullable=True))


def downgrade():
    bind = op.get_bind()

    if _has_column(bind, "jobs", "photos"):
        op.drop_column("jobs", "photos")
    if _has_column(bind, "jobs", "checklist_results"):
        op.drop_column("jobs", "checklist_results")
    if _has_column(bind, "jobs", "completed_by"):
        if bind.dialect.name == "postgresql":
            try:
                op.drop_constraint("fk_jobs_completed_by", "jobs", type_="foreignkey")
            except Exception:
                pass
        op.drop_column("jobs", "completed_by")
    if _has_column(bind, "jobs", "completed_at"):
        op.drop_column("jobs", "completed_at")
