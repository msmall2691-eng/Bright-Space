"""Native crew time clock: time_entries.

Phase 2a of the native crew app. Additive only (R8): creates one new tenant
table and applies Postgres RLS to it. No existing table is touched, and nothing
in payroll reads it — payroll still sources hours from Connecteam. This table
exists to let a cleaner clock in/out natively and to accumulate real hours to
reconcile against Connecteam before any cutover.

Revision ID: 070_time_entries
Revises: 069_user_cleaner_id
"""
from alembic import op
import sqlalchemy as sa


revision = "070_time_entries"
down_revision = "069_user_cleaner_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "time_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=True),
        sa.Column("cleaner_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("job_id", sa.Integer(), nullable=True),
        sa.Column("clock_in_at", sa.DateTime(), nullable=False),
        sa.Column("clock_out_at", sa.DateTime(), nullable=True),
        sa.Column("break_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=16), nullable=False, server_default="native"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_time_entries_id", "time_entries", ["id"])
    op.create_index("ix_time_entries_org_id", "time_entries", ["org_id"])
    op.create_index("ix_time_entries_cleaner_id", "time_entries", ["cleaner_id"])
    op.create_index("ix_time_entries_job_id", "time_entries", ["job_id"])
    op.create_index("idx_time_entry_cleaner_open", "time_entries", ["cleaner_id", "clock_out_at"])
    op.create_index("idx_time_entry_cleaner_in", "time_entries", ["cleaner_id", "clock_in_at"])

    # Apply Postgres RLS to the new tenant table (mirrors migration 068's
    # pattern). No-op on SQLite; "time_entries" is also in TENANT_TABLES so the
    # fresh-DB bootstrap covers it too.
    try:
        from database.rls import apply_org_rls
        apply_org_rls(op.get_bind(), tables=["time_entries"])
    except Exception:
        # RLS is Postgres-only and best-effort here; bootstrap re-applies from
        # TENANT_TABLES regardless.
        pass


def downgrade() -> None:
    try:
        from database.rls import drop_org_rls
        drop_org_rls(op.get_bind(), tables=["time_entries"])
    except Exception:
        pass
    op.drop_index("idx_time_entry_cleaner_in", table_name="time_entries")
    op.drop_index("idx_time_entry_cleaner_open", table_name="time_entries")
    op.drop_index("ix_time_entries_job_id", table_name="time_entries")
    op.drop_index("ix_time_entries_cleaner_id", table_name="time_entries")
    op.drop_index("ix_time_entries_org_id", table_name="time_entries")
    op.drop_index("ix_time_entries_id", table_name="time_entries")
    op.drop_table("time_entries")
