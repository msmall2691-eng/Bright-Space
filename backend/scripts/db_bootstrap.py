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

from sqlalchemy import inspect

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
        print("[db_bootstrap] fresh install complete")
    else:
        print("[db_bootstrap] existing database — running alembic upgrade head")
        command.upgrade(cfg, "head")
        print("[db_bootstrap] migrations up to date")


if __name__ == "__main__":
    main()
