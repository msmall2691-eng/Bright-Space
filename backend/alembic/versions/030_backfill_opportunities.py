"""030 — backfill Pipeline opportunities from existing leads/quotes.

The Pipeline kanban reads Opportunity rows, but historically deals were only
created manually — so a workspace with real leads/quotes still showed an empty
board. This one-time data migration creates one deal per client that has
quotes/leads but none yet, links those quotes/leads/jobs to it, and seeds the
stage from the client's most-advanced quote. Idempotent: re-running creates
nothing new (the forward wiring in the intake/quote flow keeps it current).

Revision ID: 030_backfill_opportunities
"""
from alembic import op
from sqlalchemy.orm import Session

revision = "030_backfill_opportunities"
down_revision = "029_saved_views"
branch_labels = None
depends_on = None


def upgrade():
    from utils.opportunity_helper import backfill_opportunities
    session = Session(bind=op.get_bind())
    try:
        backfill_opportunities(session)
        session.commit()
    finally:
        session.close()


def downgrade():
    # Data backfill — nothing to reverse. Auto-created deals can be deleted via
    # the app if needed; we don't drop them on downgrade to avoid data loss.
    pass
