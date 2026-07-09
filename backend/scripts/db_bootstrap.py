"""Deploy-time database bootstrap.

Run instead of a bare `alembic upgrade head` so the alembic_version column
width fix (see below) applies before the very first migration on a fresh
database, not just on existing ones.

Fresh installs and existing installs both just run `alembic upgrade head` —
the migration chain replays cleanly from an empty database (migration 001
carries every column a later migration doesn't add itself; a handful of
migrations for designs abandoned before shipping — UUID-keyed quotes, an
orphaned "property intelligence" feature — are no-ops; `orgs` and the
alembic_version-width fix are real migration steps). This is enforced by
tests/test_migrations_from_scratch.py, which runs the full chain against a
brand-new Postgres database in CI.
"""
import os
import sys

from sqlalchemy import text

# Run from the backend root (where alembic.ini + main.py live).
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from alembic import command
from alembic.config import Config

from database.db import engine


def _alembic_config() -> Config:
    cfg = Config(os.path.join(_BACKEND, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(_BACKEND, "alembic"))
    return cfg


def _widen_alembic_version_col():
    """Alembic's default alembic_version.version_num is VARCHAR(32). Our
    migration IDs use descriptive names like 034_merge_quote_requests_into_lead_intakes
    (42 chars), so trying to write one truncates and the whole `alembic upgrade`
    aborts on StringDataRightTruncation — which is exactly what was crashing
    every Railway deploy after that migration landed (stale container kept
    serving the old code because pre-deploy failed).

    Migration 033b_widen_alembic_version now does this widening as a real
    migration step, so a from-scratch install handles it as part of the chain.
    This pre-widen stays for existing databases that reached head before
    033b existed (their alembic_version was already stamped past that point
    with the narrow column) and for the case where alembic_version doesn't
    exist yet (033b can't widen a table that isn't there until it creates it
    itself via a normal ALTER — that only works once the table exists, which
    it does by the time any real deploy runs this).

    Idempotent (Postgres treats "widen to same-or-larger type" as a no-op),
    Postgres-only (SQLite ignores type changes, which is fine — SQLite is
    only used in tests and never carries this table). Skipped when the table
    doesn't exist yet (genuinely first-ever run)."""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM information_schema.tables "
                 "WHERE table_name = 'alembic_version' LIMIT 1")
        ).first()
        if not exists:
            return
        conn.execute(text(
            "ALTER TABLE alembic_version "
            "ALTER COLUMN version_num TYPE VARCHAR(128)"
        ))
    print("[db_bootstrap] alembic_version.version_num widened to VARCHAR(128)")


def main():
    cfg = _alembic_config()
    _widen_alembic_version_col()
    command.upgrade(cfg, "head")
    print("[db_bootstrap] migrations up to date")


if __name__ == "__main__":
    main()
