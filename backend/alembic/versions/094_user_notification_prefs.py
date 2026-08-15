"""User per-category notification preferences.

Additive only (R8): one nullable JSON column on users. NULL, or a missing key
within it, means the category is ON — this is an opt-OUT model so nobody's
existing push notifications go silent on deploy day; a user only stops
getting a category once they explicitly toggle it off from Settings (office)
or the Me tab (crew). See services/push_service.py for the gate and
modules/push/router.py for the GET/PATCH preferences endpoints.

Revision ID: 094_user_notification_prefs
Revises: 093_inbox_triage_gmail_trashed
"""
from alembic import op
import sqlalchemy as sa

revision = "094_user_notification_prefs"
down_revision = "093_inbox_triage_gmail_trashed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("notification_prefs", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "notification_prefs")
