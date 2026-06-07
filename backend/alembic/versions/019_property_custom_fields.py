"""019 — add custom_fields to properties.

Gives Property the same admin-defined custom-field (metadata) support that
Client/Job/Invoice already have, so operators can attach their own fields to
property records (the "more like Twenty CRM" ask).

Revision ID: 019_property_custom_fields
"""
from alembic import op
import sqlalchemy as sa

revision = "019_property_custom_fields"
down_revision = "018_integerize_quotes"
branch_labels = None
depends_on = None


def upgrade():
    # Nullable JSON column; existing rows read as NULL and are treated as {} in
    # the app layer (prop_to_dict / create defaults). No backfill needed.
    op.add_column(
        "properties",
        sa.Column("custom_fields", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("properties", "custom_fields")
