"""
Alembic migration: per-property weekend turnover piece rate.

Weekend rental turnovers are paid piece-rate (a flat dollar amount per
turnover) rather than hourly, and the amount varies by property. Payroll needs
somewhere to read that per-property number from, so store it on the property
itself. NULL means "no rate set yet" — the Payroll page flags those so the
operator knows a weekend turnover couldn't be priced.

Alembic version: 059
"""
from alembic import op
import sqlalchemy as sa


revision = "059_property_turnover_rate"
down_revision = "058_merge_057_heads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("properties")}
    if "turnover_rate" not in existing:
        op.add_column("properties", sa.Column("turnover_rate", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("properties", "turnover_rate")
