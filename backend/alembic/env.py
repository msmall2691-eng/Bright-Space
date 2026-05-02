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

database_url = os.getenv("DATABASE_URL", "sqlite:///./brightbase.db")
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
config.set_main_option("sqlalchemy.url", database_url)

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

        with context.begin_transaction():
            try:
                context.run_migrations()
            except Exception as e:
                if "already exists" in str(e) or "DuplicateTable" in str(type(e)):
                    pass
                else:
                    raise


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
