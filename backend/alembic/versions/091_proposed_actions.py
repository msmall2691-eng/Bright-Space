"""Autopilot approval gate: proposed_actions.

An AI tick or persona records what it WANTS to do (assign a cleaner, send an
SMS) as a pending row here; a human approves or dismisses it, and approval
executes the action through the same write path a human uses (services/
proposals.py → scheduling's update_job / comms' send paths). Purely additive
(R8): one new tenant table, nothing existing touched, and no new background
tick reads it — the existing STR turnover auto-assign tick gains a 'propose'
mode that writes rows here instead of assigning (R1).

Generated with `alembic revision -m "proposed_actions"` off head
090_property_rental_pack, then renamed to the NNN_ convention (revision id
renamed with the file; down_revision untouched, straight from the real head).

Revision ID: 091_proposed_actions
Revises: 090_property_rental_pack
"""
from alembic import op
import sqlalchemy as sa


revision = "091_proposed_actions"
down_revision = "090_property_rental_pack"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "proposed_actions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("org_id", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(length=40), nullable=True),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        # pending | approved | dismissed | executed | failed — validated in
        # code (services/proposals.py), deliberately NOT a DB enum type.
        sa.Column("status", sa.String(length=20), nullable=False,
                  server_default="pending"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decided_by", sa.Integer(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["orgs.id"],
                                name="fk_proposed_actions_org_id"),
        sa.ForeignKeyConstraint(["decided_by"], ["users.id"],
                                name="fk_proposed_actions_decided_by"),
        sa.PrimaryKeyConstraint("id", name="pk_proposed_actions"),
    )
    op.create_index("ix_proposed_actions_id", "proposed_actions", ["id"])
    op.create_index("ix_proposed_actions_org_id", "proposed_actions", ["org_id"])
    op.create_index("ix_proposed_actions_status", "proposed_actions", ["status"])
    op.create_index("idx_proposed_actions_org_status", "proposed_actions",
                    ["org_id", "status"])

    # Apply Postgres RLS to the new tenant table (mirrors migrations 068/070's
    # pattern). No-op on SQLite; "proposed_actions" is also in TENANT_TABLES so
    # the fresh-DB bootstrap covers it too.
    try:
        from database.rls import apply_org_rls
        apply_org_rls(op.get_bind(), tables=["proposed_actions"])
    except Exception:
        # RLS is Postgres-only and best-effort here; bootstrap re-applies from
        # TENANT_TABLES regardless.
        pass


def downgrade() -> None:
    try:
        from database.rls import drop_org_rls
        drop_org_rls(op.get_bind(), tables=["proposed_actions"])
    except Exception:
        pass
    op.drop_index("idx_proposed_actions_org_status", table_name="proposed_actions")
    op.drop_index("ix_proposed_actions_status", table_name="proposed_actions")
    op.drop_index("ix_proposed_actions_org_id", table_name="proposed_actions")
    op.drop_index("ix_proposed_actions_id", table_name="proposed_actions")
    op.drop_table("proposed_actions")
