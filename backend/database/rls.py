"""Postgres Row-Level Security for multi-tenant isolation (MT-3).

Shared by Alembic migration 028 (the upgrade path for existing DBs) and the
fresh-DB bootstrap (scripts/db_bootstrap.py), so both apply byte-identical
policies. No-op on non-Postgres (SQLite has no RLS).

Policy: every tenant table only exposes rows for the request's org, read from
the per-transaction GUC `app.current_org_id` (set by the current_org_id
dependency). When the GUC is unset — background jobs, migrations, psql — the
policy is a no-op (sees all rows), so nothing breaks. FORCE makes even the
table owner subject to it.
"""
import sqlalchemy as sa

# Every table that carries org_id (migration 027) plus saved_views (029).
TENANT_TABLES = [
    "clients", "properties", "property_icals", "ical_events", "recurring_schedules",
    "recurrence_exceptions", "jobs", "lead_intakes", "invoices",
    "conversations", "messages", "opportunities", "contact_emails", "contact_phones",
    "activities", "quotes", "cleaner_time_off",
    "integration_events", "saved_views",
    # Phase 2 scheduling redesign (migration 068): the append-only event log and
    # per-target projection bookkeeping. Both carry org_id.
    "schedule_events", "projection_state",
    # Inbox triage (migration 069): the captured automated-email stream behind the
    # board's Systems & Subscriptions / Safe to Ignore sections.
    "inbox_triage_items",
    # Native crew time clock (migration 070): clock-in/out punches, org-scoped.
    "time_entries",
    # Crew job photos (migration 081): before/after shots, bytes in-DB.
    "job_photos",
    # Crew accept/decline (migration 083): assignment responses, org-scoped.
    "job_responses",
    # Crew weekly availability pattern (migration 085), org-scoped.
    "cleaner_availability",
    # Crew training/docs library (migration 086), org-scoped.
    "crew_docs",
    # Week-anchored crew availability (migration 087), org-scoped.
    "cleaner_week_availability",
    # Cleaner↔office message threads (migration 089), org-scoped.
    "crew_messages",
    # Property crew notes + reference photos (migration 090), org-scoped.
    "property_crew_notes",
    "property_photos",
    # Autopilot approval gate (migration 091): AI-proposed actions awaiting a
    # human decision, org-scoped.
    "proposed_actions",
    # MT-3 audit (migration 095): both tables have carried org_id since they
    # were created but were never added here, so they had zero RLS backstop
    # on Postgres. org_id is NOT NULL on user_google_accounts (safe); nullable
    # on push_subscriptions but every write site stamps it (modules/push/
    # router.py) — see 095's docstring for why `users` itself is deliberately
    # NOT in this list yet.
    "user_google_accounts", "push_subscriptions",
    # Marketplace claim requests (migration 097): who asked for which job and
    # at what price. Org-scoped from creation. Added here at the same time as
    # the table rather than in a later audit — 095 exists precisely because two
    # tables carried org_id for months with no RLS backstop behind them.
    "job_claim_requests",
    # The vetting file (migration 098): what a subcontractor has on record.
    # Insurance certificates and signed agreements, org-scoped from creation.
    "sub_documents", "sub_agreements",
    # Subcontractor payouts (migration 099): the ledger of what is owed to
    # whom. Org-scoped from creation.
    "sub_payouts",
    # `users` is DELIBERATELY excluded — re-audited 2026-08-16, still not safe.
    # Re-read this whole comment before adding it; don't re-derive from scratch.
    #
    # 1. The gap is real: POLICY's USING clause above has no `OR org_id IS
    #    NULL` branch. It only tolerates an *unset* `app.current_org_id` GUC
    #    (background jobs / psql), not a NULL row once the GUC IS set. A
    #    NULL-org `users` row matches neither `org_id = <org>` nor
    #    `current_setting(...) IS NULL` and becomes invisible.
    #
    # 2. NULL-org `users` rows are NOT vestigial — they're live and expected.
    #    `users.org_id` is nullable (models.py). Migration 027 (MT-1) never
    #    included `users` in its backfill list; migration 049 added
    #    `users.org_id` + `UPDATE users SET org_id = 1 WHERE org_id IS NULL`,
    #    but ONLY inside an `if "org_id" not in existing_columns` guard — and
    #    049's own docstring says production's `users` table already had
    #    `org_id` (via `Base.metadata.create_all()`, pre-Alembic), so that
    #    ADD COLUMN branch — and the backfill riding inside it — never ran
    #    against production. No migration or script anywhere else runs
    #    `UPDATE users SET org_id = ...`. So there is no evidence any
    #    pre-MT-4 user row was ever backfilled; whether NULL-org rows exist
    #    in production today is unconfirmed, not ruled out — confirming it
    #    needs a real `SELECT count(*) FROM users WHERE org_id IS NULL`
    #    against production, which nobody has run.
    #
    # 3. The app code doesn't treat this as hypothetical: it's coded against
    #    today, present tense. `modules/ai/router.py`'s `_org()` docstring:
    #    "rows from before the multi-tenant migration carry org_id NULL and
    #    belong to the default workspace." And multiple `User` query sites
    #    carry an explicit `or_(User.org_id == oid, User.org_id.is_(None))`
    #    specifically to keep NULL-org cleaner accounts visible:
    #    modules/crew/router.py (office_crew_threads, crew message send,
    #    crew_roster, cleaner invite-resend), modules/payroll/router.py
    #    (three cleaner-name lookup sites, each commented "cleaner_id is
    #    intentionally non-unique and `users` isn't an RLS tenant table"),
    #    modules/dispatch/router.py (employee roster). Turning RLS on for
    #    `users` with the current USING clause would silently defeat every
    #    one of those app-level filters — NULL-org cleaners would vanish from
    #    rosters, payroll name lookups, dispatch's assignable-employee list,
    #    and crew messaging. That's a live regression, not a theoretical one.
    #
    # 4. Separately risky: several `db.query(User).filter(User.id ==
    #    current_user.id)` self-lookups (modules/crew/router.py `/me`, the
    #    profile-update endpoint, calendar-token reset) re-fetch the caller's
    #    own row inside a request whose RLS GUC may already be pinned to a
    #    *different* value than the caller's real org_id: `current_org_id()`
    #    (modules/auth/router.py) does
    #    `oid = getattr(current_user, "org_id", None) or _default_org_id(db)`
    #    — a NULL-org caller's GUC gets set to the default org, not left
    #    unset. If RLS were on, that caller's own self-lookup would 404.
    #
    # Decision (2026-08-16, branch claude/app-layout-redesign-8vvynd):
    # deferred. Do NOT add RLS for `users` until, in order:
    #   a. Someone runs `SELECT id, email, role FROM users WHERE org_id IS
    #      NULL` against production and the result is used to decide real
    #      ownership per row (business decision — most likely org 1 for
    #      anything that predates MT-4 self-signup).
    #   b. A dedicated backfill migration sets those rows' org_id for real
    #      (mirroring 027/049's `UPDATE ... SET org_id = 1` shape, but as its
    #      own migration, not hidden inside a conditional ADD COLUMN).
    #   c. Every `or_(User.org_id == oid, User.org_id.is_(None))` / `_org()`
    #      site listed in point 3 is revisited — once backfilled, the NULL
    #      branch is dead weight and should come out for clarity (not
    #      required for correctness, but leaving it silently stale invites
    #      the next person to assume NULL rows are still possible).
    #   d. The self-lookup sites in point 4 are re-checked — safe once no
    #      user can have org_id NULL (current_org_id's fallback then only
    #      ever fires for the synthetic master-API-key admin, which has no
    #      `users` row to look up anyway).
    #   e. Only then: a migration mirroring 095's pattern
    #      (`apply_org_rls(op.get_bind(), tables=["users"])` in `upgrade()`,
    #      `drop_org_rls(...)` in `downgrade()`), and `users` added here.
    # Until then this is the status quo from before this audit: `users` has
    # zero RLS backstop on Postgres, and the app-level NULL-tolerant filters
    # above are the only enforcement.
]

POLICY = "bb_org_isolation"
USING = (
    "org_id = current_setting('app.current_org_id', true)::int "
    "OR current_setting('app.current_org_id', true) IS NULL"
)


def apply_org_rls(bind, tables=None):
    """Enable + FORCE RLS and (re)create the org-isolation policy on each tenant
    table that exists. Idempotent. No-op off Postgres."""
    if bind.dialect.name != "postgresql":
        return
    existing = set(sa.inspect(bind).get_table_names())
    for table in (tables or TENANT_TABLES):
        if table not in existing:
            continue
        bind.exec_driver_sql(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        bind.exec_driver_sql(f'ALTER TABLE "{table}" FORCE ROW LEVEL SECURITY')
        bind.exec_driver_sql(f'DROP POLICY IF EXISTS {POLICY} ON "{table}"')
        bind.exec_driver_sql(
            f'CREATE POLICY {POLICY} ON "{table}" USING ({USING}) WITH CHECK ({USING})'
        )


def drop_org_rls(bind, tables=None):
    """Reverse apply_org_rls. Idempotent. No-op off Postgres."""
    if bind.dialect.name != "postgresql":
        return
    existing = set(sa.inspect(bind).get_table_names())
    for table in (tables or TENANT_TABLES):
        if table not in existing:
            continue
        bind.exec_driver_sql(f'DROP POLICY IF EXISTS {POLICY} ON "{table}"')
        bind.exec_driver_sql(f'ALTER TABLE "{table}" NO FORCE ROW LEVEL SECURITY')
        bind.exec_driver_sql(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY')
