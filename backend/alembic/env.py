from logging.config import fileConfig
from sqlalchemy import engine_from_config, inspect
from sqlalchemy import pool
from alembic import context
import os
from database.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# DATABASE_URL is REQUIRED — same contract as the app (database/db.py). The old
# default `sqlite:///./brightbase.db` was dangerous: if a deploy ever ran
# `alembic upgrade head` without DATABASE_URL in its environment, it would
# silently migrate a throwaway SQLite file inside the container, exit 0, and
# leave the real Postgres un-migrated (schema drift with a "successful" deploy).
# Fail loudly instead of migrating the wrong database.
database_url = os.getenv("DATABASE_URL", "").strip()
if not database_url:
    raise RuntimeError(
        "DATABASE_URL is not set — refusing to run migrations against the SQLite "
        "fallback. Set DATABASE_URL to the Postgres URL (production) or an explicit "
        "sqlite:///./local.db for local dev/tests."
    )
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
config.set_main_option("sqlalchemy.url", database_url)

# Log WHICH database we're migrating (host/db only — never the credentials) so
# the deploy logs make the target unambiguous. Answers "which DB did alembic
# actually touch?" at a glance.
def _redact(url: str) -> str:
    try:
        scheme = url.split("://", 1)[0]
        tail = url.split("@", 1)[1] if "@" in url else url.split("://", 1)[1]
        return f"{scheme}://…@{tail}" if "@" in url else f"{scheme}://{tail}"
    except Exception:
        return url.split("://", 1)[0] + "://…"
print(f"[alembic] migrating target: {_redact(database_url)}", flush=True)

def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.begin() as connection:
        inspector = inspect(connection)
        tables = inspector.get_table_names()
        has_alembic_version = 'alembic_version' in tables
        has_app_settings = 'app_settings' in tables

        # If tables exist but alembic_version doesn't, create it and mark 001 as applied
        # This prevents trying to re-create tables that already exist
        if has_app_settings and not has_alembic_version:
            try:
                connection.exec_driver_sql(
                    "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, "
                    "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
                )
                connection.exec_driver_sql(
                    "INSERT INTO alembic_version (version_num) VALUES ('001')"
                )
            except Exception:
                pass

        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        # Let migration errors propagate. The previous version swallowed any
        # "already exists" / DuplicateTable error and pass-ed, which silently
        # aborted the chain mid-way (leaving the DB behind a "successful" deploy)
        # AND hid the real failure from a manual `alembic upgrade head`. Failing
        # loudly is the only way drift gets noticed and fixed.
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
