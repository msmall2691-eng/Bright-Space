"""
Alembic migration: add 'unscheduled' to jobs.status CHECK constraint

Schema drift bug, confirmed live: migration 008 added
ck_jobs_status IN ('scheduled','in_progress','completed','cancelled') — but
modules/quoting/router.py's quote-to-job conversion (the documented "convert
without a full schedule" path, in production use since before this
constraint existed) inserts Job(status="unscheduled", ...). On Postgres this
throws a CheckViolation (surfaced as sqlalchemy.exc.IntegrityError) on every
single unscheduled conversion. The router's `except IntegrityError` was
written for a DIFFERENT case (a concurrent race on the quote_id unique
index) and silently swallows this one too — the job is never created, the
quote never flips to 'converted', and the caller gets back None with no
error surfaced. modules/scheduling/router.py's own JOB_STATUSES set
(canonical list) and database/models.py's Job.status comment both already
documented "unscheduled" as a first-class status; only this CHECK constraint
was never updated to match.

Alembic version: 053
"""
from alembic import op
from sqlalchemy import text


revision = "053_add_unscheduled_to_job_status_check"
down_revision = "052_ical_turnover_dedup_hardening"
branch_labels = None
depends_on = None

_OLD = "status IN ('scheduled', 'in_progress', 'completed', 'cancelled')"
_NEW = "status IN ('unscheduled', 'scheduled', 'in_progress', 'completed', 'cancelled')"


def upgrade() -> None:
    op.drop_constraint("ck_jobs_status", "jobs", type_="check")
    op.create_check_constraint("ck_jobs_status", "jobs", _NEW)


def downgrade() -> None:
    # Guard against downgrading with 'unscheduled' rows already present —
    # dropping back to the narrower constraint would immediately fail with
    # those rows in place, exactly the bug this migration fixes.
    bind = op.get_bind()
    stuck = bind.execute(
        text("SELECT count(*) FROM jobs WHERE status = 'unscheduled'")
    ).scalar()
    if stuck:
        raise RuntimeError(
            f"Cannot downgrade: {stuck} job(s) have status='unscheduled', which "
            f"would violate the narrower pre-053 CHECK constraint. Reassign or "
            f"cancel them first."
        )
    op.drop_constraint("ck_jobs_status", "jobs", type_="check")
    op.create_check_constraint("ck_jobs_status", "jobs", _OLD)
