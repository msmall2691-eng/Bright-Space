# MT-3 — Postgres Row-Level Security: validation

Multi-tenant isolation has three layers:

- **MT-1** — every tenant table has an `org_id` column (migration `027`).
- **MT-2** — every endpoint filters by the caller's org (`current_org_id` /
  `resolve_org_id`). Tested in CI on SQLite (`tests/test_tenancy_scope_*.py`).
- **MT-3** — Postgres Row-Level Security as a backstop: a query that *forgets*
  its org filter still can't cross tenants. Applied by migration `028`
  (`bb_org_isolation` policy on every tenant table). **Postgres-only** — a no-op
  on SQLite, so the sqlite CI suite can't exercise it.

## How MT-3 is now validated

`tests/test_tenancy_rls_postgres.py` proves the policy actually enforces
isolation. It runs **only** when `RLS_TEST_DATABASE_URL` points at Postgres
(skipped otherwise), applies migration 028's exact policy to `clients`, then
connects as a **non-superuser** role (superusers bypass RLS, even with `FORCE`)
and asserts:

1. **SELECT isolation** — with `SET LOCAL app.current_org_id = <org>`, an
   *unfiltered* `SELECT * FROM clients` returns only that org's rows.
2. **WITH CHECK** — inserting a row tagged with another org is rejected.
3. **Unset GUC is a no-op** — with no GUC set (background jobs, migrations,
   `psql`), `current_setting('app.current_org_id', true)` is `NULL` and the
   policy sees all rows, so nothing breaks.

The GUC is set with `SET LOCAL` inside a transaction, exactly like the app's
`set_rls_org_context()`.

### CI

The **`RLS (Postgres)`** job in `.github/workflows/ci.yml` runs this test against
a `postgres:16` service on every PR, so MT-3 is validated automatically from now
on — not just on a live Railway DB.

### Run it locally

```bash
cd backend
# point at any Postgres you can reach (a throwaway DB is fine)
RLS_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/brightspace_rls \
DATABASE_URL=sqlite:////tmp/local.db JWT_SECRET=dev \
  python -m pytest tests/test_tenancy_rls_postgres.py -v
```

## Known issue: migrations don't apply cleanly from scratch on Postgres

`alembic upgrade head` against a **brand-new empty** Postgres fails on a data
migration that references `conversations.channel` before that column exists
(`psycopg2.errors.UndefinedColumn: column "channel" does not exist`). This does
**not** affect incremental upgrades of the existing production DB (which already
has the column), but a clean-room deploy (new Railway DB / preview env) would
fail at that step.

This validation work uses `Base.metadata.create_all()` + the migration-028 policy
DDL to build the schema, so it sidesteps the chain. The from-scratch migration
ordering is a separate fix (re-order/guard the data migration) — tracked, not
addressed here.

## Pre-flight for a real Railway deploy

Deploy config itself is ready (`railway.json`, `Dockerfile`, `database/db.py`).
Before relying on a fresh environment:

- Set `DATABASE_URL` (Railway Postgres) and a **stable** `JWT_SECRET` (a random
  per-process secret logs everyone out on restart).
- Ensure the app's DB role is **not** a superuser, or RLS is silently bypassed.
- After migrating, sanity-check: connect as the app role, `SET app.current_org_id`
  to one org, and confirm you can't read another org's rows.
