"""Let a deleted turnover stay deleted (dismiss its booking).

The turnover generator's standing policy is "as long as the Airbnb booking is
still in the feed, keep a turnover for it" — so deleting or cancelling a
turnover Job got it recreated on the very next iCal sync. That policy exists to
stop a false-cancellation sweep from silently losing real cleanings, but it also
overrides a DELIBERATE human delete, which violates the authority model
(BrightBase is canonical; the feed is an inbox that must never override a
by-hand decision — scheduling-invariants Rule 0).

This adds a per-booking dismissal marker on ical_events. When the office
hard-deletes a turnover, its booking is marked dismissed and the generator stops
recreating a turnover for it — "just gone", the owner's choice. The automatic
false-cancel recovery is unaffected: only an explicit human delete sets this, so
a system hiccup still can't silently drop a real cleaning.

Additive and inert until a delete sets it (scheduling-invariants R1/R2/R7/R8
clean — no tick, no projection writeback, no automated Job deletion, additive
only). ical_events is already a tenant table with an org policy; these columns
ride it, no RLS row of their own.

Revision ID: 118_ical_event_dismissed
Revises: 117_job_offer_audience
"""
import sqlalchemy as sa
from alembic import op

revision = "118_ical_event_dismissed"
down_revision = "117_job_offer_audience"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable, no backfill: an absent dismissed_at reads as "not dismissed"
    # everywhere it's checked, so every existing booking keeps generating its
    # turnover exactly as before.
    op.add_column("ical_events", sa.Column("dismissed_at", sa.DateTime(), nullable=True))
    op.add_column("ical_events", sa.Column("dismissed_by", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("ical_events", "dismissed_by")
    op.drop_column("ical_events", "dismissed_at")
