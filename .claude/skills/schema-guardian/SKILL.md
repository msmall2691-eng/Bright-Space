---
name: schema-guardian
description: The authoring-time checklist for schema and data-model changes — load BEFORE editing database/models.py or writing an Alembic migration. Guards the invariants that have actually bitten this repo: tenant tables must be RLS-registered, money is float dollars (not integer cents), calendar days are Date, FK columns get an index, access details stay locked down. It governs schema DESIGN; brightbase-migrations governs Alembic mechanics, and scheduling-invariants overrides both for anything touching jobs/visits/recurring/sync.
---

# Schema Guardian

Load this **before** you add or change a column in `backend/database/models.py`
or write a migration under `backend/alembic/versions/`. Label schema-review
notes **[Schema Guardian]**.

This governs the **design** of a schema change — is the shape right, is it safe
for a live multi-tenant DB. It is not the Alembic mechanics:

- **`brightbase-migrations`** owns the migration itself — single head, real
  `downgrade()`, expand/contract to drop a column, SQLite-vs-Postgres, backfills.
- **`scheduling-invariants`** overrides everything here for any table touching
  jobs, visits, recurring rules, or calendar/iCal/Connecteam sync — R8 is
  additive-only, dual-write, verify, cut over. Say you checked it.

## The checklist

### 1. Tenant table → register it for RLS, in the same migration

Every tenant table carries `org_id` (MT-3). That column alone protects nothing:
the Postgres RLS backstop only covers a table that is **in `TENANT_TABLES`
(`database/rls.py`)** *and* had `apply_org_rls()` called for it. Migration 095
exists because two tables carried `org_id` for months, listed nowhere, silently
unprotected — CI stayed green the whole time.

So, in the **same migration that creates the table**:
1. add `org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)`,
2. add the table name to `TENANT_TABLES`,
3. call `apply_org_rls(...)` for it,
4. cover it with a tenancy-scope test (a cross-org row reads as 404 / doesn't list).

**This one is enforced.** `tests/test_schema_guardrails.py` fails if any
`org_id` table is missing from `TENANT_TABLES` (a deliberately-unscoped table
goes in `RLS_EXEMPT_ORG_TABLES` *with a reason* — today only `users`, because
auth resolves the user before any org context exists). The rest of this list is
on you.

### 2. Money is **float dollars** — match it

Every money column in this schema is `Column(Float)` — `Quote`/`Invoice`
subtotal/tax/discount/total, `Job.price`, `Opportunity.amount`, the pay/turnover
rates. A new money column is `Float`, in dollars. **Never** `String`, and don't
introduce `Numeric`/`Integer` for money on your own.

> ⚠️ `brightbase-migrations` says "money is integer cents (PR #199), a money
> column is `sa.Integer`." **That does not match this codebase** — there is no
> integer-cents money column anywhere; `test_quotes_integer.py` is about integer
> *ids*, not cents. Match the code (float dollars). Float has a real rounding
> cost on tax (`data-doctor`'s `quote_total_mismatch` catches drift), and moving
> the app to integer cents is a legitimate idea — but it's an owner decision and
> an app-wide migration, not something a new column does unilaterally.

### 3. A calendar day is `sa.Date`, never `DateTime` or `String`

`Job.scheduled_date`, `Quote.valid_until` are `Date`. Widening a calendar day to
`DateTime` reintroduces the duplicate-job / off-by-one bug PR #204 closed.
Timestamps (`created_at`, …) are `DateTime(timezone=True)`. And when you compare
a stored timestamp against a business day, go through `utils.dates.business_date`
/ `business_today` — the UTC date is tomorrow's date for four hours every Maine
evening.

### 4. Index the foreign keys you'll filter or join on

FK columns get `index=True` (migration 009 added the ones that were missing).
It's one Railway Postgres container — an unindexed FK on a hot filter is a
full-table scan that everyone feels. On a large table, create the index
`CONCURRENTLY` (outside the migration's transaction).

### 5. Access details never spread

Gate codes, door codes, lockbox locations, wifi passwords, `access_notes` live
on `properties` and are served only to the assigned cleaner and office roles
(BB-SEC-08…12). A migration that copies them into a new table, a denormalized
cache, or an audit/log row widens the blast radius of a leak. Don't — route it
through the security section of `brightbase-build` first.

### 6. NOT NULL / drop / rename on an existing column

That's expand/contract territory — **`brightbase-migrations`**. Short version:
never add `NOT NULL` to a populated column in one release (add nullable →
backfill → enforce later), never rename in place (add new → dual-write →
backfill → drop old), and drops wait a full business cycle. Prod has already
drifted (nullable `Job.property_id`, `Property.client_id` despite the models) —
`data-doctor` reports those; don't be the next one.

## Before you write

1. New table with `org_id`? → steps in §1, all four, same migration. The test
   will catch a missed registration but not a missing tenancy test — write both.
2. Money column? → `Float`, dollars (§2).
3. Any date? → calendar day = `Date`, timestamp = `DateTime(tz=True)` (§3).
4. FK you'll query on? → `index=True` (§4).
5. Touching a job/visit/recurring/sync table? → `scheduling-invariants` first.
6. Dropping/renaming/NOT-NULL-ing an existing column? → `brightbase-migrations`.
7. Anything with access details? → stop, §5.

Then run `tests/test_schema_guardrails.py` (it globs into CI) and, before deploy,
`data-doctor` for a read of what the change looks like against real data.
