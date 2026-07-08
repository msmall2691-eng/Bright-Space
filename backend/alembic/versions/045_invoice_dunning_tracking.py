"""
Alembic migration: invoice dunning tracking columns

Adds two columns to `invoices` so the automatic overdue-invoice email tick
(T-03) can idempotently nudge stale receivables at +1, +7, +14 days past
due without double-sending:

  dunning_stage       — INTEGER, 0 = none sent. 1/2/3 = which cadence
                        reminder was last sent. Once 3 (final) fires we
                        stop; a manual re-send doesn't rewind the counter.
  dunning_last_sent_at — DATETIME, best-effort audit trail so operators
                        can see when the last automatic chase fired
                        without correlating messages.

Both nullable so pre-migration invoices default to "never chased" and the
tick's next run picks them up naturally.

Alembic version: 045
"""

from alembic import op
import sqlalchemy as sa


revision = "045_invoice_dunning_tracking"
down_revision = "044_lead_intake_idempotency_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "invoices",
        sa.Column("dunning_stage", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "invoices",
        sa.Column("dunning_last_sent_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("invoices", "dunning_last_sent_at")
    op.drop_column("invoices", "dunning_stage")
