"""
Alembic migration: conversations.assignee_user_id

Phase F (CRM): make the conversation assignee a real user reference instead of a
free-text string. Adds a nullable ``assignee_user_id`` column (FK to users
declared at the ORM layer, matching this repo's convention of plain Integer
columns in migrations — see 049). The legacy ``assignee`` STRING column is kept
as the display label + back-compat, so this is fully additive and non-
destructive: nothing breaks until the assign endpoint starts populating the id.

No data backfill here — historical string assignments keep rendering from the
``assignee`` column; new assignments set both. (Cross-dialect string→user
matching in raw SQL is fragile, so it's intentionally left to the app.)

Alembic version: 063
"""

from alembic import op
import sqlalchemy as sa


revision = "063_conversation_assignee_user"
down_revision = "062_push_subscriptions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("conversations", sa.Column("assignee_user_id", sa.Integer(), nullable=True))
    op.create_index("ix_conversations_assignee_user_id", "conversations", ["assignee_user_id"])


def downgrade() -> None:
    op.drop_index("ix_conversations_assignee_user_id", table_name="conversations")
    op.drop_column("conversations", "assignee_user_id")
