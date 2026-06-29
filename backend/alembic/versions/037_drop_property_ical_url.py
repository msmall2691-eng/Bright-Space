"""037 — drop properties.ical_url; PropertyIcal is the only iCal store.

Property.ical_url was the original single-feed column; the multi-feed model
(PropertyIcal) has been the canonical place since the bulk-linking UI shipped.
The sync code, scheduler, and turnover sweep all knew how to read both, which
meant every iCal-touching path carried the legacy branch. Drop the column so
PropertyIcal is unambiguously the source of truth.

properties.ical_last_synced_at stays — it now tracks "last time a property-wide
sync ran across all PropertyIcal feeds" rather than a single-feed timestamp.

Downgrade re-creates the column nullable. It does NOT backfill from the
PropertyIcal table; restoring legacy semantics is not feasible (multi-feed has
no obvious "the" URL) and was never the intent of the migration.

Revision ID: 037_drop_property_ical_url
"""
from alembic import op
import sqlalchemy as sa

revision = "037_drop_property_ical_url"
down_revision = "036_drop_client_lifecycle_stage"
branch_labels = None
depends_on = None


def _has_column(bind, table, column) -> bool:
    insp = sa.inspect(bind)
    if table not in insp.get_table_names():
        return False
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade():
    bind = op.get_bind()
    if _has_column(bind, "properties", "ical_url"):
        op.drop_column("properties", "ical_url")


def downgrade():
    bind = op.get_bind()
    if not _has_column(bind, "properties", "ical_url"):
        op.add_column(
            "properties",
            sa.Column("ical_url", sa.String(), nullable=True),
        )
