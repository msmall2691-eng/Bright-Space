"""Per-customer opt-in: offer this customer's unassigned recurring visits to crew.

Scopes the Sept 2026 owner decision (unassigned recurring visits go on the
bench) to specific customers instead of the whole book. When True, this
customer's recurring occurrences that generate with no cleaner are offered to
the crew board; when False (the default), they stay unassigned-and-hidden as
before. Read at generation (modules/recurring/router.py). Turnovers and one-off
jobs are unaffected.

Additive, NOT NULL with a server default so every existing customer starts
opted OUT — the safe default that re-hides the board (the companion data
migration 123 closes the visits migration 121 opened globally). No RLS row of
its own — it rides the clients table, already a tenant table.

Revision ID: 122_client_recurring_open_to_crew
Revises: 121_open_unassigned_recurring
"""
import sqlalchemy as sa
from alembic import op

revision = "122_client_recurring_open_to_crew"
down_revision = "121_open_unassigned_recurring"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "clients",
        sa.Column("recurring_open_to_crew", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("clients", "recurring_open_to_crew")
