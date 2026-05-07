"""Drop clients.client_type — duplicated Property.property_type.

A client can own a residential home AND an STR — `Client.client_type` was
ambiguous in that case, and was never written by any production code path
(verified: no INSERTs/UPDATEs touch the column). The CRM summary endpoint
now derives the value from `client.properties[*].property_type` instead.

If you need to roll this back, the downgrade re-adds the nullable column
with no data — the original values are gone, but that's fine because they
were never authoritative. Frontend ClientCRMSummary continues to read
``client_type`` from the JSON response (now derived).
"""
from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_column("clients", "client_type")


def downgrade():
    op.add_column(
        "clients",
        sa.Column("client_type", sa.String(), nullable=True),
    )
