"""Add quotes system tables (superseded design — now a no-op)

Revision ID: 013_quotes_system
Revises: 012_add_property_profiles
Create Date: 2026-05-26 15:00:00.000000

This migration originally created a UUID-keyed `quotes` / `quote_line_items` /
`quote_requests` set of tables. That design was abandoned in favor of the
integer-keyed `Quote` model actually in use today — see its docstring in
database/models.py: "Replaces the earlier UUID-keyed Quote + QuoteLineItem
design that couldn't link to the integer Client/Job ids." The real `quotes`
table (integer PK) already exists from migration 001, so this migration's
`CREATE TABLE quotes` collides with it (DuplicateTable) on a from-scratch
replay. `quote_line_items` has no ORM model or reader anywhere in the app.

`quote_requests` here is UUID-keyed too and FKs into the UUID `clients.id`
this migration imagines — but `clients.id` is, and always was, an integer.
The real (integer-keyed) `quote_requests` table that migration 034 later
merges into `lead_intakes` was never created by any migration either (same
create_all()-only history as everything else this migration touches); 034
already guards for that table being absent on a fresh install, so nothing
downstream depends on this migration having created it.

Migration 018 (five steps later) DROPs and recreates `quotes`/`quote_line_items`/
`quote_requests` as integer-keyed tables anyway, so even a successful run of
this migration's original body would just be churn that gets discarded before
any app code ever reads from it.

Turned into a no-op rather than deleted outright so existing `alembic_version`
rows already stamped at this revision (or past it) keep resolving to a valid
revision id.

Revision ID: 013_quotes_system
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '013_quotes_system'
down_revision = '012_add_property_profiles'
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
