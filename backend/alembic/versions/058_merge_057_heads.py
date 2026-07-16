"""
Alembic merge: unify the two 057 heads into one.

Concurrent PRs again left two heads — `057_lead_pricing_details` (branched off
056_bathrooms_float) and `057_merge_056_heads` (the earlier merge of the two
056 branches). This is a no-op merge that joins them so there's a single head.

Alembic version: 058
"""

revision = "058_merge_057_heads"
down_revision = ("057_lead_pricing_details", "057_merge_056_heads")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
