"""Record WHICH TEXT a subcontractor agreed to, not just which version string.

`sub_agreements` stored a version like "2026-09" and the model docstring says
the whole value of the table is "being able to say which text a person agreed
to and when". It could not: there was no text anywhere in the repo, and a
version string is not the document. Fixing a typo without bumping the version
would silently change what every past acceptance appears to mean.

So each acceptance now also carries a SHA-256 of the exact bytes the person was
shown (services/sub_agreement.py). Nullable, because rows written before this
migration genuinely do not have one and pretending otherwise would be worse
than a NULL — a NULL here means "signed before the text was under version
control", which is the truth.

Revision ID: 105_sub_agreement_text_hash
Revises: 104_rls_backfill_all_tenant_tables
"""
import sqlalchemy as sa
from alembic import op

revision = "105_sub_agreement_text_hash"
down_revision = "104_rls_backfill_all_tenant_tables"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("sub_agreements",
                  sa.Column("text_sha256", sa.String(64), nullable=True))


def downgrade():
    op.drop_column("sub_agreements", "text_sha256")
