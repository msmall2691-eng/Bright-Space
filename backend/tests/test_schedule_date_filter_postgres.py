"""Regression: the Schedule's date filter must compare DATE to DATE on Postgres.

Production 500'd the whole office Schedule with

    ProgrammingError: operator does not exist: date >= character varying

because get_jobs filtered the Job.scheduled_date DATE column against the raw
'YYYY-MM-DD' *strings* from the query params. SQLite compares those leniently,
so the sqlite suite never caught it; Postgres has no date>=varchar operator and
fails at PLAN time — before any row is read — so this needs no seeded data.

Gated on RLS_TEST_DATABASE_URL (the CI "RLS (Postgres)" job's postgres
service), like the RLS tests; skipped on sqlite. Connects as the superuser in
that URL, so RLS (applied to `clients` by the RLS test) doesn't affect these
whole-table plans.
"""
import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy.exc import ProgrammingError

from utils.db_url import normalize_db_url

_RAW = os.getenv("RLS_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(
    not _RAW.startswith("postgres"),
    reason="RLS_TEST_DATABASE_URL not set to a Postgres DB",
)


@pytest.fixture(scope="module")
def pg_session():
    from database.models import Base
    engine = create_engine(normalize_db_url(_RAW), poolclass=NullPool)
    Base.metadata.create_all(engine)  # idempotent; shares the RLS DB schema
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


def test_raw_string_bound_is_the_production_500(pg_session):
    """Pin the actual failure: a DATE column compared to a string has no
    operator on Postgres and throws at plan time (no rows needed)."""
    from database.models import Job
    with pytest.raises(ProgrammingError):
        pg_session.query(Job).filter(Job.scheduled_date >= "2026-10-01").all()
    pg_session.rollback()


def test_get_jobs_with_string_date_params_runs_on_postgres(pg_session):
    """The real guard: get_jobs is handed 'YYYY-MM-DD' strings (that's what the
    Schedule page sends). Before the coerce_date fix this raised the error above
    and 500'd the week; now it plans and returns a list. Empty schema is fine —
    the bug is at PLAN time, which is what this exercises."""
    import modules.scheduling.router as sched
    out = sched.get_jobs(
        date_from="2026-10-01", date_to="2026-10-31",
        db=pg_session, org_id=1, current_user=None,
    )
    assert isinstance(out, list)

    # The single-day equality bound took the same string → date path.
    out2 = sched.get_jobs(date="2026-10-15", db=pg_session, org_id=1, current_user=None)
    assert isinstance(out2, list)
