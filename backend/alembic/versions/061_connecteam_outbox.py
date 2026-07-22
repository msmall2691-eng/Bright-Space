"""
Alembic migration: connecteam_outbox (transactional outbox for shift sync)

Durability hardening for Connecteam sync. Dispatching/removing a shift inline
had two failure modes: the API call succeeds but the request rolls back (orphan
shift), or a double-submit / concurrent path creates a duplicate shift. This
table lets job-change paths ENQUEUE a sync intent in the same transaction as
the job change; a background drain performs the Connecteam call.

- dedupe_key UNIQUE → enqueuing the same intent twice collapses to one row.
- the drain claims a row with FOR UPDATE SKIP LOCKED → processed once.

Additive and non-destructive: a new table only. Behavior is gated by the
connecteam_outbox_enabled setting, so creating the table changes nothing until
the operator opts in.

Alembic version: 061
"""

from alembic import op
import sqlalchemy as sa


revision = "061_connecteam_outbox"
down_revision = "060_recurring_anchor_date"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "connecteam_outbox",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("op", sa.String(length=16), nullable=False),
        sa.Column("dedupe_key", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False,
                  server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("processed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"]),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("dedupe_key", name="uq_connecteam_outbox_dedupe_key"),
    )
    op.create_index("ix_connecteam_outbox_id", "connecteam_outbox", ["id"])
    op.create_index("ix_connecteam_outbox_org_id", "connecteam_outbox", ["org_id"])
    op.create_index("ix_connecteam_outbox_job_id", "connecteam_outbox", ["job_id"])
    op.create_index("ix_connecteam_outbox_status", "connecteam_outbox", ["status"])
    op.create_index("idx_connecteam_outbox_status", "connecteam_outbox",
                    ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("idx_connecteam_outbox_status", table_name="connecteam_outbox")
    op.drop_index("ix_connecteam_outbox_status", table_name="connecteam_outbox")
    op.drop_index("ix_connecteam_outbox_job_id", table_name="connecteam_outbox")
    op.drop_index("ix_connecteam_outbox_org_id", table_name="connecteam_outbox")
    op.drop_index("ix_connecteam_outbox_id", table_name="connecteam_outbox")
    op.drop_table("connecteam_outbox")
