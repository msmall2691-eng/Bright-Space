"""033b — widen alembic_version.version_num to VARCHAR(128).

Alembic's default `alembic_version.version_num` column is VARCHAR(32). This
codebase's migration ids are descriptive names like
`034_merge_quote_requests_into_lead_intakes` (42 chars), which is why
scripts/db_bootstrap.py widens the column before calling `alembic upgrade`
on an *existing* database. But that widen step runs outside of, and before,
Alembic's own migration transaction — it can't help a from-scratch replay,
where `alembic_version` doesn't exist yet until Alembic creates it (with the
default width) as part of the same transaction that then tries to write a
>32-char id and fails with StringDataRightTruncation.

Widening it here, as a real migration step, makes the fix part of the chain
itself so it applies uniformly whether this is a fresh install or an
incremental upgrade of a database that already went through db_bootstrap's
external widen. Inserted right before the first revision id that actually
exceeds 32 characters (034_merge_quote_requests_into_lead_intakes).
"""
from alembic import op

revision = "033b_widen_alembic_version"
down_revision = "033_canonical_client_source"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # SQLite ignores column type changes; no-op there.
    op.execute("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(128)")


def downgrade():
    # Not reversible in general (a longer id may already be stored), and
    # narrowing back to VARCHAR(32) serves no purpose. No-op.
    pass
