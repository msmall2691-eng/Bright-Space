"""
Alembic migration: add a public token to invoices

Gives each invoice an opaque, per-row token for a customer-facing (no-login)
invoice page at /pay/{token} — the read side of online payment. Mirrors the
existing Quote.public_token / Job.public_token pattern exactly: a nullable,
unique, indexed String(64), lazily minted the first time an invoice is sent.

A stored per-row token (vs. the old HMAC scheme this replaces) is revocable one
invoice at a time — null the column and that link dies without touching any
other invoice. Additive and nullable: old code ignores the column, so this is a
zero-downtime deploy.

Alembic version: 114
"""

from alembic import op
import sqlalchemy as sa


revision = "114_invoice_public_token"
down_revision = "113_invoice_discount"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add nullable first, then a separate unique index — the cross-dialect-safe
    # shape (SQLite can't ALTER TABLE ADD a UNIQUE column inline). Same two-step
    # the Job.public_token migration (050) uses.
    op.add_column("invoices", sa.Column("public_token", sa.String(length=64), nullable=True))
    op.create_index("ix_invoices_public_token", "invoices", ["public_token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_invoices_public_token", table_name="invoices")
    op.drop_column("invoices", "public_token")
