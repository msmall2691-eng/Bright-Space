"""
Somebody asking to join the bench.

The last phase of the marketplace pivot, and deliberately the last: an apply
form is worthless until there is a file for an accepted sub to fill in (098), a
way to pay them (099), and work to offer them (100, 101). Building it first
would have collected applications the business couldn't do anything with.

An application is NOT a user, and this table is not `users`. Anyone on the
internet can create a row here; nobody can create a login. Approval is the step
that mints a crew account, and it is a person clicking a button.

NO SSN OR TIN, deliberately and permanently. A subcontractor's tax identifier
arrives later, inside the W-9 document stored in `sub_documents` — as bytes,
never parsed. `ein` is the only identifier with a column because it identifies
a BUSINESS, not a person, and because it is what the office needs in order to
know who they're contracting with. It is optional, and a sole proprietor should
leave it blank rather than typing their SSN into it — the form says so.

Revision ID: 102_sub_applications
Revises: 101_turnover_windows
"""
from alembic import op
import sqlalchemy as sa


revision = "102_sub_applications"
down_revision = "101_turnover_windows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sub_applications",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("email", sa.String(255), nullable=False, index=True),
        sa.Column("phone", sa.String(32), nullable=True),
        # The business they'd contract as. Blank is fine and common — plenty of
        # good subs are a person with a vacuum and no letterhead.
        sa.Column("business_name", sa.String(200), nullable=True),
        sa.Column("ein", sa.String(32), nullable=True),
        sa.Column("towns", sa.Text(), nullable=True),        # where they'll travel
        sa.Column("experience", sa.Text(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        # Self-reported, and treated as such: the real answers come from the
        # documents in sub_documents after they're accepted. These only decide
        # who is worth a phone call.
        sa.Column("has_insurance", sa.Boolean(), nullable=True),
        sa.Column("has_transport", sa.Boolean(), nullable=True),
        sa.Column("weekends", sa.Boolean(), nullable=True),
        sa.Column("source", sa.String(64), nullable=True),
        # new | reviewing | approved | declined
        sa.Column("status", sa.String(16), nullable=False, server_default="new"),
        sa.Column("notes", sa.Text(), nullable=True),        # office-only
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decided_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        # The crew account approval created, so an application can be traced to
        # the person it became — and so approving twice can't mint two logins.
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_sub_applications_org_status", "sub_applications",
                    ["org_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_sub_applications_org_status", table_name="sub_applications")
    op.drop_table("sub_applications")
