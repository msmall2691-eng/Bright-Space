"""Pin the fresh-install migration path.

scripts/db_bootstrap.py takes a shortcut on empty DBs: it calls
``Base.metadata.create_all`` instead of ``alembic upgrade head``, because
the historical migration chain (migration 001 is a hand-written incomplete
snapshot) does NOT apply cleanly to a fresh DB. That means:

  1. Migrations are never exercised from scratch — a bad new migration can
     land on prod without being caught by CI.
  2. Any drift between ``shared/schema.ts``… sorry, wrong repo — between
     ``database/models`` (Base.metadata) and the accumulated migration state
     stays silent, because prod never runs migrations end-to-end.

This test runs the full chain against an empty SQLite DB. It is marked
``xfail(strict=True)`` because the chain is known to be broken today (see
db_bootstrap.py's docstring for context). Once the chain is repaired the
xfail flips to an unexpected pass, which pytest treats as a failure so
you know to remove the marker and delete the create_all() shortcut.

To rerun by hand:
    DATABASE_URL="sqlite:////tmp/mig.db" alembic upgrade head
"""
import os
import tempfile

import pytest


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Historical migration chain doesn't apply cleanly from scratch — "
        "kept as a drift tripwire. Fix migration 001 and remove this marker "
        "once the chain replays end-to-end."
    ),
)
def test_alembic_upgrade_head_from_empty_db():
    with tempfile.TemporaryDirectory() as td:
        db_path = os.path.join(td, "fresh.db")
        # Point everything at a brand-new SQLite file. Import lazily so this
        # module doesn't hijack the DATABASE_URL for the rest of the suite.
        os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
        from alembic import command
        from alembic.config import Config

        # Reload the engine module so it picks up the new DATABASE_URL — the
        # migration env.py builds its own engine from the config, but any
        # imports side-effect'd on module load need a fresh module.
        import importlib
        import database.db as db_module
        importlib.reload(db_module)

        cfg = Config("alembic.ini")
        cfg.set_main_option("script_location", "alembic")
        command.upgrade(cfg, "head")
