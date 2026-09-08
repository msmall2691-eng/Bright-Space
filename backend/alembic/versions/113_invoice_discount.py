"""A discount column on invoices — so a promised discount survives to the bill.

THE GAP THIS CLOSES. `Quote` carried a `discount` (a flat dollar amount taken
off after tax) and its `total` already reflected it. But `Invoice` had no such
column: when a completed job auto-generated its draft invoice, or an operator
composed one by hand, the discount had nowhere to land. The invoice's `total`
was computed as `subtotal + tax` — the FULL, pre-discount amount — so a customer
promised "$40 off" was billed the whole number. Money quietly clawed back from
a discount the business had already agreed to.

FLOAT, NOT INTEGER CENTS. Deliberately consistent with the six money columns
already on this schema — `invoices.subtotal/tax/total`, `quotes.subtotal/total`
and the rest are all Float (see migration 110's note). A lone cents column here
would need a conversion everywhere this value meets `invoices.total` or
`quotes.discount`, and those conversions are where rounding bugs are born.

NOT NULL with a server_default of 0. Unlike migration 110's prices, there is no
"we don't know" state for a discount: an invoice with no discount is billed at
full price, which is exactly 0 off. Existing rows take 0 (no retroactive
discount), and the column can be NOT NULL from the start without a backfill.

Revision ID: 113_invoice_discount
Revises: 112_portal_magic_single_use
"""
import sqlalchemy as sa
from alembic import op

revision = "113_invoice_discount"
down_revision = "112_portal_magic_single_use"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Additive with a server_default, so old code ignores a column it does not
    # know about and existing rows read 0 rather than NULL — zero-downtime on a
    # single Railway container.
    op.add_column(
        "invoices",
        sa.Column("discount", sa.Float(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    # New column: dropping it removes discounts entered since the upgrade and
    # nothing that existed before it. Any discount recorded in between is gone,
    # which is the honest, bounded cost.
    op.drop_column("invoices", "discount")
