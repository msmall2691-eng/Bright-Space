"""
Alembic migration: fix schema drift between migration 001 and the current
ORM models

migration 001 hand-wrote the initial CREATE TABLE statements; models.py has
since evolved past what that SQL declared, and no later migration closed the
gap. The LIVE production database works fine because it was originally
bootstrapped via SQLAlchemy's Base.metadata.create_all (which always matches
the current models exactly) before the project switched to Alembic-only
schema management — so this drift has never actually been exercised. But a
genuinely from-scratch `alembic upgrade head` (a new environment, CI against
Postgres, disaster recovery into an empty database) hits it immediately:

- users.org_id is missing entirely — migration 027 added org_id to every
  MT-1 table EXCEPT `users` (the table just isn't in its TABLES list).
  Every authenticated request reads current_user.org_id; SQLAlchemy would
  fail every SELECT on User with "column users.org_id does not exist".
- user_google_accounts has no CREATE TABLE migration at all — the model
  exists (Settings' per-user Google OAuth), but a fresh chain never
  creates the table.
- quotes is missing 5 columns models.py has long since added (frequency,
  customer_message, internal_notes, last_send_attempt_at, last_send_error).
- Several columns were declared with the WRONG SQL type in 001 (VARCHAR
  instead of DATE/TIME/JSON/TEXT, INTEGER instead of BOOLEAN). Inserts
  mostly tolerate this (Postgres will store whatever string/int SQLAlchemy
  sends), but any WHERE/filter on one of these columns breaks immediately
  — SQLAlchemy binds the model's declared Python type (e.g. a real `date`
  for Job.scheduled_date), and Postgres rejects a bind parameter typed
  `date` against a `character varying` column: "operator does not exist:
  character varying = date". Given scheduled_date/start_time/end_time are
  filtered on almost every scheduling query, this is a full outage on a
  from-scratch install, not a cosmetic issue.

Every step here is introspection-guarded (checks the live column/table
before touching it), so this migration is a safe no-op against a database
that's already correct — which describes production today. It only does
real work on a schema that actually still has 001's original drift.

Alembic version: 049
"""

from alembic import op
import sqlalchemy as sa


revision = "049_fix_schema_drift_from_scratch"
down_revision = "048_recurring_series_start_date"
branch_labels = None
depends_on = None


# (table, column, target_type_sql, USING expression)
# USING expressions null-guard empty-string legacy values before casting so
# a pre-existing "" (SQLAlchemy never writes one, but a hand-inserted row
# could) doesn't abort the whole ALTER.
TYPE_FIXES = [
    ("clients", "email_verified", "boolean", "email_verified <> 0"),
    ("clients", "custom_fields", "json", "COALESCE(NULLIF(custom_fields, '')::json, '{}'::json)"),
    ("jobs", "scheduled_date", "date", "NULLIF(scheduled_date, '')::date"),
    ("jobs", "start_time", "time", "NULLIF(start_time, '')::time"),
    ("jobs", "end_time", "time", "NULLIF(end_time, '')::time"),
    ("jobs", "calendar_invite_sent", "boolean", "calendar_invite_sent <> 0"),
    ("jobs", "sms_reminder_sent", "boolean", "sms_reminder_sent <> 0"),
    ("jobs", "cleaner_ids", "json", "COALESCE(NULLIF(cleaner_ids, '')::json, '[]'::json)"),
    ("jobs", "connecteam_shift_ids", "json", "COALESCE(NULLIF(connecteam_shift_ids, '')::json, '[]'::json)"),
    ("jobs", "custom_fields", "json", "COALESCE(NULLIF(custom_fields, '')::json, '{}'::json)"),
    ("jobs", "notes", "text", "notes::text"),
    ("field_definitions", "is_system", "boolean", "is_system <> 0"),
    ("invoices", "custom_fields", "json", "COALESCE(NULLIF(custom_fields, '')::json, '{}'::json)"),
    ("lead_intakes", "internal_notes", "text", "internal_notes::text"),
    ("lead_intakes", "message", "text", "message::text"),
    ("messages", "is_internal_note", "boolean", "is_internal_note <> 0"),
    ("opportunities", "custom_fields", "json", "COALESCE(NULLIF(custom_fields, '')::json, '{}'::json)"),
    ("property_icals", "active", "boolean", "active <> 0"),
    ("property_icals", "last_sync_error", "text", "last_sync_error::text"),
    ("recurring_schedules", "days_of_week", "json", "COALESCE(NULLIF(days_of_week, '')::json, '[]'::json)"),
    ("app_settings", "value", "text", "value::text"),
]


def _column_type(insp, table, column):
    for col in insp.get_columns(table):
        if col["name"] == column:
            return str(col["type"]).lower()
    return None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    # 1. users.org_id — missing from migration 027's TABLES list.
    if "users" in tables and "org_id" not in {c["name"] for c in insp.get_columns("users")}:
        op.add_column("users", sa.Column("org_id", sa.Integer(), nullable=True))
        op.create_index("ix_users_org_id", "users", ["org_id"])
        op.execute(sa.text("UPDATE users SET org_id = 1 WHERE org_id IS NULL"))

    # 2. user_google_accounts — model exists, no CREATE TABLE migration ever did.
    if "user_google_accounts" not in tables:
        op.create_table(
            "user_google_accounts",
            sa.Column("id", sa.Integer(), primary_key=True, index=True),
            sa.Column("user_id", sa.Integer(),
                      sa.ForeignKey("users.id", ondelete="CASCADE"),
                      nullable=False, unique=True, index=True),
            sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"),
                      nullable=False, index=True),
            sa.Column("google_sub", sa.String(64), nullable=False),
            sa.Column("email", sa.String(255), nullable=False),
            sa.Column("access_token", sa.Text(), nullable=True),
            sa.Column("refresh_token", sa.Text(), nullable=True),
            sa.Column("token_expiry", sa.DateTime(), nullable=True),
            sa.Column("scopes", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("status", sa.String(16), nullable=False, server_default="connected"),
            sa.Column("gmail_sync_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("gcal_sync_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("last_sync_at", sa.DateTime(), nullable=True),
            sa.Column("last_sync_error", sa.Text(), nullable=True),
            sa.Column("connected_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("org_id", "google_sub", name="uq_user_google_accounts_org_sub"),
        )

    # 3. quotes — 5 columns models.py added that no migration ever wrote.
    if "quotes" in tables:
        existing = {c["name"] for c in insp.get_columns("quotes")}
        quote_adds = [
            ("frequency", sa.Column("frequency", sa.String(50), nullable=True)),
            ("customer_message", sa.Column("customer_message", sa.Text(), nullable=True)),
            ("internal_notes", sa.Column("internal_notes", sa.Text(), nullable=True)),
            ("last_send_attempt_at", sa.Column("last_send_attempt_at", sa.DateTime(timezone=True), nullable=True)),
            ("last_send_error", sa.Column("last_send_error", sa.Text(), nullable=True)),
        ]
        for name, col in quote_adds:
            if name not in existing:
                op.add_column("quotes", col)

    # 4. Column-type drift — Postgres only (SQLite has no ALTER COLUMN TYPE
    # and doesn't enforce column types the way Postgres does, so 001's
    # drift there is harmless). Skipped entirely when the live type already
    # matches, so this is a no-op on a correct database.
    if bind.dialect.name == "postgresql":
        for table, column, target_type, using_expr in TYPE_FIXES:
            if table not in tables:
                continue
            current = _column_type(insp, table, column)
            if current is None or target_type in current:
                continue
            op.execute(sa.text(
                f"ALTER TABLE {table} ALTER COLUMN {column} TYPE {target_type} USING ({using_expr})"
            ))


def downgrade() -> None:
    # Lossy: reversing the type fixes would just reintroduce the drift this
    # migration exists to close, and users.org_id / user_google_accounts /
    # the quotes columns are additive data other migrations now depend on.
    # No-op downgrade, matching this repo's convention for schema-correction
    # migrations (see 046).
    pass
