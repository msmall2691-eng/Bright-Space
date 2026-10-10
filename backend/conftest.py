"""Pytest bootstrap for the backend test suite.

Sets safe defaults for the env vars the app reads at import time so tests run
the same locally and in CI without exporting anything. setdefault means a real
environment (or an individual test) can still override.

## The suite starts from an empty database

It did not, and that cost real debugging time. This file pointed the suite at
`/tmp/brightspace_ci_test.db` and nothing ever reset it, so every local run
added rows to the same file. Tests that count things — `assert len(rows) == 1`
— then fail based on HOW MANY TIMES you have run the suite rather than on
anything in the code.

Measured on 2026-10-10: clean `main` showed 8 failures and a feature branch 20,
purely from accumulated rows. Both were clean on a fresh file. CI never sees it
because every run gets a new container, which is exactly what makes it
dangerous: `python -m pytest` locally is the check you run *before* pushing, and
it was returning failures that had nothing to do with your change. It sent me
hunting a regression I had not written.

`test_placeholder_absorption.py` has done this correctly all along (it deletes
its own DB at import); this is the same thing for the shared one.

## Why delete the file rather than drop the tables

`drop_all()` is not available: `User` <-> `Client` is a genuine two-table FK
cycle (User.client_id / Client.created_by+updated_by), which
`test_phone_tail.py`'s docstring already records. Removing the file sidesteps
the cycle entirely, and `tests/conftest.py` recreates the schema per session.

## The safety condition, which is the whole point of `_OWNS_DATABASE`

Deleting a database is only ever safe when WE chose it. If `DATABASE_URL` is
already set — a developer pointing at a local Postgres, or at something worse —
this must not touch it, and must not delete some unrelated SQLite file either.
So the reset is gated on having supplied the default ourselves, and on the URL
still being that default.
"""
import os
import sys
from pathlib import Path

os.environ.setdefault("JWT_SECRET", "test-secret-ci")

# File-based SQLite — the app's module-level engine rejects in-memory's pool
# args. Tests needing isolation create their own engine/DB.
DEFAULT_DATABASE_URL = "sqlite:////tmp/brightspace_ci_test.db"

# Read BEFORE setdefault: afterwards there is no way to tell whether the value
# is ours or the environment's, and that distinction is what makes the reset
# below safe.
_OWNS_DATABASE = "DATABASE_URL" not in os.environ
os.environ.setdefault("DATABASE_URL", DEFAULT_DATABASE_URL)


def sqlite_path(url):
    """The filesystem path behind a file-based SQLite URL, or None.

    `sqlite:////tmp/x.db` is an ABSOLUTE path (four slashes) and
    `sqlite:///./x.db` a relative one (three). Anything that is not file-based
    SQLite — Postgres, or `:memory:` — returns None, so a caller cannot be
    handed a path for a database that has no file to delete.
    """
    prefix = "sqlite:///"
    if not url or not url.startswith(prefix):
        return None
    rest = url[len(prefix):]
    if not rest or rest == ":memory:":
        return None
    return Path(rest)


def _reset_default_database():
    """Delete the suite's own SQLite file so collection starts from empty.

    Runs at import, before any test module pulls in `database.db` and builds
    the engine — deleting the file out from under a live connection would be a
    different bug.
    """
    if not _OWNS_DATABASE:
        return
    # Belt and braces: an individual test may have reassigned DATABASE_URL
    # between the setdefault above and here. Only our own default is ours to
    # remove.
    if os.environ.get("DATABASE_URL") != DEFAULT_DATABASE_URL:
        return
    path = sqlite_path(DEFAULT_DATABASE_URL)
    if path is None:
        return
    # `-wal` / `-shm` only exist under WAL journaling, which this suite does not
    # enable — removed anyway, because leaving a stale sidecar next to a fresh
    # database is the kind of half-reset that produces a confusing failure
    # once rather than consistently.
    for p in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        try:
            p.unlink(missing_ok=True)
        except OSError as exc:
            # Loud, but not fatal: an undeletable file leaves the suite in the
            # polluted state it has always been in, which is no worse than
            # before — while a hard exit over a stale lock in /tmp would block
            # work. Silence is the one option that is not acceptable, since
            # silence is how this cost a day of confusion in the first place.
            print(
                f"[conftest] WARNING: could not remove {p}: {exc}\n"
                f"[conftest] The suite is running against a database that may "
                f"hold rows from earlier runs; counting assertions can fail "
                f"for reasons unrelated to your change.",
                file=sys.stderr,
            )


_reset_default_database()
