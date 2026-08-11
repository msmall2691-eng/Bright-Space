"""
Alembic migration: users.cleaner_id

Crew accounts (Phase 1 — native crew directory + "My Day" view). A cleaner-
role User needs to be matched against Job.cleaner_ids, which today holds
Connecteam employee IDs as strings (see CleanerTimeOff.cleaner_id docstring).
Rather than migrate every existing job assignment, this column lets an admin
link a cleaner's BrightBase login to their existing crew ID string — additive,
so nothing about Connecteam dispatch/payroll changes. A native-only crew
member (no Connecteam account) can also get a fresh string id here and be
assigned directly via Job.cleaner_ids going forward.

Nullable + indexed: NULL means "no crew ID linked yet" (most non-cleaner
users). Not unique — two admin logins could theoretically share a crew ID
during a transition, and the app doesn't need to forbid that.

Alembic version: 069
"""

from alembic import op
import sqlalchemy as sa


revision = "069_user_cleaner_id"
down_revision = "068_schedule_event_log"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("cleaner_id", sa.String(), nullable=True))
    op.create_index("ix_users_cleaner_id", "users", ["cleaner_id"])


def downgrade() -> None:
    op.drop_index("ix_users_cleaner_id", table_name="users")
    op.drop_column("users", "cleaner_id")
