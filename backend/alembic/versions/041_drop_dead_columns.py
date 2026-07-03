"""041 — drop seven dead columns from four tables.

Each column was declared but never actually used in the way it was
originally intended, verified column-by-column:

  user_google_accounts.gmail_history_id  — reserved for incremental Gmail
    sync; the sync loop was never implemented (still fetches from scratch).
  user_google_accounts.gcal_calendar_id  — never written or read; the
    default-calendar lookup uses env vars (see admin/router.py:612).
  user_google_accounts.gcal_sync_token   — reserved for incremental gcal
    sync; the sync uses `updatedMin` timestamps instead.
  jobs.gcal_external_updated_at          — written in three spots in
    integrations/gcal_sync.py but never read. Original comment said
    "kept for drift detection" but no drift-detection code exists.
  contact_emails.verified_at             — never written; the read at
    clients/router.py:862 (`ce.verified_at is not None`) always returns
    False. This PR replaces the read with a literal False.
  integration_events.error_code          — never written; the read at
    integration_events/router.py:29 and the `e.error_message or e.error_code`
    fallback in scheduling/router.py:1228 both simplify.
  integration_events.response_payload    — never written; the read at
    integration_events/router.py:31 always returns None.

Downgrade re-adds all seven columns nullable (so a rollback restores the
schema without needing a backfill).

Revision ID: 041_drop_dead_columns
"""
from alembic import op
import sqlalchemy as sa

revision = "041_drop_dead_columns"
down_revision = "040_drop_job_assigned_cleaner_user_id"
branch_labels = None
depends_on = None


DEAD_COLUMNS = [
    # (table, column, sqlalchemy type for re-add on downgrade)
    ("user_google_accounts", "gmail_history_id",      sa.String(length=32)),
    ("user_google_accounts", "gcal_calendar_id",      sa.String(length=255)),
    ("user_google_accounts", "gcal_sync_token",       sa.Text()),
    ("jobs",                 "gcal_external_updated_at", sa.DateTime(timezone=True)),
    ("contact_emails",       "verified_at",           sa.DateTime()),
    ("integration_events",   "error_code",            sa.String()),
    ("integration_events",   "response_payload",      sa.String()),
]


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade():
    bind = op.get_bind()
    for table, column, _type in DEAD_COLUMNS:
        if _has_column(bind, table, column):
            op.drop_column(table, column)


def downgrade():
    bind = op.get_bind()
    for table, column, col_type in DEAD_COLUMNS:
        if not _has_column(bind, table, column):
            op.add_column(table, sa.Column(column, col_type, nullable=True))
