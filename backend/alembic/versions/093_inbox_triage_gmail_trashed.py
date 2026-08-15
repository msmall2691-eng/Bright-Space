"""Inbox triage: track whether a triaged email was moved to Gmail Trash.

Additive only (R8): one nullable-with-default column on inbox_triage_items. Set
when the board's "Delete" action trashes the underlying email via gmail.modify;
powers the Undo (untrash) path. No existing row/table is otherwise touched.

Revision ID: 093_inbox_triage_gmail_trashed
Revises: 092_mileage_geo_columns
"""
from alembic import op
import sqlalchemy as sa

revision = "093_inbox_triage_gmail_trashed"
down_revision = "092_mileage_geo_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "inbox_triage_items",
        sa.Column("gmail_trashed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("inbox_triage_items", "gmail_trashed")
