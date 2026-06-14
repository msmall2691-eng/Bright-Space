# Multi-tenancy + per-user Google: deploy runbook & rollout plan

Status: **in progress.** MT-1 (org_id foundation) shipped (#288). This is the
runbook for the P0 deploy config (your action, not code) and the plan for the
remaining MT phases.

Decision on record: **multi-company SaaS** — each admin who signs up eventually
gets their own isolated CRM.

---

## P0 — deploy config (Railway / Google Cloud) — YOUR action

These gate per-user Google sync and must be set before connecting an account.
None of this is in code; it's environment/cloud setup.

1. **`TOKEN_ENCRYPTION_KEY`** (Fernet) in Railway — or the "Connect Google"
   button errors. Generate:
   ```
   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```
2. **OAuth redirect URI** on the Google Cloud OAuth client:
   `https://brightbase-production.up.railway.app/api/auth/google-account/callback`
   (or set `GOOGLE_CONNECT_REDIRECT_URI`).
3. **Enable the Gmail API** on the Google Cloud project (the calendar-only client
   doesn't have it).
4. **`DATABASE_URL`** points at the Railway **Postgres** plugin (not the SQLite
   default in `.env.example`); enable **automated backups / PITR** on it.
5. **Connect the owner's Google account** (Settings → Connect Google) and verify
   Gmail + Calendar sync run under that account. Until then you're on the legacy
   shared token (`GOOGLE_TOKEN_B64` / `google_token` AppSetting + shared IMAP/SMTP).

### Real-time calendar sync (optional, after a Google account is connected)
- Set `GCAL_WATCH_ENABLED=1` (default off).
- `POST /api/settings/gcal-watch/register` (admin) to register push channels.
- The scheduler renews channels before their ~weekly expiry automatically.
- Incremental polling (`GCAL_INCREMENTAL_SYNC`, default on) already runs without
  any config.

---

## Source-of-truth (already shipped, #285)

`CALENDAR_SOURCE_OF_TRUTH` (Settings row `calendar_source_of_truth` or env),
default **`brightbase`**: Job/Visit is the system of record for the work; a
reschedule made directly in Google is surfaced as drift, not applied. Only a
Google cancellation propagates back. Set to `google` for legacy two-way pull.

---

## Multi-tenancy phases

- **MT-1 — org_id foundation ✅ (#288).** `org_id` on all 21 domain tables,
  nullable, backfilled to org 1, indexed. No behavior change.
- **MT-2 — query scoping (next, higher risk).** An `org_scope` dependency that
  injects `current_user.org_id`, filters every read, and stamps every insert.
  Rolled out module by module behind tests. *Validate the foundation + P0 first.*
- **MT-3 — enforcement.** `org_id` → `NOT NULL` after backfill, plus **Postgres
  Row-Level Security** policies as a backstop so a missed filter can't leak
  across tenants. (RLS is Postgres-only; tests run on SQLite, so RLS is verified
  on a Railway preview DB.)
- **MT-4 — signup creates an org.** A new admin signup creates a fresh `orgs`
  row and becomes that org's admin, instead of joining org 1.

### MT-2 rollout guidance
- Build the dependency + a `scoped(query, model, user)` helper once; prove it on
  **one module (clients)** with tests for (a) isolation across orgs and (b) no
  regression for the single existing org.
- Then fan out: clients → properties → jobs/visits → quotes/invoices → intakes →
  conversations/messages → activities → opportunities → recurring.
- Do it on a Railway **preview DB** with two seeded orgs before prod.
- MT-3's RLS is the safety net for any query MT-2 misses — land it soon after.

---

## Already-shipped data-model hygiene (Audit #5 P3)

- **Audit fields** `created_by`/`updated_by`/`updated_at` — #281.
- **Canonical contacts** (`contact_emails`/`contact_phones` as the dedup source;
  fixed the duplicate-"Megan" clients) — #282.
- **Calendar incremental + real-time cursors** (`gcal_sync_token`,
  `events.watch`) — #286, #287.
- Schema-drift: revision-based `check_schema_drift` runs as a startup check +
  test; a stricter column-parity gate remains a future hardening.
