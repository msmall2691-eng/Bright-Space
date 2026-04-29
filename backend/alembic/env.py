from logging.config import fileConfig
from sqlalchemy import engine_from_config, inspect
from sqlalchemy import pool
from alembic import context
import os
from database.models import Base

# this is the Alembic Config object
config = context.config

# Interpret the config file for Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Set target_metadata to use SQLAlchemy Base metadata for auto-generating migrations
target_metadata = Base.metadata

# Get database URL from environment or use default
database_url = os.getenv("DATABASE_URL", "sqlite:///./brightbase.db")
# Handle postgres:// URLs (Railway compatibility)
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

    with connectable.connect() as connection:
        # Check if alembic_version table exists and if app_settings table already exists
        inspector = inspect(connection)
        tables = inspector.get_table_names()
        has_alembic_version = 'alembic_version' in tables
        has_app_settings = 'app_settings' in tables

        # If app_settings exists but alembic_version doesn't, mark migration 001 as applied
        if has_app_settings and not has_alembic_version:
            with connection.begin():
                connection.execute(
                    connection.exec_driver_sql(
                        "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, "
                        "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
                    )
                )
                connection.execute(
                    connection.exec_driver_sql(
                        "INSERT INTO alembic_version (version_num) VALUES ('001')"
                    )
                )

        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
