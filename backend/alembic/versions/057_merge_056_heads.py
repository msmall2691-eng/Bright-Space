"""
Alembic merge: unify the two 056 heads into one.

Two migrations independently branched off 055 and landed on main via separate
PRs — `056_job_pending_reschedule` (customer self-reschedule columns) and
`056_bathrooms_float` (bathrooms column type). Alembic then reports "multiple
heads", which the schema-drift guard rejects. This is a no-op merge that joins
both branches so there's a single head again.

Alembic version: 057
"""

# revision identifiers.
revision = "057_merge_056_heads"
down_revision = ("056_job_pending_reschedule", "056_bathrooms_float")
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No schema change — this only reconciles the two migration branches.
    pass


def downgrade() -> None:
    pass
