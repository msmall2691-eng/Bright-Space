"""Phase 2 scheduling redesign: schedule_events log + projection_state.

Additive only (R8): creates two new tenant tables and applies Postgres RLS to
them. No existing table is touched, nothing reads these yet, and the dual-write
that populates schedule_events is gated OFF by default (SCHEDULE_EVENT_LOG_ENABLED).

Revision ID: 068_schedule_event_log
Revises: 067_reconcile_lead_quote_links
"""
from alembic import op
import sqlalchemy as sa

revision = "068_schedule_event_log"
down_revision = "067_reconcile_lead_quote_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schedule_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=24), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("actor", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"]),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_schedule_events_id", "schedule_events", ["id"])
    op.create_index("ix_schedule_events_org_id", "schedule_events", ["org_id"])
    op.create_index("ix_schedule_events_job_id", "schedule_events", ["job_id"])
    op.create_index("ix_schedule_events_created_at", "schedule_events", ["created_at"])
    op.create_index("idx_schedule_events_job", "schedule_events", ["job_id", "id"])

    op.create_table(
        "projection_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.Column("target", sa.String(length=24), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("last_event_applied", sa.Integer(), nullable=True),
        sa.Column("last_push_at", sa.DateTime(), nullable=True),
        sa.Column("last_push_status", sa.String(length=16), nullable=True),
        sa.Column("drift_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("external_id", sa.String(), nullable=True),
        sa.Column("version", sa.String(length=64), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"]),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target", "job_id", name="uq_projection_state_target_job"),
    )
    op.create_index("ix_projection_state_id", "projection_state", ["id"])
    op.create_index("ix_projection_state_org_id", "projection_state", ["org_id"])
    op.create_index("ix_projection_state_job_id", "projection_state", ["job_id"])
    op.create_index("idx_projection_state_job", "projection_state", ["job_id"])

    # Apply Postgres RLS to the two new tenant tables. Migration 028's bulk apply
    # already ran on existing DBs and won't retroactively cover these, so do it
    # here (no-op on SQLite). Both names are also added to TENANT_TABLES so the
    # fresh-DB bootstrap covers them too.
    try:
        from database.rls import apply_org_rls
        apply_org_rls(op.get_bind(), tables=["schedule_events", "projection_state"])
    except Exception:
        # RLS is Postgres-only and best-effort here; bootstrap re-applies from
        # TENANT_TABLES regardless.
        pass


def downgrade() -> None:
    try:
        from database.rls import drop_org_rls
        drop_org_rls(op.get_bind(), tables=["schedule_events", "projection_state"])
    except Exception:
        pass
    op.drop_index("idx_projection_state_job", table_name="projection_state")
    op.drop_index("ix_projection_state_job_id", table_name="projection_state")
    op.drop_index("ix_projection_state_org_id", table_name="projection_state")
    op.drop_index("ix_projection_state_id", table_name="projection_state")
    op.drop_table("projection_state")
    op.drop_index("idx_schedule_events_job", table_name="schedule_events")
    op.drop_index("ix_schedule_events_created_at", table_name="schedule_events")
    op.drop_index("ix_schedule_events_job_id", table_name="schedule_events")
    op.drop_index("ix_schedule_events_org_id", table_name="schedule_events")
    op.drop_index("ix_schedule_events_id", table_name="schedule_events")
    op.drop_table("schedule_events")
