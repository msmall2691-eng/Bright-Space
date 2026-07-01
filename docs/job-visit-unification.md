# Job / Visit Unification — Migration Plan

Author: Meg + Claude · July 1 2026
Repo: `msmall2691-eng/Bright-Space`
Related: `docs/health-check-and-simplification-plan-2026-06.md` (Task B2) and `docs/health-check-implementation-pack-2026-06.md` (Task 2.1)

> **Status: plan, not code.** This document is the audit + design for collapsing the `Visit` table into `Job`. Nothing under `backend/` or `frontend/` changes as part of writing it. The follow-on PRs (§8) are the implementation.

---

## 1. Why we're doing this

`Job` and `Visit` model the same thing — "a scheduled cleaning on a date." They carry **seven duplicate columns** (`scheduled_date`, `start_time`, `end_time`, `cleaner_ids`, `status`, `notes`, `gcal_event_id`), split scheduling truth ("Job.status" vs "Visit.status") across two rows for every occurrence, and force every scheduling screen to pick one endpoint or the other. The result is a self-healing invariant the codebase actively maintains: `jobs_without_visits == 0`.

**The design gap the audit surfaced:** completing a Visit sets `Visit.status='completed'` but never touches `Job.status`. The two go out of sync the moment work is finished. Downstream readers (Dashboard "TODAY" tile, Property overview, GCal push loop) then disagree about whether a cleaning happened.

The pack recommends collapsing `Visit` into `Job`. The audit confirms that's the right direction: cardinality is 1:1 in practice, `Visit.id` is not a foreign-key target from anywhere, and the only fields that don't already exist on `Job` are the four completion columns (`completed_at`, `completed_by`, `checklist_results`, `photos`).

## 2. Cardinality — the actual data

**In the schema:** `visits.job_id` is `NOT NULL, indexed` but **not unique**. Multiple Visits per Job are legal at the DB level.

**In the code:** enforced 1:1.

- `visits_router.py:180` `check_visits_coverage()` treats `Job` without a linked `Visit` as unhealthy.
- Same check duplicated in `main.py:205` and `database/db.py:663` — three copies, all asserting one Visit per Job.
- `POST /api/visits/admin/backfill-visits-from-jobs` skips jobs that already have any Visit (`.first()` check), so it never adds a second one.
- `modules/scheduling/router.py` — job create/update writes exactly one Visit at the same time it writes the Job.
- iCal sync inserts one Visit per turnover.

**In tests:** no fixture creates >1 Visit for a Job; there is a `UniqueConstraint("ical_source", "ical_uid")` that prevents duplicate iCal-sourced Visits from the same feed but no equivalent for Job-sourced ones.

**Conclusion:** the intent, the code, the healthcheck, and the data are all 1:1. Collapse Visit into Job. If a genuine multi-visit-per-job model is ever needed (e.g. a two-day deep clean), the right primitive is a new `JobOccurrence` table modeled *for* that case — not the current Visit which has no explicit ordering, cadence, or parent-schedule fields.

## 3. Column mapping — what moves where

`Job` keeps everything it has (24 columns) plus these four from `Visit`:

| From `visits` | New Job column | Notes |
|---|---|---|
| `completed_at` (DateTime) | `Job.completed_at` (DateTime) | Nullable; set when the cleaner marks done. |
| `completed_by` (Integer FK users) | `Job.completed_by` (Integer FK users) | Nullable; the user who marked it. |
| `checklist_results` (JSON) | `Job.checklist_results` (JSON) | Nullable; `{task_id → done/skipped/failed}`. |
| `photos` (JSON) | `Job.photos` (JSON default=list) | Before/after photos with timestamps. |

**Duplicates (already on Job) — drop from Visit, do not remigrate:** `scheduled_date`, `start_time`, `end_time`, `cleaner_ids`, `status`, `notes`, `gcal_event_id`.

**iCal fields — resolve.** `Visit.ical_source`, `Visit.ical_uid`, `Visit.ical_synced_at` were the parsed-event provenance on Visit. But `ICalEvent.job_id` already binds a reservation to a Job (with `UNIQUE` since migration 004). The Visit iCal fields are a second, redundant store — this is the "one parsed-event store" cleanup deferred from Task 1.4 (B4). **Recommendation:** rely on `ICalEvent` for the parsed-feed record and don't remigrate `ical_source`/`ical_uid`/`ical_synced_at` onto Job. The one thing worth preserving is the idempotency constraint — see §4.

**Unique to Visit but not worth carrying:** none. The audit found nothing else that isn't already covered.

## 4. iCal idempotency — the one non-obvious constraint to preserve

`visits` has `UniqueConstraint("ical_source", "ical_uid", name="uq_visit_ical_source_uid")` which stops a second sync tick from re-creating the same booking as a duplicate Visit.

After this migration, the equivalent guard lives on `ICalEvent`, which already has its own uniqueness (§3). But we need to double-check: `ICalEvent.uid` is unique per property (composite `(property_id, uid)`) so a second sync doesn't duplicate the parsed event → doesn't spawn a second Job. **Action for the implementing PR:** add a targeted test that a second iCal sync tick for the same feed does not create a second Job for the same booking UID. If the invariant doesn't hold today via `ICalEvent`, add a `Job.ical_event_id` UNIQUE (it's already a FK) as part of the migration.

## 5. Backend surface — what changes

### 5.1 Delete outright

- `backend/database/models.py` — `class Visit` (~30 lines) and `Job.visits = relationship(...)`.
- `backend/modules/scheduling/visits_router.py` — the whole file goes; every endpoint has a Job equivalent or moves to a new one (see §5.2).
- The three copies of `check_visits_coverage` (`main.py:205`, `visits_router.py:180`, `db.py:663`) — one is enough after unification; the invariant it enforces is trivially true when there's one table.
- `POST /api/visits/admin/backfill-visits-from-jobs` — its raison d'être is gone.
- `POST /api/visits/telemetry/drift-check` — same.
- `RLS` list in `database/rls.py` — drop `"visits"` from `TENANT_TABLES`.
- `tests/test_tenancy_org_id.py` — drop `m.Visit` from `_DOMAIN_MODELS`.

### 5.2 Move to `/api/jobs`

The following Visit-only endpoints have no Job equivalent. Give them one on the Jobs router with the same shape, then delete the Visit copy.

| Old | New |
|---|---|
| `POST /api/visits/{id}/skip?reason=...` | `POST /api/jobs/{id}/skip?reason=...` — mark `cancelled`, record `RecurrenceException` if the job is on a recurring schedule. |
| `GET /api/visits/{id}/crew-suggestions` | `GET /api/jobs/{id}/crew-suggestions` — top 5 cleaners by frequency on this property. |
| `POST /api/visits/{id}/auto-assign` | `POST /api/jobs/{id}/auto-assign` — apply the top suggestion. |
| `POST /api/visits/{id}/complete` (implicit via PATCH today) | `POST /api/jobs/{id}/complete` — dedicated endpoint that sets `status='completed'`, `completed_at`, `completed_by`, `checklist_results`, `photos` in one call. **This is the fix for the "completion doesn't sync back" gap flagged in the audit.** |

### 5.3 Keep, but repoint

- `modules/schedule/router.py` — the week-view aggregate currently reads `get_visits()` from `visits_router`. Repoint it at `get_jobs()`; response shape is already close (enriched `job`/`client`/`property` nesting exists on both).
- `modules/dashboard/router.py` — the TODAY tile currently reads `/api/visits?scheduled_date_from=&scheduled_date_to=&limit=100`. Change to `/api/jobs?date=...`.
- `modules/reminders/router.py` — any read of `Visit` for SMS/calendar sync uses the same fields as Job; straight substitution.
- `modules/recurring/router.py` — the generator today writes one Job **and** one Visit per occurrence. Drop the Visit write.
- `modules/scheduling/router.py` job create/update — drop the "also write a Visit" step. This is the biggest simplification of the whole change: creating a job is now a single INSERT.

### 5.4 Compatibility shim (temporary)

To avoid a big-bang frontend deploy, add a thin **read-only** shim at `/api/visits` and `/api/visits/{id}` that translates to the Job endpoints under the hood. It stays for exactly one release. Write endpoints go 404 immediately — write callers must migrate before the shim ships (see §7). The shim keeps the existing response shape (`{items, total, limit, offset}` with enriched nesting) so a stale frontend doesn't break during the roll-forward.

## 6. Frontend surface — what changes

Every `/api/visits` call site the audit found:

| File | Call | Replacement |
|---|---|---|
| `components/WeekView.jsx` | `GET /api/visits?scheduled_date_from=&scheduled_date_to=&limit=500` | `GET /api/jobs?date_from=&date_to=&limit=500` |
| `components/WeekView.jsx` | `POST /api/visits/{id}/skip` | `POST /api/jobs/{id}/skip` |
| `components/WeekView.jsx` | `PATCH /api/visits/{id}` (inline status) | `PATCH /api/jobs/{id}` |
| `pages/Schedule.jsx` (7 sites) | `PUT /api/visits/{id}`, backfill/coverage-check calls | `PUT /api/jobs/{id}`; the backfill/coverage UI can be removed (invariant is trivial after collapse). |
| `pages/Dashboard.jsx` | `GET /api/visits?...&limit=100` | `GET /api/jobs?date=...` |
| `pages/PropertyDetail.jsx` | `GET /api/visits?limit=500`, `PATCH /api/visits/{id}` (checklist edits) | `GET /api/jobs?property_id=...&limit=500`, `PATCH /api/jobs/{id}` |
| `api/types.ts` | 9 typed paths under `/api/visits/*` | Regenerate types after backend endpoints are consolidated. |
| `api/README.md` | Reference to `/api/visits` as one of the hot-typed routes | Update to `/api/jobs`. |

Response-shape delta the frontend needs to tolerate: `Visit` responses today include a nested `job: {…}` block; `Job` responses hold those fields directly. Consumers that read `visit.job.client_id` become `job.client_id`, etc. The shape is *simpler*, not different — the migration is search-and-replace with a handful of destructure adjustments.

## 7. Alembic migration — the reversible path

**Revision 038 — `unify_visits_into_jobs`.** One migration, three steps:

1. **Add columns to `jobs`:** `completed_at`, `completed_by` (FK `users.id` ON DELETE SET NULL), `checklist_results` (JSON), `photos` (JSON default `[]`). All nullable.
2. **Backfill:**
   ```sql
   UPDATE jobs
   SET completed_at = v.completed_at,
       completed_by = v.completed_by,
       checklist_results = v.checklist_results,
       photos = v.photos
   FROM (
       SELECT DISTINCT ON (job_id) job_id, completed_at, completed_by,
              checklist_results, photos, id AS visit_id
       FROM visits
       ORDER BY job_id, completed_at DESC NULLS LAST, id DESC
   ) v
   WHERE jobs.id = v.job_id;
   ```
   `DISTINCT ON` picks the newest Visit per Job in the pathological "somehow 2 visits" case. On SQLite (tests) the equivalent needs a subquery + `MAX(id)` join.
3. **Drop RLS then table:** `drop_org_rls(bind, tables=["visits"])`, then `op.drop_table("visits")`.

**Downgrade** recreates the `visits` table matching migration 001 + subsequent alterations (org_id from 027, indexes from 032). Rows are reconstructed from `jobs` where `completed_at IS NOT NULL OR checklist_results IS NOT NULL OR photos IS NOT NULL` (one Visit per such Job). New columns on `jobs` are dropped. This is best-effort — Visits that existed *before* the corresponding Job was completed (i.e., scheduled but not yet worked) won't be recreated on downgrade, because we didn't preserve the pre-completion Visit id. That's acceptable for a schema-consolidation rollback; the invariant "1 Job = 1 Visit" means the new Visit id doesn't matter to any FK (nothing points at `visits.id`).

**Idempotency guards** (`_has_column`, `_has_table`) mirror the pattern from migrations 034–037.

## 8. Sequenced PRs (3, with a fallback 4th)

**PR-A · Backend: add columns + `POST /jobs/{id}/complete` + shim.** Adds `completed_at`, `completed_by`, `checklist_results`, `photos` to `Job` and the four new endpoints under `/api/jobs` (`skip`, `crew-suggestions`, `auto-assign`, `complete`). Keeps `Visit` table and the `/api/visits` write path intact. Adds the read-only shim (see §5.4). No frontend changes yet. **Risk: low.** **Rollback: revert.**

**PR-B · Frontend: migrate all callers off `/api/visits`.** Search-and-replace across the sites listed in §6. Delete the backfill/coverage-check UI in `Schedule.jsx`. Regenerate `api/types.ts`. This PR alone should leave the app fully functional against the read-only shim. **Risk: medium** — the calendar/schedule screens touch every user session, so this is where a manual smoke matters most (§9). **Rollback: revert.**

**PR-C · Backend: delete `Visit`, delete `visits_router`, drop `check_visits_coverage`, run migration 038.** Once B is deployed and the shim is doing nothing for 24 hours, this PR removes the Visit model, the whole `visits_router.py`, the three coverage-check copies, and lands migration 038. Also updates `RLS`, `test_tenancy_org_id.py`, and the recurring generator to write only Jobs. **Risk: high** — this is the one that touches prod schema. **Rollback: 038's `downgrade()`, then revert.**

**PR-D (fallback) · Drop the shim.** If any lingering caller is discovered after PR-B, PR-C keeps the shim; this PR removes it once telemetry shows zero reads for 7 days.

## 9. Test plan

Every PR must keep `pytest -q` green and `npm run build` clean, but the surface each PR needs to *actively* test is different.

### PR-A tests (new)
- `test_job_completion.py` — `POST /jobs/{id}/complete` sets status, timestamp, actor, checklist, and photos in one call; second call is idempotent; unknown id → 404.
- `test_job_skip.py` — same as visit-skip today, but on `/jobs`; recurring skips create a `RecurrenceException`.
- `test_ical_idempotency.py` — a second sync tick for the same feed does not create a second Job for the same booking UID (§4).
- Compat shim: `GET /api/visits?...` returns a payload shape-compatible with the pre-migration frontend for a sample of 3 test cases (single job, week range, filtered by cleaner).

### PR-B tests (updated)
- Every existing Playwright/frontend integration that hit `/api/visits` gets flipped to `/api/jobs`; assertions on nested `visit.job.*` become `job.*`.
- Manual smoke path: Schedule week view, Calendar view, Dashboard TODAY tile, Property detail visit list — every screen renders identically to the pre-PR baseline.

### PR-C tests (regression)
- All existing scheduling tests continue to pass with only Jobs.
- iCal turnover creation test: syncing an Airbnb feed for a property still produces a `str_turnover` Job with the correct date. **This is the highest-value regression check** — the iCal → Job pipeline is the most complex path in the app.
- GCal two-way sync: creating a Job pushes to GCal (already tested via `test_ical_to_gcal.py`); the Job-side `gcal_event_id` still round-trips.
- Migration round-trip: exercise `038` upgrade + downgrade on SQLite the same way 034–037 were exercised.
- Dispatch: `POST /api/dispatch/…` (which reads Job today) continues to work; the Connecteam shift push loop still finds unpushed jobs.

## 10. Estimated cost

| PR | Effort | Risk | Rollback difficulty |
|---|---|---|---|
| A | 2–3 days | Low | Trivial (revert) |
| B | 2–3 days | Medium | Trivial (revert) — shim keeps old contract alive |
| C | 3–5 days | High | Migration downgrade + revert |
| D | 1 day | Low | Trivial |

Total: **1½–2 weeks** for one engineer, matching the pack's original estimate. The bulk of the risk is concentrated in PR-C, which should ship on a Monday morning with someone paying attention.

## 11. Open questions

- **Legacy Visit rows with `completed_at` but a still-live Job on a recurring schedule.** The recurring generator wrote one Visit per Job occurrence. If a Job's Visit is complete but the Job itself is on a schedule that generates future Jobs, the current model treats each future occurrence as its own Job+Visit pair. After collapse this is unchanged — but confirm no code path was reading "completed Visits count" as a proxy for "how many times has this schedule been run." A quick grep for `completed_at.is_not(None)` on Visit will answer this in PR-A.
- **`Visit.cleaner_ids` vs `Job.cleaner_ids`.** They should be identical for every 1:1 pair today. PR-A should include a one-shot check that asserts equality across the corpus before the write-only shim goes in. If they diverge, we have a bigger problem than this refactor.
- **Assignment consolidation (Task B3).** Job today has three cleaner-assignment mechanisms: `Job.cleaner_ids` (JSON), `Job.assigned_cleaner_user_id` (FK), and `Visit.cleaner_ids`. Collapsing `Visit` removes the third; picking one of the first two is a separate follow-up and *not* part of this migration. Do that as a Phase-2 addendum once C is in.
