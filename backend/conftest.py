"""Pytest bootstrap for the backend test suite.

Sets safe defaults for the env vars the app reads at import time so tests run
the same locally and in CI without exporting anything. setdefault means a real
environment (or an individual test) can still override.
"""
import os

os.environ.setdefault("JWT_SECRET", "test-secret-ci")
# File-based SQLite — the app's module-level engine rejects in-memory's pool
# args. Tests needing isolation create their own engine/DB.
os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/brightspace_ci_test.db")
