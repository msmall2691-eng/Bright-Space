"""Startup schema-drift check (BB-0608-02): resolves the code's head revision and
never raises, so a behind-on-migrations DB is logged loudly instead of 500-ing."""
from database.db import check_schema_drift


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
    assert out.get("status") in ("ok", "drift", "no_table", "unreachable", "error")
    assert out["status"] == "no_table"
    assert out["ok"] is None
