"""
Alembic migration: Add quote email tracking (retired design — now a no-op)
Alembic version: 014

This migration originally created `quote_emails` keyed by String(36) UUID-as-
text, with a FK to the UUID-keyed `quotes.id` from migration 013. Migration
013 is itself a no-op now (see its docstring) because the app's real `quotes`
table (from migration 001) is integer-keyed — so this table's FK could never
be created on a from-scratch replay (DatatypeMismatch: varchar vs integer).

The per-channel quote_emails/quote_sms tracking this table fed was later
retired entirely in favor of IntegrationEvent (migration 035 — "retire
quote_emails / quote_sms in favor of IntegrationEvent"), which already guards
every step behind `_has_table(bind, "quote_emails")` so it does the right
thing whether or not this table ever existed. No ORM model or router reads
`quote_emails` directly today (modules/quoting/router.py's own comment: "...
after the per-channel quote_emails/quote_sms tables were retired").

Turned into a no-op rather than deleted outright so existing `alembic_version`
rows already stamped at this revision (or past it) keep resolving to a valid
revision id.
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '014_quote_email_tracking'
down_revision = '013_quotes_system'
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
