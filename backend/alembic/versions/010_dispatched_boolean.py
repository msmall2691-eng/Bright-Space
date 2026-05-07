"""Convert jobs.dispatched from Integer to Boolean.

The column was Integer with default=0 but only ever holds 0/1; the API
already coerces with bool(j.dispatched). Schema cleanup — model now
declares Boolean, not nullable, default False.

Postgres: ALTER COLUMN ... TYPE BOOLEAN USING (dispatched <> 0). Defensive
NULL → 0 first so rows with NULL (legacy) become False instead of failing
the NOT NULL.

SQLite (local tests): pytest bootstraps via Base.metadata.create_all, not
Alembic, so the SQLite test schema picks up Boolean directly from the
model. The migration is a no-op for SQLite — guarded by dialect check.
"""
from alembic import op
from sqlalchemy import text

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite tests don't run migrations — they create_all() from models
        # which already has Boolean. No-op here keeps the migration portable.
        return

    # Defensive: any NULL legacy row becomes False after the type change.
    bind.execute(text("UPDATE jobs SET dispatched = 0 WHERE dispatched IS NULL"))

    bind.execute(text(
        "ALTER TABLE jobs "
        "ALTER COLUMN dispatched DROP DEFAULT, "
        "ALTER COLUMN dispatched TYPE BOOLEAN USING (dispatched <> 0), "
        "ALTER COLUMN dispatched SET DEFAULT FALSE, "
        "ALTER COLUMN dispatched SET NOT NULL"
    ))


def downgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    bind.execute(text(
        "ALTER TABLE jobs "
        "ALTER COLUMN dispatched DROP NOT NULL, "
        "ALTER COLUMN dispatched DROP DEFAULT, "
        "ALTER COLUMN dispatched TYPE INTEGER USING (CASE WHEN dispatched THEN 1 ELSE 0 END), "
        "ALTER COLUMN dispatched SET DEFAULT 0"
    ))
