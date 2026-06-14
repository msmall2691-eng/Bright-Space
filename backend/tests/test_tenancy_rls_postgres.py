"""MT-3 validation: prove Postgres Row-Level Security actually enforces tenant
isolation — the backstop for a query that forgets its org filter (MT-2).

RLS is Postgres-only and is applied by migration 028 (no-op on SQLite), so the
sqlite CI suite can't exercise it. This module runs ONLY when
RLS_TEST_DATABASE_URL points at a Postgres DB (the CI "RLS (Postgres)" job sets
it via a postgres service); it's skipped everywhere else.

It builds the schema, applies migration 028's exact policy to `clients`, then
connects as a NON-superuser role (superusers bypass RLS) and asserts:
  1. with the GUC set to org 1, an unfiltered SELECT sees only org-1 rows;
  2. WITH CHECK blocks writing a row for another org;
  3. with the GUC unset (background jobs / migrations), the policy no-ops.
The GUC is set with `SET LOCAL` inside a transaction, exactly like the app's
set_rls_org_context().
"""
import os
import importlib.util
import pathlib
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

_RAW = os.getenv("RLS_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(
    not _RAW.startswith(("postgresql://", "postgres://")),
    reason="RLS_TEST_DATABASE_URL not set to a Postgres DB (RLS is Postgres-only)",
)

_APP_ROLE = "rls_app"
_APP_PW = "rls_app_pw"


def _migration_policy():
    """Pull the EXACT USING/policy-name from migration 028 so this test tracks
    the real policy text (no drift)."""
    path = pathlib.Path(__file__).resolve().parent.parent / "alembic" / "versions" / "028_tenant_rls.py"
    spec = importlib.util.spec_from_file_location("_m028", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._USING, mod._POLICY


@pytest.fixture(scope="module")
def app_url():
    """Set up schema + RLS on `clients` as the superuser, create a non-superuser
    app role, and return a URL that connects as that role."""
    from database.models import Base

    super_url = make_url(_RAW.replace("postgres://", "postgresql://", 1))
    using, policy = _migration_policy()
    su = create_engine(super_url, poolclass=NullPool)

    with su.begin() as c:
        Base.metadata.create_all(bind=c)
        # Apply migration 028's policy to clients (idempotent).
        c.execute(text('ALTER TABLE clients ENABLE ROW LEVEL SECURITY'))
        c.execute(text('ALTER TABLE clients FORCE ROW LEVEL SECURITY'))
        c.execute(text(f'DROP POLICY IF EXISTS {policy} ON clients'))
        c.execute(text(f'CREATE POLICY {policy} ON clients USING ({using}) WITH CHECK ({using})'))
        # Non-superuser role (superusers bypass RLS entirely, even with FORCE).
        c.execute(text(
            f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{_APP_ROLE}') "
            f"THEN CREATE ROLE {_APP_ROLE} LOGIN NOSUPERUSER PASSWORD '{_APP_PW}'; END IF; END $$;"
        ))
        c.execute(text(f"GRANT USAGE ON SCHEMA public TO {_APP_ROLE}"))
        c.execute(text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO {_APP_ROLE}"))

    su.dispose()
    return super_url.set(username=_APP_ROLE, password=_APP_PW)


@pytest.fixture
def seeded(app_url):
    """Seed two orgs and one client each, as the superuser (bypasses RLS).
    Returns the unique tag so assertions can target this run's rows."""
    from database.models import Base  # noqa: F401  (ensure models imported)
    super_url = make_url(_RAW.replace("postgres://", "postgresql://", 1))
    su = create_engine(super_url, poolclass=NullPool)
    tag = uuid.uuid4().hex[:8]
    with su.begin() as c:
        # Two orgs with ids that won't collide with the default workspace.
        rows = c.execute(text(
            "INSERT INTO orgs (name, slug) VALUES "
            "(:n1, :s1), (:n2, :s2) RETURNING id"
        ), {"n1": f"A {tag}", "s1": f"a-{tag}", "n2": f"B {tag}", "s2": f"b-{tag}"}).fetchall()
        org_a, org_b = rows[0][0], rows[1][0]
        c.execute(text("INSERT INTO clients (org_id, name, status) VALUES (:o, :n, 'active')"),
                  {"o": org_a, "n": f"A-Client-{tag}"})
        c.execute(text("INSERT INTO clients (org_id, name, status) VALUES (:o, :n, 'active')"),
                  {"o": org_b, "n": f"B-Client-{tag}"})
    su.dispose()
    yield {"tag": tag, "org_a": org_a, "org_b": org_b}
    su = create_engine(super_url, poolclass=NullPool)
    with su.begin() as c:
        c.execute(text("DELETE FROM clients WHERE name LIKE :p"), {"p": f"%-{tag}"})
        c.execute(text("DELETE FROM orgs WHERE slug LIKE :p"), {"p": f"%-{tag}"})
    su.dispose()


def test_select_isolated_to_org(app_url, seeded):
    """GUC = org A → an unfiltered SELECT returns A's client, never B's."""
    eng = create_engine(app_url, poolclass=NullPool)
    with eng.connect() as c:
        with c.begin():
            c.execute(text(f"SET LOCAL app.current_org_id = {int(seeded['org_a'])}"))
            names = {r[0] for r in c.execute(text("SELECT name FROM clients"))}
    eng.dispose()
    assert f"A-Client-{seeded['tag']}" in names
    assert f"B-Client-{seeded['tag']}" not in names, "RLS leak: saw another org's row"


def test_with_check_blocks_cross_org_write(app_url, seeded):
    """GUC = org A → inserting a row tagged org B is rejected by WITH CHECK."""
    from sqlalchemy.exc import DBAPIError
    eng = create_engine(app_url, poolclass=NullPool)
    with eng.connect() as c:
        with pytest.raises(DBAPIError):
            with c.begin():
                c.execute(text(f"SET LOCAL app.current_org_id = {int(seeded['org_a'])}"))
                c.execute(text("INSERT INTO clients (org_id, name, status) VALUES (:o, 'sneaky', 'active')"),
                          {"o": int(seeded["org_b"])})
    eng.dispose()


def test_unset_guc_is_noop(app_url, seeded):
    """No GUC (background jobs, migrations) → policy no-ops, sees all orgs."""
    eng = create_engine(app_url, poolclass=NullPool)
    with eng.connect() as c:
        val = c.execute(text("SELECT current_setting('app.current_org_id', true)")).scalar()
        names = {r[0] for r in c.execute(text("SELECT name FROM clients"))}
    eng.dispose()
    assert val is None
    assert {f"A-Client-{seeded['tag']}", f"B-Client-{seeded['tag']}"} <= names
