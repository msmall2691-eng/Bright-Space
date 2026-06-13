"""023 — reconcile quotes.valid_until to a real DATE column.

Production schema drifted: ``quotes.valid_until`` is stored as TEXT even though
018_integerize_quotes declares it ``sa.Date()`` (prod was hand-recovered — see
scripts/reconcile_prod_schema.py and docs/recover-prod-schema-2026-06-08.sql).
A text column made several code paths ``.strftime()`` / compare a ``str`` and
500 the public quote page, quote sending, and accept. PR #274 fixed that
defensively in code; this migration removes the landmine at the source.

Idempotent + dialect-aware:
  * Postgres: only ALTERs when the column is still a character type; the
    ``USING NULLIF(valid_until, '')::date`` cast turns '' into NULL and parses
    'YYYY-MM-DD' strings. A no-op when the column is already ``date``.
  * SQLite / others: no-op — a fresh DB (create_all / 018) already has DATE,
    and SQLite doesn't support ALTER COLUMN TYPE anyway.

NOTE: Railway runs ``alembic upgrade head`` as its preDeployCommand, so this
applies automatically on the next deploy. Verify on a preview/staging DB first.

Revision ID: 023_quotes_valid_until_date
"""
from alembic import op
import sqlalchemy as sa

revision = "023_quotes_valid_until_date"
down_revision = "022_intake_converted_quote_fk"
branch_labels = None
depends_on = None


def _valid_until_type(bind):
    """Current SQL data_type of quotes.valid_until, or None if absent."""
    return bind.execute(sa.text(
        "SELECT data_type FROM information_schema.columns "
        "WHERE table_name = 'quotes' AND column_name = 'valid_until'"
    )).scalar()


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # SQLite/others already have DATE; nothing to reconcile.
    data_type = (_valid_until_type(bind) or "").lower()
    if data_type in ("character varying", "text", "character"):
        op.execute(
            "ALTER TABLE quotes "
            "ALTER COLUMN valid_until TYPE date "
            "USING NULLIF(valid_until, '')::date"
        )


def downgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    data_type = (_valid_until_type(bind) or "").lower()
    if data_type == "date":
        op.execute(
            "ALTER TABLE quotes "
            "ALTER COLUMN valid_until TYPE varchar "
            "USING valid_until::text"
        )
