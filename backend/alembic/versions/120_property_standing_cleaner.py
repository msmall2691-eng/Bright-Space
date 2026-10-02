"""A property's standing (designated) cleaner for its turnovers.

Lets the office designate one cleaner to do a property's rental turnovers, so a
turnover generated from that property's iCal feed is posted as a TARGETED OFFER
only that cleaner sees (open_for_claims + offer_audience=[this id]) and shows up
grouped in their My Properties view. It stays an offer: everyone on the book is
a subcontractor now, so the cleaner still taps to accept and the office still
approves — "offered, never assigned" holds (brightbase-marketplace Rule 0).

`standing_cleaner_id` is a cleaner_id (same String id space as User.cleaner_id,
Job.cleaner_ids and Route.owner_cleaner_id). Nullable, indexed (My Properties
filters properties by it). No RLS row of its own — it rides the properties
table, already a tenant table with an org policy.

Additive only: nullable, no backfill, no background tick, no projection writes
to it (scheduling-invariants R1/R2/R8 clean). Access details are untouched —
they stay assigned-only and surface only once a turnover is actually the
cleaner's (BB-SEC-08…12).

Revision ID: 120_property_standing_cleaner
Revises: 119_client_property_archive
"""
import sqlalchemy as sa
from alembic import op

revision = "120_property_standing_cleaner"
down_revision = "119_client_property_archive"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable, no backfill: an absent value already reads as "no designated
    # cleaner" everywhere it's checked, so existing properties are untouched.
    op.add_column(
        "properties",
        sa.Column("standing_cleaner_id", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_properties_standing_cleaner_id",
        "properties",
        ["standing_cleaner_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_properties_standing_cleaner_id", table_name="properties")
    op.drop_column("properties", "standing_cleaner_id")
