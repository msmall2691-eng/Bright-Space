"""Pre-calculated drive mileage: coordinates for cleaner homes + properties.

The owner wants mileage pre-calculated per cleaner (home → first job → between
houses) instead of relying on crew-typed miles at clock-out. That needs two
things the schema didn't have:

  * users.home_address (+ cached home_lat/home_lng) — the office enters a
    cleaner's home address; coordinates are geocoded lazily the first time a
    mileage report needs them (services/geocoding.py) and cached on the row.
  * properties.lat/lng — same lazy-geocode-and-cache for each job stop.

Additive only (R8): five nullable columns, no backfill, no RLS change (both
tables already carry org_id and their policies are unchanged). NULL simply
means "not geocoded yet" / "no home address on file" and the mileage report
degrades gracefully (skips the home leg, flags unknown stops).

Revision ID: 092_mileage_geo_columns
Revises: 091_proposed_actions
"""
from alembic import op
import sqlalchemy as sa


revision = "092_mileage_geo_columns"
down_revision = "091_proposed_actions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("home_address", sa.String(length=400), nullable=True))
    op.add_column("users", sa.Column("home_lat", sa.Float(), nullable=True))
    op.add_column("users", sa.Column("home_lng", sa.Float(), nullable=True))
    op.add_column("properties", sa.Column("lat", sa.Float(), nullable=True))
    op.add_column("properties", sa.Column("lng", sa.Float(), nullable=True))


def downgrade() -> None:
    # Drops the cached coordinates and the home address. The address is
    # office-entered data (re-enterable), the coordinates are derived — so a
    # downgrade loses nothing that can't be recreated by re-typing/re-geocoding.
    op.drop_column("properties", "lng")
    op.drop_column("properties", "lat")
    op.drop_column("users", "home_lng")
    op.drop_column("users", "home_lat")
    op.drop_column("users", "home_address")
