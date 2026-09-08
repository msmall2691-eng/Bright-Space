"""Record WHY a claim request was declined.

A sub who asked for four jobs on Tuesday and lost them all had no way to learn
why — the office declined with a status and no words, and the crew "my asks"
screen could only say "someone else got it". A short reason the office types
("went with someone closer", "held for a regular") is the difference between a
sub who can bid better next time and one who quietly stops asking.

`reason` is a plain nullable string on job_claim_requests. Null for every
existing row, which is exactly right: no reason was ever captured for them, and
inventing one would be worse than silence. Additive and fully reversible — the
downgrade drops the column and loses only reasons entered after this shipped,
which is the honest cost of removing the feature.

The table already carries org_id and is covered by Postgres RLS (see
database/rls.py TENANT_TABLES); adding a column doesn't change that, so there
is no apply_org_rls call to make here.

Revision ID: 111_claim_request_reason
Revises: 110_job_and_property_price
"""
import sqlalchemy as sa
from alembic import op

revision = "111_claim_request_reason"
down_revision = "110_job_and_property_price"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("job_claim_requests", sa.Column("reason", sa.String(), nullable=True))


def downgrade():
    op.drop_column("job_claim_requests", "reason")
