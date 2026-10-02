"""Backfill Invoice.due_date_d from the string due_date (expand phase, step 2).

Separate from the schema add (127) so it can be re-run on its own if a deploy
dies partway. Idempotent: only rows whose typed column is still NULL and whose
string actually looks like YYYY-MM-DD are touched, so re-running is a no-op and
a blank/garbage string is left as-is (NULL mirror) for a human rather than
guessed at. Data-only — no schema change here.

Revision ID: 128_invoice_due_date_d_backfill
Revises: 127_invoice_due_date_d_add
"""
import sqlalchemy as sa
from alembic import op

revision = "128_invoice_due_date_d_backfill"
down_revision = "127_invoice_due_date_d_add"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        conn.execute(sa.text(
            "UPDATE invoices SET due_date_d = substr(due_date, 1, 10)::date "
            "WHERE due_date_d IS NULL "
            "AND due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'"
        ))
    else:  # sqlite (local / dev / tests)
        conn.execute(sa.text(
            "UPDATE invoices SET due_date_d = date(substr(due_date, 1, 10)) "
            "WHERE due_date_d IS NULL "
            "AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'"
        ))


def downgrade() -> None:
    # Data-only. Migration 127's downgrade drops the column outright, so the
    # backfilled values vanish with it — there is nothing to undo here.
    pass
