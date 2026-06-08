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
