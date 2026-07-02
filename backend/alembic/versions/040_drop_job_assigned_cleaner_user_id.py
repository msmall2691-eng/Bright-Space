"""040 — drop dead jobs.assigned_cleaner_user_id column.

The column was introduced in migration 001 with the comment
"Future: replace cleaner_ids JSON" and never wired up. Nothing reads or
writes it — `Job.cleaner_ids` (JSON list) has always been the actual
assignment source. Since the Job/Visit unification (migrations 038/039)
also removed the third assignment mechanism, the plan's B3 recommendation
("settle on one source of truth") reduces to: drop the dead FK.

Downgrade re-adds the column nullable and re-creates the index.

Revision ID: 040_drop_job_assigned_cleaner_user_id
"""
from alembic import op
import sqlalchemy as sa

revision = "040_drop_job_assigned_cleaner_user_id"
down_revision = "039_drop_visits_table"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_jobs_assigned_cleaner_user_id"


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def _has_index(bind, table, name) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return name in {ix["name"] for ix in insp.get_indexes(table)}


def upgrade():
    bind = op.get_bind()
    if _has_column(bind, "jobs", "assigned_cleaner_user_id"):
        if _has_index(bind, "jobs", _INDEX_NAME):
            try:
                op.drop_index(_INDEX_NAME, table_name="jobs")
            except Exception:
                pass
        # Postgres carries an implicit FK constraint from migration 001; drop
        # it before the column so drop_column doesn't fail. SQLite doesn't
        # name FKs (they're inline), so skip there.
        if bind.dialect.name == "postgresql":
            try:
                op.execute(sa.text("""
                    ALTER TABLE jobs
                    DROP CONSTRAINT IF EXISTS jobs_assigned_cleaner_user_id_fkey
                """))
            except Exception:
                pass
        op.drop_column("jobs", "assigned_cleaner_user_id")


def downgrade():
    bind = op.get_bind()
    if not _has_column(bind, "jobs", "assigned_cleaner_user_id"):
        op.add_column(
            "jobs",
            sa.Column("assigned_cleaner_user_id", sa.Integer(), nullable=True),
        )
        if bind.dialect.name == "postgresql":
            try:
                op.create_foreign_key(
                    "jobs_assigned_cleaner_user_id_fkey",
                    "jobs", "users",
                    ["assigned_cleaner_user_id"], ["id"],
                )
            except Exception:
                pass
    if not _has_index(bind, "jobs", _INDEX_NAME):
        op.create_index(_INDEX_NAME, "jobs", ["assigned_cleaner_user_id"])
