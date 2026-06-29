"""036 — drop clients.lifecycle_stage; Opportunity.stage is the single source.

clients.lifecycle_stage duplicated Opportunity.stage and was kept in sync by
hand in the opportunities router. It also had a near-twin in Client.status
(lead/active/inactive), and the only place it was read was the CRM summary
response. The summary now derives it from the client's opportunities:

  - any opportunity with stage='won'  -> 'customer'
  - any opportunity at all            -> 'opportunity'
  - none                              -> 'new'

so the column carries no information that can't be reconstructed. Drop it.

Downgrade re-adds the column with the original default 'new'; it does NOT
attempt to re-derive per-row historical values from the opportunities table.

Revision ID: 036_drop_client_lifecycle_stage
"""
from alembic import op
import sqlalchemy as sa

revision = "036_drop_client_lifecycle_stage"
down_revision = "035_quote_delivery_via_integration_events"
branch_labels = None
depends_on = None


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade():
    bind = op.get_bind()
    if _has_column(bind, "clients", "lifecycle_stage"):
        op.drop_column("clients", "lifecycle_stage")


def downgrade():
    bind = op.get_bind()
    if not _has_column(bind, "clients", "lifecycle_stage"):
        op.add_column(
            "clients",
            sa.Column("lifecycle_stage", sa.String(), server_default="new", nullable=True),
        )
