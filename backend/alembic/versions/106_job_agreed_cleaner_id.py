"""Record WHO agreed the rate, not just what it was.

`jobs.agreed_rate` is a flat price one subcontractor negotiated for one job.
Payroll paid it to anyone whose crew ID appeared in `Job.cleaner_ids`:

    if agreed > 0 and cid in (job.cleaner_ids or []):

That is membership in the assignment list, not identity with the person who
agreed the number. Add a helper to a job agreed at $100 with sub A and both
clock in — payroll pays A $100 and B $100. $200 out on a $100 job, silently,
every pay run.

It also could not be cleared. `agreed_rate` was written in two places and
cleared nowhere, and is not a field on JobUpdate, so no API path existed to
unset it. Reassign the job away from the sub and an hourly employee inherits
their flat rate.

Both are the same missing fact: the row said what was agreed and not with
whom. `agreed_cleaner_id` is that fact, denormalised onto the Job on purpose —
the two producers (an approved claim request, and a route occurrence assigned
to its owner) both know it at write time, and only one of them has a
JobClaimRequest to join back to.

BACKFILL. Existing rows get it from whichever producer made them:
  * an approved job_claim_requests row for that job, else
  * the job's sole assigned cleaner, when there is exactly one — unambiguous,
    and identical to what payroll already pays them today.
A job with agreed_rate, several cleaners and no approved request is exactly the
ambiguous case this column exists to end; it is left NULL rather than guessed
at, and payroll reports it instead of paying it.

Revision ID: 106_job_agreed_cleaner_id
Revises: 105_sub_agreement_text_hash
"""
import sqlalchemy as sa
from alembic import op

revision = "106_job_agreed_cleaner_id"
down_revision = "105_sub_agreement_text_hash"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("jobs", sa.Column("agreed_cleaner_id", sa.String(), nullable=True))

    bind = op.get_bind()

    # 1. The winner of an approved claim request.
    bind.execute(sa.text("""
        UPDATE jobs SET agreed_cleaner_id = (
            SELECT r.cleaner_id FROM job_claim_requests r
             WHERE r.job_id = jobs.id AND r.status = 'approved'
             ORDER BY r.decided_at DESC, r.id DESC LIMIT 1)
         WHERE agreed_rate IS NOT NULL
           AND agreed_cleaner_id IS NULL
           AND EXISTS (SELECT 1 FROM job_claim_requests r2
                        WHERE r2.job_id = jobs.id AND r2.status = 'approved')
    """))

    # 2. Route occurrences and anything else with exactly one cleaner on it.
    #    JSON array length is spelled differently per backend, so this is done
    #    in Python rather than in one clever portable SQL statement.
    rows = bind.execute(sa.text(
        "SELECT id, cleaner_ids FROM jobs "
        "WHERE agreed_rate IS NOT NULL AND agreed_cleaner_id IS NULL")).fetchall()
    import json
    for job_id, raw in rows:
        try:
            ids = raw if isinstance(raw, list) else json.loads(raw or "[]")
        except (TypeError, ValueError):
            continue
        ids = [str(c) for c in (ids or []) if str(c).strip()]
        if len(ids) == 1:
            bind.execute(
                sa.text("UPDATE jobs SET agreed_cleaner_id = :c WHERE id = :i"),
                {"c": ids[0], "i": job_id})


def downgrade():
    op.drop_column("jobs", "agreed_cleaner_id")
