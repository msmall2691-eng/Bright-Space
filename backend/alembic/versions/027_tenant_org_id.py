"""027 — multi-tenancy MT-1: org_id on every domain table.

Additive + nullable + backfilled to org 1 (the existing Maine Cleaning Co
workspace), indexed. NO query changes yet — this is the safe foundation; query
scoping (MT-2), NOT NULL + RLS (MT-3), and signup-creates-org (MT-4) follow.

Plain Integer columns (FK declared on the ORM side only) so the migration applies
cleanly to existing tables on SQLite + Postgres. Idempotent + dialect-guarded.

Revision ID: 027_tenant_org_id
"""
from alembic import op
import sqlalchemy as sa

revision = "027_tenant_org_id"
down_revision = "026_job_gcal_ical_uid"
branch_labels = None
depends_on = None

TABLES = [
    "clients", "properties", "property_icals", "ical_events", "recurring_schedules",
    "recurrence_exceptions", "jobs", "visits", "lead_intakes", "invoices",
    "conversations", "messages", "opportunities", "contact_emails", "contact_phones",
    "activities", "quotes", "quote_requests", "quote_emails", "cleaner_time_off",
    "integration_events",
]


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return True  # table absent on this DB — treat as "nothing to do"
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())
    for table in TABLES:
        if table not in existing:
            continue
        if "org_id" not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, sa.Column("org_id", sa.Integer(), nullable=True))
            op.create_index(f"ix_{table}_org_id", table, ["org_id"])
        # Backfill every existing row to the seeded org (id=1).
        op.execute(sa.text(f"UPDATE {table} SET org_id = 1 WHERE org_id IS NULL"))


def downgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())
    for table in TABLES:
        if table not in existing:
            continue
        if "org_id" in {c["name"] for c in insp.get_columns(table)}:
            try:
                op.drop_index(f"ix_{table}_org_id", table_name=table)
            except Exception:
                pass
            op.drop_column(table, "org_id")
