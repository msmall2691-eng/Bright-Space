"""Add Invoice.due_date_d — a typed Date mirror of the string due_date.

Expand phase of an expand/contract. Additive and reversible: a nullable Date
column plus its index. The @validates on the Invoice model keeps it in sync on
every new write; migration 128 backfills existing rows. The string `due_date`
stays authoritative on the wire and in the overdue/dunning reads for now — a
later release moves reads onto this column and then drops the string.

Revision ID: 127_invoice_due_date_d_add
Revises: 126_jobs_server_defaults_and_series_index
"""
import sqlalchemy as sa
from alembic import op

revision = "127_invoice_due_date_d_add"
down_revision = "126_jobs_server_defaults_and_series_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("invoices", sa.Column("due_date_d", sa.Date(), nullable=True))
    op.create_index("ix_invoices_due_date_d", "invoices", ["due_date_d"])


def downgrade() -> None:
    op.drop_index("ix_invoices_due_date_d", table_name="invoices")
    with op.batch_alter_table("invoices") as b:
        b.drop_column("due_date_d")
