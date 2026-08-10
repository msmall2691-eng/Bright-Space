"""
Alembic migration: properties.year_built

Client-data enrichment (Phase 1): persist the year a property was built.
bedrooms / bathrooms / square_footage already exist (migrations 025 + 056);
year_built is the one spec RentCast returns that had no column to land in, so
the Add/Edit Property "look up specs" action was throwing it away. Additive,
nullable — NULL means "unknown", exactly like the other structured specs.

Alembic version: 065
"""

from alembic import op
import sqlalchemy as sa


revision = "065_property_year_built"
down_revision = "064_gmail_history_cursor"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("properties", sa.Column("year_built", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("properties", "year_built")
