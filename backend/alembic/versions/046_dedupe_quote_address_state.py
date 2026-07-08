"""
Alembic migration: backfill doubled-state tokens out of quotes.address

The July-2026 audit L1/L3 finding: quotes saved before the write-side
`combine_address` fix carry a doubled state/zip token in their stored
`address` — the customer-visible symptom was
"100 Congress Street, Portland, ME, 04101, ME" (QT-2026-0034) on the email,
PDF, public page, and admin.

`format_address` now cleans this on RENDER, but the underlying column is still
dirty — and a Job converted from such a quote copies `quote.address` verbatim,
carrying the doubled token forward. This one-time backfill normalizes the
stored value so the data is correct at rest, not just on display.

Idempotent: only rows whose normalized form differs are rewritten, so a
re-run (or a row already clean) is a no-op.

Alembic version: 046
"""

from alembic import op
from sqlalchemy import text

from utils.address import format_address


revision = "046_dedupe_quote_address_state"
down_revision = "045_invoice_dunning_tracking"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Only rows with at least two comma components can carry a duplicate token.
    rows = bind.execute(
        text("SELECT id, address FROM quotes WHERE address LIKE '%,%'")
    ).fetchall()
    for quote_id, address in rows:
        cleaned = format_address(address)
        if cleaned != (address or ""):
            bind.execute(
                text("UPDATE quotes SET address = :addr WHERE id = :id"),
                {"addr": cleaned, "id": quote_id},
            )


def downgrade() -> None:
    # Lossy cleanup — the duplicate token is gone for good and there's nothing
    # to restore. No-op downgrade (matches other data-normalization migrations).
    pass
