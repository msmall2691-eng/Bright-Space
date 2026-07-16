"""
Alembic migration: store the pricing inputs a lead was quoted on

The website quote engine prices on service (deep vs standard), home condition,
and pet hair — but lead_intakes only stored the canonical service_type
(deep -> "residential") and dropped condition/pet_hair entirely. So a Deep
Clean with pets landed as a plain "Residential" request showing a $320-$350
estimate with nothing to explain it. Persist the three dropped inputs so the
request is self-explanatory and matches what the customer saw.

Alembic version: 057
"""
from alembic import op
import sqlalchemy as sa


revision = "057_lead_pricing_details"
down_revision = "056_bathrooms_float"
branch_labels = None
depends_on = None


_COLS = ("requested_service", "condition", "pet_hair")


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("lead_intakes")}
    for col in _COLS:
        if col not in existing:
            op.add_column("lead_intakes", sa.Column(col, sa.String(), nullable=True))


def downgrade() -> None:
    for col in _COLS:
        op.drop_column("lead_intakes", col)
