"""Crew self-service: time-off requests, private notes, office chat.

Three additive changes (R8):
- cleaner_time_off.status ('approved' server default — every existing
  office-entered row keeps its historical meaning) + requested_by_user_id.
  Crew-submitted requests arrive 'requested' and only count as OFF in the
  scheduling guards once approved; 'denied' is kept for the cleaner's own
  history.
- crew_docs.owner_user_id: NULL = company doc (unchanged); set = a PRIVATE
  note visible only to its owner — excluded from both the office list and
  the crew feed.
- crew_messages: one thread per cleaner user ↔ the office, push-notified
  both directions. In TENANT_TABLES.

Revision ID: 089_crew_requests_notes_messages
Revises: 088_crew_lead_and_calendar
"""
from alembic import op
import sqlalchemy as sa


revision = "089_crew_requests_notes_messages"
down_revision = "088_crew_lead_and_calendar"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cleaner_time_off",
        sa.Column("status", sa.String(length=12), nullable=False, server_default="approved"),
    )
    op.add_column(
        "cleaner_time_off",
        sa.Column("requested_by_user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column(
        "crew_docs",
        sa.Column("owner_user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
    )
    op.create_index("ix_crew_docs_owner_user_id", "crew_docs", ["owner_user_id"])
    op.create_table(
        "crew_messages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender", sa.String(length=8), nullable=False),
        sa.Column("sender_name", sa.String(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("read_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_crew_messages_org_id", "crew_messages", ["org_id"])
    op.create_index("ix_crew_messages_user_id", "crew_messages", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_crew_messages_user_id", table_name="crew_messages")
    op.drop_index("ix_crew_messages_org_id", table_name="crew_messages")
    op.drop_table("crew_messages")
    op.drop_index("ix_crew_docs_owner_user_id", table_name="crew_docs")
    op.drop_column("crew_docs", "owner_user_id")
    op.drop_column("cleaner_time_off", "requested_by_user_id")
    op.drop_column("cleaner_time_off", "status")
