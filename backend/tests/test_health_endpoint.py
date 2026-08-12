"""/api/health must fail the deploy gate (non-200) when the app genuinely can't
serve — DB unreachable or schema drift — and stay 200 for a healthy or fresh/dev
DB.

Regression for the 2026-08 password-rotation incident: the running app couldn't
reach its database (stranded on the pre-rotation password), but /api/health
returned a hardcoded 200, so Railway's healthcheck gate promoted the broken
deploy anyway.
"""
import pytest
from fastapi.testclient import TestClient

from main import app
import database.db as dbmod


def _drift(status, ok):
    return {"status": status, "ok": ok, "db_revision": None,
            "head_revision": "073_time_entry_one_open", "error": None}


@pytest.mark.parametrize("status,ok,code,top", [
    ("ok", True, 200, "ok"),
    ("no_table", None, 200, "ok"),               # genuinely EMPTY DB — real first boot
    ("ahead", False, 200, "degraded"),            # rollback / newer DB — flagged, NOT gated
    ("error", None, 200, "degraded"),             # the checker broke — flagged, app stays up
    ("behind", False, 503, "degraded"),           # DB behind the code's head — gate fails
    ("no_table_drifted", False, 503, "degraded"), # data present but lost alembic_version (June-8)
    ("unreachable", None, 503, "degraded"),       # DB down / stale creds — the rotation incident
])
def test_health_gate_status_codes(monkeypatch, status, ok, code, top):
    monkeypatch.setattr(dbmod, "check_schema_drift", lambda: _drift(status, ok))
    res = TestClient(app).get("/api/health")
    assert res.status_code == code
    body = res.json()
    assert body["schema"]["status"] == status
    assert body["status"] == top


def test_health_real_check_on_test_db_is_503_drifted():
    # The real check against the create_all test DB: it HAS application tables
    # but no alembic_version → "no_table_drifted" → 503. Data present with
    # migration tracking gone is gate-worthy (the June-8 prod state); a
    # genuinely empty DB would be "no_table"/200 instead.
    res = TestClient(app).get("/api/health")
    assert res.status_code == 503
    schema = res.json()["schema"]
    assert schema["status"] == "no_table_drifted"
    assert schema["head_revision"]
