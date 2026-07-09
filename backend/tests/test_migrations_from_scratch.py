"""Pin the fresh-install migration path.

scripts/db_bootstrap.py used to take a shortcut on empty databases: it called
``Base.metadata.create_all`` instead of ``alembic upgrade head``, because the
historical migration chain (migration 001 is a hand-written snapshot, plus a
handful of later migrations built for designs that were abandoned before
shipping) did not apply cleanly to a fresh database. That meant:

  1. Migrations were never exercised from scratch — a bad new migration could
     land on prod without being caught by CI.
  2. Drift between ``database/models`` (Base.metadata) and the accumulated
     migration state stayed silent, because prod never ran migrations
     end-to-end.

The chain has since been repaired (migration 001 now carries every column a
later migration doesn't add itself; a handful of migrations for designs that
were replaced before shipping — UUID-keyed quotes, an orphaned "property
intelligence" feature — are no-ops; the `orgs` table and the
alembic_version-width fix are now real migration steps). db_bootstrap.py no
longer branches on create_all() — every install runs the same migration path.

This test runs the full chain against a brand-new Postgres database, which is
what actually matters (SQLite can't run some of these migrations at all — a
few use Postgres-only SQL like ``array_agg``/``= ANY(...)`` in dedup queries,
which is fine since fresh installs are always Postgres). It runs ONLY when
RLS_TEST_DATABASE_URL points at a Postgres server (the CI "RLS (Postgres)" job
sets it via a postgres service, same as test_tenancy_rls_postgres.py); it's
skipped everywhere else.

To rerun by hand against any reachable Postgres server:
    RLS_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/brightspace_rls \\
    DATABASE_URL=sqlite:////tmp/unused.db JWT_SECRET=dev \\
        python -m pytest tests/test_migrations_from_scratch.py -v
"""
import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

_RAW = os.getenv("RLS_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(
    not _RAW.startswith(("postgresql://", "postgres://")),
    reason="RLS_TEST_DATABASE_URL not set to a Postgres DB",
)


def test_alembic_upgrade_head_from_empty_db():
    server_url = make_url(_RAW.replace("postgres://", "postgresql://", 1))
    fresh_db_name = f"brightspace_migtest_{uuid.uuid4().hex[:12]}"

    admin_url = server_url.set(database="postgres")
    admin_engine = create_engine(admin_url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{fresh_db_name}"'))
    admin_engine.dispose()

    fresh_url = server_url.set(database=fresh_db_name)
    try:
        os.environ["DATABASE_URL"] = str(fresh_url.render_as_string(hide_password=False))
        from alembic import command
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        # Reload the engine module so it picks up the new DATABASE_URL — the
        # migration env.py builds its own engine from the config, but any
        # imports side-effect'd on module load need a fresh module.
        import importlib
        import database.db as db_module
        importlib.reload(db_module)

        cfg = Config("alembic.ini")
        cfg.set_main_option("script_location", "alembic")
        command.upgrade(cfg, "head")

        script_dir = ScriptDirectory.from_config(cfg)
        expected_head = script_dir.get_current_head()

        check_engine = create_engine(fresh_url, poolclass=NullPool)
        with check_engine.connect() as conn:
            actual = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        check_engine.dispose()
        assert actual == expected_head
    finally:
        admin_engine = create_engine(admin_url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as conn:
            conn.execute(text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = :name AND pid <> pg_backend_pid()"
            ), {"name": fresh_db_name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{fresh_db_name}"'))
        admin_engine.dispose()
