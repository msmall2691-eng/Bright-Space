"""Add explicit indexes on frequently-queried FK columns.

Postgres does NOT auto-create indexes on foreign-key columns (only on
PRIMARY KEYs and UNIQUE constraints). A query like
``WHERE client_id = X`` on ``properties`` falls through to a sequential
scan today. As the row counts grow, that turns into a real cost.

Indexes added (chosen by query frequency in the codebase):
- properties.client_id
- recurring_schedules.client_id
- recurring_schedules.property_id
- jobs.ical_event_id
- jobs.assigned_cleaner_user_id
- invoices.client_id
- invoices.job_id
- quotes.client_id
- messages.client_id
- messages.job_id

NOT added (already covered by a composite or unique index):
- jobs.client_id (covered by idx_job_client_status)
- jobs.property_id (covered by idx_job_property_date)
- jobs.recurring_schedule_id (covered by uq_jobs_schedule_date partial)
- visits.job_id (already has its own index from index=True)
- visits.scheduled_date (covered by idx_visit_scheduled_date_status)
- ical_events.property_id, ical_events.job_id (already indexed/unique)

NOT added (low-traffic, can revisit if a slow query surfaces):
- LeadIntake.{client_id, opportunity_id}, Quote.{intake_id, opportunity_id},
  Message.{opportunity_id}, Invoice.opportunity_id, RecurrenceException.created_by,
  Visit.completed_by, User.client_id, Activity.{job_id, message_id}.
"""
from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


# (table, column, index_name) — naming follows SQLAlchemy's ix_<table>_<column>
# convention so model-side `index=True` annotations resolve to the same name.
INDEXES = [
    ("properties",          "client_id",                "ix_properties_client_id"),
    ("recurring_schedules", "client_id",                "ix_recurring_schedules_client_id"),
    ("recurring_schedules", "property_id",              "ix_recurring_schedules_property_id"),
    ("jobs",                "ical_event_id",            "ix_jobs_ical_event_id"),
    ("jobs",                "assigned_cleaner_user_id", "ix_jobs_assigned_cleaner_user_id"),
    ("invoices",            "client_id",                "ix_invoices_client_id"),
    ("invoices",            "job_id",                   "ix_invoices_job_id"),
    ("quotes",              "client_id",                "ix_quotes_client_id"),
    ("messages",            "client_id",                "ix_messages_client_id"),
    ("messages",            "job_id",                   "ix_messages_job_id"),
]


def upgrade():
    for table, column, name in INDEXES:
        op.create_index(name, table, [column])


def downgrade():
    for _, _, name in INDEXES:
        op.drop_index(name)
