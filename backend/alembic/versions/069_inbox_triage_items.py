"""Inbox triage: capture the automated/bulk email stream for the Ops Board.

Additive only (R8): creates one new tenant table (inbox_triage_items) and applies
Postgres RLS to it. No existing table is touched. The table is populated by the
inbound Gmail sync (services/inbox_triage) and read by the board's "Systems &
Subscriptions" / "Safe to Ignore" sections; both degrade to empty when it's bare.

Revision ID: 069_inbox_triage_items
Revises: 068_schedule_event_log
"""
from alembic import op
import sqlalchemy as sa

revision = "069_inbox_triage_items"
down_revision = "068_schedule_event_log"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "inbox_triage_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.Column("external_id", sa.String(), nullable=True),
        sa.Column("source_account_id", sa.Integer(), nullable=True),
        sa.Column("from_addr", sa.String(), nullable=True),
        sa.Column("from_name", sa.String(), nullable=True),
        sa.Column("subject", sa.String(), nullable=True),
        sa.Column("snippet", sa.Text(), nullable=True),
        sa.Column("received_at", sa.DateTime(), nullable=True),
        sa.Column("category", sa.String(), nullable=False, server_default="other"),
        sa.Column("section", sa.String(), nullable=False, server_default="safe_to_ignore"),
        sa.Column("vendor", sa.String(), nullable=True),
        sa.Column("unsubscribe_url", sa.String(), nullable=True),
        sa.Column("classified_by", sa.String(), nullable=False, server_default="rules"),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("dismissed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"]),
        sa.ForeignKeyConstraint(["source_account_id"], ["user_google_accounts.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_inbox_triage_items_id", "inbox_triage_items", ["id"])
    op.create_index("ix_inbox_triage_items_org_id", "inbox_triage_items", ["org_id"])
    op.create_index("ix_inbox_triage_items_external_id", "inbox_triage_items", ["external_id"])
    op.create_index("ix_inbox_triage_items_received_at", "inbox_triage_items", ["received_at"])
    op.create_index("idx_inbox_triage_org_section", "inbox_triage_items",
                    ["org_id", "section", "dismissed_at"])

    # Apply Postgres RLS to the new tenant table (no-op on SQLite). Migration 028's
    # bulk apply already ran on existing DBs and won't retroactively cover this, so
    # do it here; the name is also added to TENANT_TABLES so the fresh-DB bootstrap
    # covers it too.
    try:
        from database.rls import apply_org_rls
        apply_org_rls(op.get_bind(), tables=["inbox_triage_items"])
    except Exception:
        # RLS is Postgres-only and best-effort here; bootstrap re-applies from
        # TENANT_TABLES regardless.
        pass


def downgrade() -> None:
    try:
        from database.rls import drop_org_rls
        drop_org_rls(op.get_bind(), tables=["inbox_triage_items"])
    except Exception:
        pass
    op.drop_index("idx_inbox_triage_org_section", table_name="inbox_triage_items")
    op.drop_index("ix_inbox_triage_items_received_at", table_name="inbox_triage_items")
    op.drop_index("ix_inbox_triage_items_external_id", table_name="inbox_triage_items")
    op.drop_index("ix_inbox_triage_items_org_id", table_name="inbox_triage_items")
    op.drop_index("ix_inbox_triage_items_id", table_name="inbox_triage_items")
    op.drop_table("inbox_triage_items")
