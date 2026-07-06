"""
Alembic migration: one job per quote

Adds a partial UNIQUE index on jobs.quote_id (NULLs excluded, so ad-hoc jobs
with no quote are unaffected). DB-level backstop for the accept / convert-to-job
race where two concurrent conversions could both insert a Job for one quote.
The app also locks the quote row (with_for_update) and catches IntegrityError.

NOTE: if a prior double-conversion already left duplicate jobs for a quote,
creating this index will FAIL. Resolve duplicates first:

    SELECT quote_id, count(*) FROM jobs
    WHERE quote_id IS NOT NULL GROUP BY quote_id HAVING count(*) > 1;

Alembic version: 043
"""

from alembic import op
import sqlalchemy as sa


revision = "043_unique_job_quote"
down_revision = "042_drop_lead_intake_followed_up_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "uq_jobs_quote_id", "jobs", ["quote_id"], unique=True,
        postgresql_where=sa.text("quote_id IS NOT NULL"), if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("uq_jobs_quote_id", table_name="jobs", if_exists=True)
