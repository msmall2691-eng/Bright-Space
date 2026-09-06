"""A subcontractor can bring their own helper.

THIS IS ONE OF THE FIVE MAINE CRITERIA, not a convenience feature.

Maine's unified employment standard has a Part 1 where ALL FIVE must hold, and
#4 is: *the person hires, pays and supervises their own assistants, if any.*
BrightBase modelled exactly one cleaner per claim, so a sub could not bring
anyone — which makes #4 hard to satisfy in fact rather than on paper, and Part
1 is the half with no partial credit. `.claude/skills/brightbase-marketplace`
has carried this as a known gap since migration 104.

WHAT THIS TABLE DELIBERATELY DOES NOT HAVE, and why each absence is the point:

  * NO `user_id`, and no foreign key to `users`. A helper gets no BrightBase
    account, no login, no push, no vetting file. The moment TMCC onboards and
    clears the helper, the helper is TMCC's worker and the sub no longer hires
    their own assistant — which is the criterion inverted, at the cost of
    exactly the thing this table exists to establish.
  * NO rate, and no link to `sub_payouts`. The sub is paid the job's
    `agreed_rate` and pays their helper out of it. A helper the app pays is a
    person TMCC pays. `UNIQUE(user_id, job_id)` on sub_payouts already makes
    one payout per sub per job; nothing here may add a second.
  * NO office write path. The office cannot add a helper to a job. Choosing
    who else works it would be the office staffing the job, and a sub requests
    or accepts — the office never assigns.

What it IS for: the office knowing who is actually in a customer's house. That
is a real operational and insurance need, and it is the honest reason to record
a name at all.

`phone` is optional and exists for one purpose: reaching whoever is at the
house when the sub's phone is dead. It is not a contact record and nothing
messages it in bulk.

Revision ID: 107_job_helpers
Revises: 106_job_agreed_cleaner_id
"""
import sqlalchemy as sa
from alembic import op

revision = "107_job_helpers"
down_revision = "106_job_agreed_cleaner_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "job_helpers",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("job_id", sa.Integer(),
                  sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        # WHOSE helper this is — the sub who brought them, in the same crew-ID
        # string space as Job.cleaner_ids. Not nullable: a helper with nobody
        # responsible for them is the exact ambiguity this table must not
        # create. If two subs are ever on one job, each owns their own.
        sa.Column("sub_cleaner_id", sa.String(), nullable=False, index=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("phone", sa.String(32), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_job_helpers_job_sub", "job_helpers", ["job_id", "sub_cleaner_id"])

    # In the SAME migration that creates the table (brightbase-marketplace: the
    # trap that put sixteen tables on TENANT_TABLES with no policy behind them
    # for months). 104 swept everything that existed then; a table created
    # after it has to bring its own.
    from database.rls import apply_org_rls
    apply_org_rls(op.get_bind(), ["job_helpers"])


def downgrade() -> None:
    from database.rls import drop_org_rls
    drop_org_rls(op.get_bind(), ["job_helpers"])
    op.drop_index("ix_job_helpers_job_sub", table_name="job_helpers")
    op.drop_table("job_helpers")
