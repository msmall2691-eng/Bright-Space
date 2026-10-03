"""The DATABASE_URL normalizer (utils/db_url.py, BB-DEPS-03).

This is small but load-bearing: it decides which DBAPI the app, the pre-deploy
Alembic run, and the Postgres test modules all address the database through.
Getting it wrong doesn't fail a feature, it fails `create_engine` at import --
the app won't boot at all. Hence pinning the behaviour rather than trusting it.
"""
from utils.db_url import normalize_db_url


def test_railway_postgres_alias_gets_the_driver():
    # Railway hands out postgres://, which SQLAlchemy has never accepted.
    assert normalize_db_url("postgres://u:p@h:5432/db") == "postgresql+psycopg://u:p@h:5432/db"


def test_bare_postgresql_gets_the_driver():
    # THE one that matters. A bare postgresql:// resolves to psycopg2 on
    # SQLAlchemy 2.0 and psycopg 3 on 2.1 -- we install only psycopg 3, so
    # leaving it bare makes booting depend on the SQLAlchemy pin.
    assert normalize_db_url("postgresql://u:p@h/db") == "postgresql+psycopg://u:p@h/db"


def test_explicit_psycopg2_is_rewritten_not_honored():
    # psycopg2 isn't installed; honoring it would only produce a worse error.
    assert normalize_db_url("postgresql+psycopg2://u@h/db") == "postgresql+psycopg://u@h/db"


def test_already_correct_url_is_unchanged():
    # Idempotent: these helpers get called on already-normalized values.
    url = "postgresql+psycopg://u@h/db"
    assert normalize_db_url(url) == url


def test_sqlite_is_left_alone():
    # Local dev and most of the suite run on SQLite; this must not touch them.
    assert normalize_db_url("sqlite:///./local.db") == "sqlite:///./local.db"


def test_other_explicit_driver_is_left_alone():
    # An explicit non-psycopg driver is a deliberate choice, not an unset
    # default, so it is respected.
    assert normalize_db_url("postgresql+asyncpg://u@h/db") == "postgresql+asyncpg://u@h/db"


def test_surrounding_whitespace_and_empty():
    assert normalize_db_url("  postgres://u@h/db  ") == "postgresql+psycopg://u@h/db"
    assert normalize_db_url("") == ""
    assert normalize_db_url(None) == ""
