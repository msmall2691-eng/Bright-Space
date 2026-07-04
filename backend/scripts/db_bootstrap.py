"""Deploy-time database bootstrap.

Run instead of a bare `alembic upgrade head`, because the historical migration
chain (001 is a hand-written, incomplete snapshot) does NOT apply cleanly to a
brand-new empty database — the canonical prod DB predates Alembic and was built
by ``Base.metadata.create_all``. So:

  • Fresh DB (no schema)  → create the full schema from the ORM models, apply
                            MT-3 RLS policies, and stamp Alembic at head.
  • Existing DB           → ``alembic upgrade head`` (unchanged behaviour).

Both paths are idempotent and safe to run on every deploy.
"""
import os
import sys

from sqlalchemy import inspect, text

# Run from the backend root (where alembic.ini + main.py live).
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from alembic import command
from alembic.config import Config

from database.db import engine
from database.models import Base
from database.rls import apply_org_rls


def _alembic_config() -> Config:
    cfg = Config(os.path.join(_BACKEND, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(_BACKEND, "alembic"))
    return cfg


def _widen_alembic_version_col():
    """Alembic's default alembic_version.version_num is VARCHAR(32). Our
    migration IDs use descriptive names like 034_merge_quote_requests_into_lead_intakes
    (48 chars), so trying to write one truncates and the whole `alembic upgrade`
    aborts on StringDataRightTruncation — which is exactly what was crashing
    every Railway deploy after that migration landed (stale container kept
    serving the old code because pre-deploy failed).

    Widen the column to VARCHAR(128) before running the upgrade. Idempotent
    (Postgres treats "widen to same-or-larger type" as a no-op), Postgres-only
    (SQLite ignores type changes, which is fine — SQLite is only used in tests
    and never carries this table). Skipped when the table doesn't exist yet
    (fresh install path)."""
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
    tables = set(inspect(engine).get_table_names())
    # "Fresh" = no Alembic history AND no app schema yet. The clients table is a
    # reliable sentinel for "the app has been installed here".
    fresh = "alembic_version" not in tables and "clients" not in tables

    cfg = _alembic_config()
    if fresh:
        print("[db_bootstrap] empty database — creating schema from models, applying RLS, stamping head")
        Base.metadata.create_all(bind=engine)
        with engine.begin() as conn:
            apply_org_rls(conn)
        command.stamp(cfg, "head")
        # stamp() just created alembic_version with the default VARCHAR(32);
        # widen it now so the next migration with a >32-char id doesn't blow up.
        _widen_alembic_version_col()
        print("[db_bootstrap] fresh install complete")
    else:
        print("[db_bootstrap] existing database — running alembic upgrade head")
        _widen_alembic_version_col()
        command.upgrade(cfg, "head")
        print("[db_bootstrap] migrations up to date")


if __name__ == "__main__":
    main()
