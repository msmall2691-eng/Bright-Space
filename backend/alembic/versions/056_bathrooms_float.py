"""
Alembic migration: widen bathrooms Integer -> Float on lead_intakes and properties

Homes have half-baths (2½). The customer-facing estimator on maineclean.co
prices on the fractional count, but bathrooms was stored as Integer here, so
2.5 was rounded to 2/3 and the operator's view disagreed with the quote the
customer saw. Widen to Float so the real count survives end-to-end.

estimate_min/estimate_max are already Float; this brings bathrooms in line.

Alembic version: 056
"""
from alembic import op
import sqlalchemy as sa


revision = "056_bathrooms_float"
down_revision = "055_connecteam_synced_schedule"
branch_labels = None
depends_on = None


def _alter(table: str, to_type, using: str | None) -> None:
    bind = op.get_bind()
    # SQLite can't ALTER COLUMN types in place; it's untyped enough that the
    # existing integer values already read back fine as floats, so skip.
    if bind.dialect.name == "sqlite":
        return
    kwargs = {"existing_type": sa.Integer(), "type_": to_type, "existing_nullable": True}
    if bind.dialect.name == "postgresql" and using:
        kwargs["postgresql_using"] = using
    op.alter_column(table, "bathrooms", **kwargs)


def upgrade() -> None:
    _alter("lead_intakes", sa.Float(), "bathrooms::double precision")
    _alter("properties", sa.Float(), "bathrooms::double precision")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        return
    for table in ("lead_intakes", "properties"):
        kwargs = {"existing_type": sa.Float(), "type_": sa.Integer(), "existing_nullable": True}
        if bind.dialect.name == "postgresql":
            kwargs["postgresql_using"] = "round(bathrooms)::integer"
        op.alter_column(table, "bathrooms", **kwargs)
