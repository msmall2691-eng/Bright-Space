"""
Alembic migration: one job per quote

Adds a partial UNIQUE index on jobs.quote_id (NULLs excluded, so ad-hoc jobs
with no quote are unaffected). DB-level backstop for the accept / convert-to-job
race where two concurrent conversions could both insert a Job for one quote.
The app also locks the quote row (with_for_update) and catches IntegrityError.

NOTE: if a prior double-conversion already left duplicate jobs for a quote,
creating this index will FAIL. Resolve duplicates BEFORE re-running the
migration -- do NOT blind-delete the loser, because a Job can have visits
and invoices hanging off it and DELETE will orphan them.

Safe resolution flow (run against the production Postgres):

  -- 1. Inspect the duplicates and their child-row counts. The row with real
  --    scheduling/billing history is your keeper; usually the oldest one.
  SELECT j.id AS job_id, j.quote_id, j.created_at, j.status,
         (SELECT count(*) FROM visits   v WHERE v.job_id = j.id) AS visits,
         (SELECT count(*) FROM invoices i WHERE i.job_id = j.id) AS invoices
  FROM jobs j
  WHERE j.quote_id IN (
    SELECT quote_id FROM jobs
    WHERE quote_id IS NOT NULL
    GROUP BY quote_id HAVING count(*) > 1
  )
  ORDER BY j.quote_id, j.created_at;

  -- 2a. If the loser has NO visits/invoices, delete it directly:
  DELETE FROM jobs WHERE id = <loser_job_id>;

  -- 2b. If the loser DOES have child rows, repoint them to the keeper first,
  --     then delete the loser row. Same transaction to keep it atomic.
  BEGIN;
    UPDATE visits   SET job_id = <keeper_job_id> WHERE job_id = <loser_job_id>;
    UPDATE invoices SET job_id = <keeper_job_id> WHERE job_id = <loser_job_id>;
    DELETE FROM jobs WHERE id = <loser_job_id>;
  COMMIT;

  -- 3. Retrigger the deploy. The unique index will build cleanly.

Once this migration is live, the app-side lock (public_accept_quote uses
SELECT ... FOR UPDATE on the quote row) + IntegrityError handling in
_convert_quote_to_job prevent the double-insert from recurring.

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
