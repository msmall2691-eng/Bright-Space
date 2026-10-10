"""The suite starts from an empty database, and only ever deletes its own.

`conftest.py` pointed the backend suite at `/tmp/brightspace_ci_test.db` and
nothing reset it, so every local run added rows to the same file. Counting
assertions then failed on how many times you had run the suite rather than on
anything in the code: on 2026-10-10, clean `main` showed 8 failures and a
feature branch 20, both clean on a fresh file. CI never sees it, because every
run gets a new container — which is what made it costly. `python -m pytest` is
the check you run BEFORE pushing, and it was reporting failures unrelated to the
change under test.

## What is actually worth testing here

Not "does the file get deleted" — it plainly does, and the suite you are
reading this inside is the proof. What needs guarding is the SAFETY CONDITION:
deleting a database is only ever acceptable when conftest chose that database
itself. A developer with `DATABASE_URL` pointed at a local Postgres, or at
anything else they care about, must come out of this untouched.

So every case below redirects the module's constants at a temp file. Calling
`_reset_default_database()` against the live default would delete the database
this very suite is running on, mid-run — which is a good illustration of why
the gate exists.
"""
import os
from pathlib import Path

import pytest

import conftest as root_conftest


@pytest.fixture
def db_file(tmp_path):
    """A stand-in for the suite's own SQLite file, with rows in it."""
    p = tmp_path / "pretend_ci.db"
    p.write_bytes(b"not really sqlite, but a file that must or must not survive")
    return p


def _point_at(monkeypatch, path, *, owns=True, url=None):
    """Aim conftest's reset at `path` instead of the live database."""
    target = url if url is not None else f"sqlite:///{path}"
    monkeypatch.setattr(root_conftest, 'DEFAULT_DATABASE_URL', target)
    monkeypatch.setattr(root_conftest, '_OWNS_DATABASE', owns)
    monkeypatch.setitem(os.environ, 'DATABASE_URL', target)


class TestSafetyCondition:
    """The half that matters: what it refuses to delete."""

    def test_does_nothing_when_the_environment_supplied_the_database(self, monkeypatch, db_file):
        # The real hazard. DATABASE_URL already set means someone chose it —
        # a local Postgres, a scratch copy of production — and it is not ours
        # to remove, whatever it points at.
        _point_at(monkeypatch, db_file, owns=False)
        root_conftest._reset_default_database()
        assert db_file.exists(), "deleted a database the environment supplied"

    def test_does_nothing_when_the_url_moved_off_the_default(self, monkeypatch, db_file):
        # Belt and braces: a test module may reassign DATABASE_URL after
        # conftest's setdefault. Only the exact default is ours.
        _point_at(monkeypatch, db_file, owns=True)
        monkeypatch.setitem(os.environ, 'DATABASE_URL', 'sqlite:////tmp/somewhere_else.db')
        root_conftest._reset_default_database()
        assert db_file.exists(), "deleted a file the URL no longer pointed at"

    @pytest.mark.parametrize('url', [
        'postgresql://user:pw@localhost:5432/brightbase',
        'postgresql+psycopg://user:pw@host/db',
        'sqlite://',
        'sqlite:///:memory:',
        '',
    ])
    def test_never_derives_a_path_from_a_database_with_no_file(self, url):
        # sqlite_path returning None is what stops a Postgres URL, or an
        # in-memory one, from being turned into something unlink() will accept.
        assert root_conftest.sqlite_path(url) is None

    def test_a_postgres_url_deletes_nothing(self, monkeypatch, db_file):
        _point_at(monkeypatch, db_file, owns=True,
                  url='postgresql://user:pw@localhost:5432/brightbase')
        root_conftest._reset_default_database()
        assert db_file.exists()


class TestTheReset:
    """The half that does the work."""

    def test_removes_its_own_database(self, monkeypatch, db_file):
        _point_at(monkeypatch, db_file, owns=True)
        root_conftest._reset_default_database()
        assert not db_file.exists()

    def test_removes_the_wal_and_shm_sidecars(self, monkeypatch, db_file):
        # Not enabled by this suite, but a stale sidecar beside a fresh database
        # is the kind of half-reset that fails confusingly once rather than
        # consistently.
        wal = Path(f"{db_file}-wal"); wal.write_bytes(b'wal')
        shm = Path(f"{db_file}-shm"); shm.write_bytes(b'shm')
        _point_at(monkeypatch, db_file, owns=True)
        root_conftest._reset_default_database()
        assert not db_file.exists()
        assert not wal.exists() and not shm.exists()

    def test_is_fine_when_there_is_nothing_to_delete(self, monkeypatch, tmp_path):
        # First run on a clean machine, and CI every time.
        missing = tmp_path / 'never_existed.db'
        _point_at(monkeypatch, missing, owns=True)
        root_conftest._reset_default_database()  # must not raise
        assert not missing.exists()

    def test_warns_loudly_instead_of_dying_when_it_cannot_delete(
            self, monkeypatch, db_file, capsys):
        # A stale lock in /tmp should not block the whole suite — but it must
        # not pass in silence either, since silence is how the original problem
        # hid. (Forced via unlink rather than permissions: these tests run as
        # root, where chmod would not stop the delete.)
        def _boom(self, missing_ok=False):
            raise OSError(16, 'Device or resource busy')
        monkeypatch.setattr(Path, 'unlink', _boom)
        _point_at(monkeypatch, db_file, owns=True)

        root_conftest._reset_default_database()  # must not raise

        err = capsys.readouterr().err
        assert 'could not remove' in err
        assert 'rows from earlier runs' in err, \
            "the warning must say what goes wrong, not just that something did"


class TestSqlitePathParsing:
    def test_four_slashes_is_absolute(self):
        assert root_conftest.sqlite_path('sqlite:////tmp/x.db') == Path('/tmp/x.db')

    def test_three_slashes_is_relative(self):
        assert root_conftest.sqlite_path('sqlite:///./x.db') == Path('./x.db')

    def test_the_live_default_resolves_to_the_documented_file(self):
        # Pins the constant and its parse together, so the docstring's claim
        # about /tmp/brightspace_ci_test.db cannot drift from the code.
        assert root_conftest.sqlite_path(root_conftest.DEFAULT_DATABASE_URL) \
            == Path('/tmp/brightspace_ci_test.db')
