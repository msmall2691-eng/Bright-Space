"""026 — Job.gcal_ical_uid + gcal_external_updated_at for idempotent calendar sync.

Twenty stores iCalUid on its CalendarEvent; we mirror it on Job so a re-created or
moved Google event is matched as the same booking (before extendedProperties /
attendee / address), killing the duplicate-event class of bug. external_updated_at
keeps Google's last-modified time for drift detection.

Additive, nullable, idempotent, dialect-guarded.

Revision ID: 026_job_gcal_ical_uid
"""
from alembic import op
import sqlalchemy as sa

revision = "026_job_gcal_ical_uid"
down_revision = "025_crm_audit_fields"
branch_labels = None
depends_on = None

_COLS = [
    ("jobs", "gcal_ical_uid", sa.String()),
    ("jobs", "gcal_external_updated_at", sa.DateTime(timezone=True)),
]


def _cols(bind, table):
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def upgrade():
    bind = op.get_bind()
    have = _cols(bind, "jobs")
    for table, column, coltype in _COLS:
        if column not in have:
            op.add_column(table, sa.Column(column, coltype, nullable=True))


def downgrade():
    bind = op.get_bind()
    have = _cols(bind, "jobs")
    for table, column, _ in reversed(_COLS):
        if column in have:
            op.drop_column(table, column)
