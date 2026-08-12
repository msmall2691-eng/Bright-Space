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


@pytest.mark.parametrize("status,ok,code", [
    ("ok", True, 200),
    ("no_table", None, 200),        # fresh / SQLite dev — don't hard-fail
    ("error", None, 200),            # the checker itself broke — don't down the app
    ("drift", False, 503),           # DB off the code's head
    ("unreachable", None, 503),      # DB down / stale creds — the rotation incident
])
def test_health_gate_status_codes(monkeypatch, status, ok, code):
    monkeypatch.setattr(dbmod, "check_schema_drift", lambda: _drift(status, ok))
    res = TestClient(app).get("/api/health")
    assert res.status_code == code
    body = res.json()
    assert body["schema"]["status"] == status
    assert body["status"] == ("degraded" if code == 503 else "ok")


def test_health_real_check_on_test_db_is_200():
    # The real check against the create_all test DB → reachable but no
    # alembic_version → "no_table" → 200 (dev/first-boot isn't gated). The
    # schema block still carries the diagnostic fields.
    res = TestClient(app).get("/api/health")
    assert res.status_code == 200
    schema = res.json()["schema"]
    assert schema["status"] == "no_table"
    assert schema["head_revision"]
