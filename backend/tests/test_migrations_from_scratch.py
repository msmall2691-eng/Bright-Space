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
import sqlalchemy as sa
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

_RAW = os.getenv("RLS_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(
    not _RAW.startswith(("postgresql://", "postgres://")),
    reason="RLS_TEST_DATABASE_URL not set to a Postgres DB",
)


def _schema_parity_issues(engine) -> list[str]:
    """Compare the migrated schema against database/models' Base.metadata.

    reaching "head" without an error (the assertion below) only proves the
    migration SQL is syntactically valid — it says nothing about whether the
    resulting schema actually matches what the ORM models expect. Migration
    001 drifted from models.py for years without this ever failing: a column
    declared VARCHAR instead of DATE/TIME/JSON/BOOLEAN inserts fine (Postgres
    just stores whatever string/int SQLAlchemy sends) and only breaks at
    query time, on a WHERE/filter — which a plain "did upgrade raise?" check
    never exercises. This walks every mapped table/column and flags anything
    genuinely missing or type-mismatched, so that class of drift fails CI
    immediately instead of silently waiting for a fresh install to 500."""
    from database.models import Base

    insp = sa.inspect(engine)
    live_tables = set(insp.get_table_names())
    issues = []

    for table_name, table in Base.metadata.tables.items():
        if table_name not in live_tables:
            issues.append(f"table '{table_name}' is missing entirely")
            continue
        live_cols = {c["name"]: c["type"] for c in insp.get_columns(table_name)}
        for column in table.columns:
            if column.name not in live_cols:
                issues.append(f"{table_name}.{column.name} is missing")
                continue
            # Compare via each type's own Python/affinity class rather than a
            # literal string match — DATE/TIMESTAMP/etc. render differently
            # across dialects, but python_type stays stable for our purposes
            # (str, bool, date, time, dict/list via JSON, etc).
            expected_py = getattr(column.type, "python_type", None)
            live_py = getattr(live_cols[column.name], "python_type", None)
            if expected_py is None or live_py is None:
                continue
            if expected_py is not live_py:
                issues.append(
                    f"{table_name}.{column.name}: migrated type {live_cols[column.name]} "
                    f"(python {live_py}) != model type {column.type} (python {expected_py})"
                )
    return issues


def _missing_rls_policies(engine) -> list[str]:
    """Every TENANT_TABLES entry must actually carry the org policy.

    Being on the list does nothing by itself — the policy exists only where a
    migration called apply_org_rls(). tests/test_tenancy_rls_postgres.py builds
    the schema with create_all and then calls apply_org_rls itself, so it
    proves the FUNCTION works and never that any deploy path invokes it. That
    is how eight marketplace tables (W-9 scans, payouts, claim requests) sat on
    the protected list for months with no policy behind them, and how the same
    gap opened for nine others before them.

    This asserts the property that actually matters, against the real chain:
    after `alembic upgrade head` on an empty database, is the backstop there?
    """
    from database.rls import POLICY, TENANT_TABLES

    insp = sa.inspect(engine)
    live = set(insp.get_table_names())
    with engine.connect() as conn:
        protected = {
            row[0] for row in conn.execute(
                text("SELECT tablename FROM pg_policies WHERE policyname = :p"),
                {"p": POLICY},
            )
        }
    # A table the chain never creates is a different bug; this check is only
    # about tables that exist and are claimed to be protected.
    return sorted(t for t in TENANT_TABLES if t in live and t not in protected)


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
        assert actual == expected_head

        issues = _schema_parity_issues(check_engine)
        unprotected = _missing_rls_policies(check_engine)
        check_engine.dispose()
        assert not issues, "migrated schema drifted from database/models:\n" + "\n".join(issues)
        assert not unprotected, (
            "TENANT_TABLES entries with no RLS policy after the full migration "
            "chain — the backstop the list claims to provide is not there:\n  "
            + "\n  ".join(unprotected)
        )
    finally:
        admin_engine = create_engine(admin_url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as conn:
            conn.execute(text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = :name AND pid <> pg_backend_pid()"
            ), {"name": fresh_db_name})
            conn.execute(text(f'DROP DATABASE IF EXISTS "{fresh_db_name}"'))
        admin_engine.dispose()
