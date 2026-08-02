"""
Alembic migration: user_google_accounts.gmail_history_id

Phase E (email sync): store the Gmail History API cursor per connected account
so inbox sync can be INCREMENTAL (fetch only messages added since the last
historyId) instead of re-scanning the newest N messages every poll — cheaper
and complete (no fixed cap). Additive, nullable; NULL means "first sync, do a
full scan and seed the cursor." Uses the existing gmail.readonly scope — no new
consent.

Alembic version: 064
"""

from alembic import op
import sqlalchemy as sa


revision = "064_gmail_history_cursor"
down_revision = "063_conversation_assignee_user"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_google_accounts", sa.Column("gmail_history_id", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("user_google_accounts", "gmail_history_id")
