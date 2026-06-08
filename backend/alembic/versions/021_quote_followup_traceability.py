"""021 — quote follow-up + conversion traceability.

Completes the quote/intake lifecycle fields the April audit asked for:
- quotes.converted_at      — when an accepted quote became a job (§10 metric:
  median days sent→accepted, conversion tracking).
- quotes.follow_up_sent_at — when a nudge went out on a stale quote (§3
  "Waiting": no automated follow-up on sent quotes; Journey E).
- lead_intakes.converted_quote_id — back-reference so an intake traces to the
  quote it produced (§6 traceability; intake→quote was one-way before).

Revision ID: 021_quote_followup_traceability
"""
from alembic import op
import sqlalchemy as sa

revision = "021_quote_followup_traceability"
down_revision = "020_quote_response_capture"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("quotes", sa.Column("converted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("quotes", sa.Column("follow_up_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("lead_intakes", sa.Column("converted_quote_id", sa.Integer(), nullable=True))


def downgrade():
    op.drop_column("lead_intakes", "converted_quote_id")
    op.drop_column("quotes", "follow_up_sent_at")
    op.drop_column("quotes", "converted_at")
