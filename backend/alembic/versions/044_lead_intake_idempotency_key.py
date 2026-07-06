"""
Alembic migration: idempotency key on lead intakes

Adds `lead_intakes.idempotency_key` (nullable TEXT, unique index) so the public
booking / intake endpoints can collapse retries, dual-forwards from the
maineclean.co Express middle layer, and the two-endpoint (booking + intake)
pattern into a single Lead row. The 5-minute recency SELECT that used to be
the only defense was racy — two concurrent submits both saw an empty match
and both inserted; this key gives the DB the last word.

Nullable so pre-migration rows and any non-website callers (Gmail auto-enrich,
manual paste-a-lead) still work unchanged.

Alembic version: 044
"""

from alembic import op
import sqlalchemy as sa


revision = "044_lead_intake_idempotency_key"
down_revision = "043_unique_job_quote"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "lead_intakes",
        sa.Column("idempotency_key", sa.String(length=64), nullable=True),
    )
    # Unique so a repeat POST with the same key hits IntegrityError instead of
    # inserting a duplicate. Partial index — NULLs excluded — because
    # pre-migration rows and non-website callers legitimately share NULL.
    op.create_index(
        "uq_lead_intakes_idempotency_key",
        "lead_intakes",
        ["idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_lead_intakes_idempotency_key",
        table_name="lead_intakes",
        if_exists=True,
    )
    op.drop_column("lead_intakes", "idempotency_key")
