"""066 — reconcile the two lead↔quote links.

A lead and its quote are linked in both directions — ``Quote.intake_id``
(provenance) and ``LeadIntake.converted_quote_id`` (the converting quote) —
set independently over time, so historical rows can have one side NULL. This
one-time backfill fills each gap from the other, making
``converted_quote_id`` a reliable single source of truth for lead conversion
(P4 decision 4). Idempotent: only fills NULLs, safe to re-run. The forward
convert paths (convert-to-quote, create_quote) already set both.

Revision ID: 067_reconcile_lead_quote_links
"""
from alembic import op
from sqlalchemy.orm import Session

revision = "067_reconcile_lead_quote_links"
down_revision = "066_recurring_opportunity_link"
branch_labels = None
depends_on = None


def upgrade():
    from utils.opportunity_helper import reconcile_lead_quote_links
    session = Session(bind=op.get_bind())
    try:
        reconcile_lead_quote_links(session)
        session.commit()
    finally:
        session.close()


def downgrade():
    # Data backfill — nothing to reverse. Filling a NULL link doesn't lose
    # information, so we don't null it back out on downgrade.
    pass
