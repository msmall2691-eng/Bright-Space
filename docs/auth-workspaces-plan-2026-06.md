# Auth & Workspaces plan — sign-in and Google integration like Twenty CRM

Status: PROPOSAL (June 11, 2026) — schema + migration plan for review before any code.
Hard constraint: `office@mainecleaningco.com` (password login, role=admin) must keep
working at every step.

## 1. Where we are today

- **Default-deny signup.** `modules/auth/router.py` gates both password signup
  (`SIGNUP_ALLOWED_EMAILS`) and Google sign-in (`GOOGLE_ALLOWED_EMAILS` /
  `GOOGLE_ALLOWED_DOMAINS`). Anyone not on the list gets a 403.
- **Allow-listed Google accounts are auto-provisioned AS ADMINS**
  (`_resolve_google_user`: `role="admin"`). One typo in a domain allowlist away
  from handing a stranger the whole business.
- **One shared Google credential.** The login consent also captures a calendar
  token stored in a single `AppSetting` row (`google_token`), with
  `GOOGLE_TOKEN_B64` as the legacy/server fallback. Gmail goes through one
  shared IMAP/SMTP App Password (`SMTP_USER`/`SMTP_PASS`). Whoever signs in as
  "the business account" owns sync for everyone.
- **No tenancy.** Every table is implicitly Maine Cleaning Co.
- Roles in active use: `admin`, `manager`, `viewer`, `cleaner` (126 endpoints
  gate on admin|manager). `UserRole` enum also defines `client`.

## 2. Target model (Twenty-inspired, sized for BrightBase)

Twenty's shape: a **Workspace** owns all data; **WorkspaceMembers** belong to it
with roles; each member can attach **ConnectedAccounts** (their own Google
OAuth grant), and each connected account feeds **MessageChannels** (Gmail) and
**CalendarChannels** (GCal) that sync into workspace data. We mirror that with
four pieces:

1. `orgs` — the workspace. v1 is single-org (id=1, "Maine Cleaning Co") but
   every new row/FK is written as if multi-org, so a second company later is a
   data backfill, not a redesign.
2. `users` — gains `org_id`, `status` (`active | pending | disabled`) and keeps
   the existing `role` values. **Role and approval are separate axes**: a new
   Google signup is `role=member, status=pending` — visible to admins, no data
   access — until approved.
3. `user_google_accounts` — per-user OAuth grant (tokens, scopes, sync
   cursors). The shared `google_token` AppSetting and `GOOGLE_TOKEN_B64`
   become a legacy fallback owned by the bootstrap admin, then retire.
4. `roles`: add `member` (default for approved signups; read/write on their
   own work, no settings/users/billing). Existing `admin|manager|viewer|cleaner`
   semantics unchanged so no `require_role` call site changes in phase A.

## 3. Schema changes (DDL sketch)

```sql
CREATE TABLE orgs (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    slug        VARCHAR(64) UNIQUE NOT NULL,        -- 'maine-cleaning-co'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN org_id  INTEGER REFERENCES orgs(id);   -- backfill -> 1, then NOT NULL
ALTER TABLE users ADD COLUMN status  VARCHAR(16) NOT NULL DEFAULT 'active';
                                     -- 'active' | 'pending' | 'disabled'
ALTER TABLE users ADD COLUMN approved_by INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN approved_at TIMESTAMPTZ;

CREATE TABLE user_google_accounts (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id         INTEGER NOT NULL REFERENCES orgs(id),
    google_sub     VARCHAR(64) NOT NULL,            -- stable Google identity
    email          VARCHAR(255) NOT NULL,
    -- Fernet-encrypted (key from new env TOKEN_ENCRYPTION_KEY); never plaintext
    access_token   TEXT,
    refresh_token  TEXT,
    token_expiry   TIMESTAMPTZ,
    scopes         JSON NOT NULL DEFAULT '[]',      -- granted, not requested
    status         VARCHAR(16) NOT NULL DEFAULT 'connected',
                                     -- 'connected' | 'expired' | 'revoked'
    -- per-channel sync cursors (Twenty's message/calendar channel state)
    gmail_sync_enabled    BOOLEAN NOT NULL DEFAULT false,
    gmail_history_id      VARCHAR(32),              -- incremental Gmail API cursor
    gcal_sync_enabled     BOOLEAN NOT NULL DEFAULT false,
    gcal_calendar_id      VARCHAR(255),             -- which calendar to sync
    gcal_sync_token       TEXT,                     -- incremental events cursor
    last_sync_at          TIMESTAMPTZ,
    last_sync_error       TEXT,
    connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id),                               -- one Google account per user (v1)
    UNIQUE (org_id, google_sub)                     -- an account can't join twice
);
```

Provenance columns so synced data is attributable and unsync-able per user:
`conversations.synced_by_google_account_id`, `messages.synced_by_google_account_id`,
`jobs.gcal_account_id` (all nullable FKs; existing rows stay NULL = legacy shared
account). `org_id` on domain tables (clients, jobs, quotes, …) is **deferred to
the multi-org phase** — single-org v1 doesn't need row-level tenancy yet, and
adding 20+ FK columns now multiplies migration risk for zero current benefit.
The design cost is paid where it matters: every NEW table carries `org_id` from
day one.

## 4. Behavior changes

### Signup / sign-in
- Google sign-in: **anyone with a verified Google account can sign up.** New
  users get `role=member, status=pending`, bound to org 1. They see a single
  "waiting for approval" screen — no API access (`get_current_user` rejects
  `status != 'active'` with 403 `pending_approval`).
- `SIGNUP_ALLOWED_EMAILS` / `GOOGLE_ALLOWED_DOMAINS` stop being a wall and
  become an **auto-approve list**: matching signups skip pending and become
  `status=active` (still `role=member` — never auto-admin).
- Password login path untouched. `office@mainecleaningco.com` keeps
  `role=admin, status=active` via the status backfill.
- JWT payload gains `org_id` + `status`; existing tokens (no status claim)
  are treated as `active` until expiry so nobody is logged out by the deploy.

### Per-user Google connect (separate from login)
- Login consent goes back to **identity-only scopes** (openid/email/profile).
  Today's login consent silently captures a calendar token and may overwrite
  the shared one — that path is removed.
- New explicit flow: Settings → "Connect Google account" requests
  `gmail.readonly` + `gmail.send` + `calendar` with `access_type=offline`,
  stores tokens on `user_google_accounts`, shows granted scopes + a
  Disconnect button (which revokes at Google and wipes tokens).

### Per-user sync (the Twenty part)
- Scheduler ticks iterate `user_google_accounts` with `*_sync_enabled` instead
  of the single shared credential:
  - **Gmail → comms**: reuse `_thread_inbound_email`/`find_or_create_conversation`
    (hardened in this branch); switch transport from shared IMAP to Gmail API
    with `gmail_history_id` incremental sync; stamp `synced_by_google_account_id`.
  - **GCal → scheduling**: the existing `sync_gcal_tick` logic parameterized by
    account, using `gcal_sync_token` incremental sync; job events stamp
    `gcal_account_id`.
- Outbound (quote/invoice email, replies): sent via the acting user's connected
  Gmail when present; falls back to the shared SMTP creds (unified in this
  branch) so nothing breaks while accounts are being connected.
- The legacy shared token keeps working throughout as a virtual "business
  account" attributed to the bootstrap admin; it's retired only after the
  owner connects their real account.

### Admin UI (Settings → Users)
- List users: name, email, role, status, last login, Google connected?
- Approve / deny pending signups (deny = `status=disabled` + optional note).
- Change role (admin/manager/member/viewer/cleaner); deactivate user.
- Guards: can't demote or deactivate the last active admin; role changes are
  admin-only endpoints (`require_role("admin")`), logged to activities.

## 5. Migration plan (each step deploy-safe and reversible)

The Alembic chain is broken/stamped at 022, so schema changes ship as
idempotent boot migrations in `db.py::_run_migrations` + model updates (the
extended `reconcile_prod_schema.py --dry-run` verifies prod matches models
after each deploy).

- **M0 (pure additive, no behavior change):** create `orgs`; seed org 1; add
  `users.org_id/status/approved_*` with defaults (`active`); create
  `user_google_accounts`; add provenance columns. Backfill: all existing users
  → org 1, `status='active'`. Verify office@ login. Rollback = nothing reads
  the new columns yet.
- **A (roles & approval):** signup/google-signin write `member/pending`;
  allowlists become auto-approve; `get_current_user` enforces `status`;
  admin Users UI + approve/deny/role endpoints. Tests: office@ password login,
  pending user blocked, approval unblocks, last-admin guard.
- **B (per-user connect):** OAuth connect flow + encrypted token storage +
  disconnect/revoke. Login consent drops calendar scope. Shared token still
  drives sync.
- **C (per-user sync):** Gmail/GCal ticks keyed by `user_google_accounts`;
  legacy shared token wrapped as the bootstrap admin's virtual account;
  per-account error states surface in Settings (incl. the 503-style "credentials
  expired" treatment Connecteam got in this branch).
- **D (retire legacy):** after the owner's real account is connected and
  syncing, remove `GOOGLE_TOKEN_B64`/`google_token` reads; keep refusing-to-boot
  out of scope (warn only).
- **Multi-org (future, designed-for):** add `org_id` to domain tables NULL →
  backfill 1 → NOT NULL; scope queries via a `current_org` dependency; org
  switcher UI. Explicitly out of v1.

## 6. Open questions (answer before phase A is built)

1. **Default role for approved signups:** `member` (proposed: can work jobs/
   quotes, no settings/users) — or reuse `viewer` and skip the new role?
2. **Should pending users see ANYTHING?** Proposal: only the "waiting" screen.
3. **Gmail transport switch (IMAP → Gmail API)** is implied by per-user OAuth.
   OK to keep shared-IMAP fallback for the business inbox indefinitely?
4. **Token encryption key handling:** new `TOKEN_ENCRYPTION_KEY` env in Railway
   (generated once); losing it = users must reconnect Google. Acceptable?
5. Customer-facing logins (`role=client`) are untouched by all phases — confirm.
