"""
Alembic migration: recurring_schedules.opportunity_id

P4 (deal model reconciliation): give a recurring engagement a direct link to
its deal. A won, recurring schedule is the shape of an ongoing customer — with
this column the deal board can show a won deal's cadence directly instead of
inferring it through the shared client + jobs.

Additive, nullable. Set when a schedule is created from an accepted quote
(carried from quote.opportunity_id); NULL for ad-hoc schedules. Following this
repo's convention (see 063 / 049), the column is a plain Integer here and the
FK is declared at the ORM layer.

Alembic version: 066
"""

from alembic import op
import sqlalchemy as sa


revision = "066_recurring_opportunity_link"
down_revision = "065_property_year_built"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("recurring_schedules", sa.Column("opportunity_id", sa.Integer(), nullable=True))
    op.create_index("ix_recurring_schedules_opportunity_id", "recurring_schedules", ["opportunity_id"])


def downgrade() -> None:
    op.drop_index("ix_recurring_schedules_opportunity_id", table_name="recurring_schedules")
    op.drop_column("recurring_schedules", "opportunity_id")
