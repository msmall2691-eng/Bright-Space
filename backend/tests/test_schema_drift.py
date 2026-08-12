"""Startup schema-drift check (BB-0608-02): resolves the code's head revision and
never raises, so a behind-on-migrations DB is logged loudly instead of 500-ing."""
from sqlalchemy import create_engine, text

from database.db import check_schema_drift, engine
import database.db as dbmod


def test_schema_drift_resolves_head_and_is_fail_soft():
    out = check_schema_drift()
    # Always returns a dict with a resolvable head revision; never raises.
    assert isinstance(out, dict)
    assert out.get("head_revision"), "head revision should resolve from alembic/versions"
    # ok is True (in sync), False (drift), or None (couldn't verify, e.g. no
    # alembic_version table on the create_all test DB) — but never an exception.
    assert out.get("ok") in (True, False, None)
    # A machine-readable status the health endpoint keys on. The create_all test
    # DB is reachable but has no alembic_version, so it's "no_table" — NOT a
    # mislabeled "unreachable"/"table not found" that used to swallow an auth
    # failure and read the same on a healthy DB.
    assert out.get("status") in (
        "ok", "behind", "ahead", "no_table", "no_table_drifted", "unreachable", "error")
    # The create_all test DB has application tables but no alembic_version, so
    # it's "no_table_drifted" (data present, tracking gone) — NOT a clean empty
    # DB, and NOT a mislabeled failure.
    assert out["status"] == "no_table_drifted"
    assert out["ok"] is False


def _seed_alembic_version(rev):
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE IF NOT EXISTS alembic_version (version_num varchar(64) NOT NULL)"))
        conn.execute(text("DELETE FROM alembic_version"))
        conn.execute(text("INSERT INTO alembic_version (version_num) VALUES (:r)"), {"r": rev})


def _drop_alembic_version():
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS alembic_version"))


def test_drift_behind_when_db_is_an_ancestor_of_head():
    # 068 is a real ancestor of the current head → "behind" (the gate-worthy
    # direction: the app expects columns the DB doesn't have yet).
    _seed_alembic_version("068_schedule_event_log")
    try:
        out = check_schema_drift()
        assert out["status"] == "behind"
        assert out["ok"] is False
        assert out["db_revision"] == "068_schedule_event_log"
    finally:
        _drop_alembic_version()


def test_drift_ahead_when_db_revision_is_newer_than_code():
    # A revision this code's scripts don't contain → rollback / newer DB →
    # "ahead": flagged (ok False) but NOT gated, so a rollback keeps its
    # healthcheck.
    _seed_alembic_version("999_from_the_future")
    try:
        out = check_schema_drift()
        assert out["status"] == "ahead"
        assert out["ok"] is False
        assert out["db_revision"] == "999_from_the_future"
    finally:
        _drop_alembic_version()


def test_no_table_on_genuinely_empty_db(monkeypatch):
    # A DB with NO tables at all (real first boot) → clean "no_table", not the
    # gated "no_table_drifted" reserved for a DB that lost its tracking but kept
    # its data. Swap in a throwaway empty engine so check_schema_drift sees it.
    monkeypatch.setattr(dbmod, "engine", create_engine("sqlite://"))
    out = check_schema_drift()
    assert out["status"] == "no_table"
    assert out["ok"] is None
