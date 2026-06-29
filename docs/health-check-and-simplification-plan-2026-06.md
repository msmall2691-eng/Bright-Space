# BrightBase — Setup Health Check & Simplification Plan

Prepared for Meg · June 29, 2026
Repo: `msmall2691-eng/Bright-Space` · Live: `brightbase-production.up.railway.app`

This is a plan, not a set of changes — nothing in the code has been touched. It has three parts: (A) does the setup work, (B) how to simplify the backend schema, (C) how to simplify the frontend. Each simplification has a before→after, a risk level, and an effort estimate so you can pick what to do first.

---

## A. Does the setup work? — Yes, with two caveats

**The live app is healthy.** Logged in as The Maine Cleaning Co., the dashboard, Clients, Schedule, and Billing pages all load, the API calls return `200`, and there are no JavaScript console errors. Real data is flowing (jobs, pipeline, quotes, comms, money).

**Infrastructure hygiene is good.** A few things are done right that are worth keeping:

- `DATABASE_URL` is required at startup — the app refuses to silently fall back to a throwaway SQLite file (a past incident, per the code comment).
- CI runs the backend test suite, a real Postgres row-level-security test, and a production frontend build on every push.
- Multi-stage Docker build (frontend compiled, then served by the Python backend), with a `/api/health` healthcheck wired into Railway.

### Two caveats

**1. One integration is down (not a code bug).** `GET /api/dispatch/employees` returns `503` and the dashboard shows "Crew roster unavailable (Connecteam offline) — cleaners shown by ID." The app degrades gracefully rather than crashing, which is correct. Action: confirm the Connecteam credentials/token in Railway env vars are still valid; this is a connection issue, not a BrightBase defect.

**2. Config smells worth tidying (low risk).**

- **Database bootstrap runs twice.** `railway.json` runs `python scripts/db_bootstrap.py` as a `preDeployCommand`, and the `Dockerfile` `CMD` also runs it before uvicorn. Pick one place. (Railway uses the `railway.json` `startCommand`, so the Dockerfile's bootstrap is the redundant one.)
- **Two schema-management systems coexist.** There are 33 Alembic migrations *and* a `db_bootstrap.py` *and* a `reconcile_prod_schema.py`. When `create_all()`-style bootstrapping and migrations both run, prod schema can drift from what the migrations describe. Decide that Alembic is the single source of truth and reduce bootstrap to "run migrations."
- **Two frontend API clients.** A hand-written `src/api.js` coexists with an auto-generated typed layer (`src/api/types.ts` + `helpers.ts`). Fine short-term, but it means two patterns for new code to copy.

---

## B. Backend schema — where the sprawl is

The backend defines ~30 tables across two model files. It's a capable CRM, but several concepts are modeled two or three different ways at once. Below, ordered by value-for-effort.

### B1. Delete the dead `property_intelligence` module — do this first (zero risk)

`backend/database/models_property_intelligence.py` defines three tables — `PropertyProfile`, `PropertyPhoto`, `TimeEstimateHistory` — plus a `properties_intelligence` router and a `PropertyProfileForm.tsx` on the frontend. This whole feature is **orphaned and non-functional**:

- It is **not imported anywhere** — not in `main.py`, not in `database/__init__.py`, and no other Python file references the model file.
- It uses **UUID primary keys** and declares foreign keys to `clients.id` and `jobs.id` — but those tables use **Integer** keys. The FKs could never bind.
- It references a **`crews` table that does not exist** anywhere in the schema.
- `PropertyProfileForm.tsx` is imported by **no** frontend file.

**Action:** delete the model file, the `properties_intelligence` module, and `PropertyProfileForm.tsx`. **Risk: none** (it's already not running). **Effort: ~1 hour.** This removes ~270 model lines plus a router and a component, and ends the confusion of a second, incompatible "property" model sitting next to the real one.

### B2. Collapse `Job` vs `Visit` — the biggest win (high value, high effort)

This is the central source of complexity. Both tables store the **same scheduling fields**: `scheduled_date`, `start_time`, `end_time`, `cleaner_ids`, `status`, `gcal_event_id`, and iCal fields. The `Visit` docstring claims "one job can have many visits," but in practice they are **1:1** — the `/api/health` endpoint literally checks `jobs_without_visits == 0` and treats any job without a visit as unhealthy.

The duplication leaks all the way to the UI: the calendar (`CalendarView`, `JobEditModal`) reads/writes `/api/jobs`, while the week view, Today, and Dashboard read `/api/visits`. The same "a cleaning on a date" is fetched two different ways depending on which screen you're on, and both have to be kept in sync.

**Action (phased):** pick one occurrence model. Two viable directions:

- *Keep `Job` as the unit of scheduling*, drop `Visit`, and move the few visit-only fields (`checklist_results`, `photos`, `completed_by`) onto `Job`. Simplest if jobs are always 1:1 with visits.
- *Keep `Visit` as the occurrence and let `Job` become the recurring/"engagement" parent* — only worth it if you genuinely need multi-visit jobs later.

Given current 1:1 usage, the first is simpler. **Risk: high** (touches scheduling, calendar sync, dispatch). **Effort: 1–2 weeks.** Do it after the quick wins, behind tests.

### B3. One way to assign a cleaner (medium)

There are **three** assignment mechanisms today: `Job.cleaner_ids` (JSON list), `Job.assigned_cleaner_user_id` (FK, commented "Future: replace cleaner_ids JSON"), and `Visit.cleaner_ids` (JSON). Settle on one source of truth. This naturally folds into B2. **Risk: medium. Effort: a few days.**

### B4. Consolidate iCal storage (medium)

STR turnover calendars are stored up to four ways: `Property.ical_url` (labeled "Legacy: single iCal, backward compat"), `PropertyIcal` (the real multi-feed table), `ICalEvent` (parsed events linked to a Job), and `Visit.ical_source/ical_uid/ical_synced_at`. **Action:** drop the legacy `Property.ical_url`, and pick *either* `ICalEvent` *or* the `Visit` iCal fields as the parsed-event store — not both. **Risk: medium. Effort: a few days.**

### B5. Merge the two lead-intake tables (medium)

`LeadIntake` (58 references across the backend) and `QuoteRequest` (6 references, only in `quoting` and `booking`) both model "a customer submitted a web form asking for service." They overlap heavily (name/email/phone/service_type/property). **Action:** fold `QuoteRequest` into `LeadIntake` and retire it. **Risk: medium. Effort: 1–2 days.**

### B6. One pipeline state machine (medium)

Lead/deal status lives in three places that must be kept consistent: `Client.status` + `Client.lifecycle_stage`, `LeadIntake.status`, and `Opportunity.stage`. **Action:** make `Opportunity.stage` the source of truth and derive the others (or drop the redundant `Client.lifecycle_stage`). Also restore the `Opportunity.quotes` relationship — it was removed because of an old UUID/Integer mismatch that the comments confirm is **already fixed** (Quote is now Integer-keyed); the removal note is stale. **Risk: medium. Effort: 1–2 days.**

### B7. One delivery-tracking table (low/medium)

Outbound sends are tracked in `QuoteEmail`, `QuoteSMS`, *and* the general-purpose `IntegrationEvent` (which already covers `email`/`sms`/`gcal`/`connecteam` for any entity), with `Message` also recording sends. **Action:** route quote email/SMS delivery through `IntegrationEvent` and retire `QuoteEmail`/`QuoteSMS`. **Risk: low–medium. Effort: 1–2 days.**

### B8. Normalize address (low priority)

A mailing address is copied onto `Client`, `Property`, `RecurringSchedule`, `Job`, and `LeadIntake`. Treat `Property` as canonical and have jobs/schedules reference it (snapshotting only where a historical record is needed). **Risk: low. Effort: ongoing cleanup.**

### B9. Contact storage: scalars vs tables (low priority, decide later)

`Client.email`/`Client.phone` (scalars) coexist with `ContactEmail`/`ContactPhone` (multi-value tables, the "Twenty CRM" enrichment pattern). `ContactPhone` is fairly load-bearing (62 refs, drives phone-tail matching), so don't rush this. Decide whether the tables or the scalars are the source of truth and derive the other. **Risk: medium. Effort: defer until after B2–B6.**

---

## C. Frontend — where the sprawl is

The frontend is ~34,800 lines across 26 page files. Same pattern: real, working, but carrying dead weight and a few oversized files.

### C1. Delete orphaned page files — do this first (near-zero risk)

These page files are **no longer imported as components** anywhere — their routes were already converted to redirects (`/calendar`→`/schedule`, `/today`→`/dashboard`):

| File | Lines | Replaced by |
|---|---|---|
| `pages/Today.jsx` | 215 | `Dashboard.jsx` |
| `pages/Calendar.jsx` | 192 | `Schedule.jsx` |
| `components/PropertyProfileForm.tsx` | — | (dead feature, see B1) |

That's **~400+ lines of dead page code** plus the dead form. The redirects in `App.jsx` stay; only the unreferenced files go. **Risk: very low** (verified: no `import` of either page anywhere). **Effort: ~30 min.**

> **Note — `Quoting.jsx` and `Invoicing.jsx` are NOT dead.** Despite their routes being redirects, `Billing.jsx` imports and renders them as child components (`{view === 'invoices' ? <Invoicing /> : <Quoting />}`). They are the actual content of the consolidated Billing page. Leave them in place. (They're large — 1,491 and 720 lines — so they're candidates for C3 "split mega-pages," not deletion.)

### C2. Merge the two timeline components (low)

`ActivityTimeline.jsx` and `UnifiedTimeline.jsx` both render a contact/job activity stream. `UnifiedTimeline` is used on JobDetail; `ActivityTimeline` on ClientProfile/OpportunityDetail. **Action:** consolidate to one configurable timeline. **Risk: low. Effort: ~1 day.**

### C3. Split the mega-pages (maintainability, do incrementally)

A handful of pages are large enough to be hard to work in safely:

| Page | Lines |
|---|---|
| `ClientProfile.jsx` | 2,233 |
| `Schedule.jsx` | 2,198 |
| `Settings.jsx` | 1,617 |
| `Quoting.jsx` | 1,491 |
| `Comms.jsx` | 1,333 |

Break these into section components (e.g., Settings → one component per tab; Billing's `Quoting`/`Invoicing` children into smaller pieces). **Risk: low if done section-by-section. Effort: ongoing.**

### C4. Unify the scheduling data path (couples to B2)

Mirror of the backend Job/Visit split: components fetch `/api/jobs` (CalendarView, JobEditModal) *or* `/api/visits` (WeekView, Today, Dashboard, PropertyDetail) for the same scheduling data. Unify once B2 lands so every scheduling screen reads one endpoint. **Risk: medium. Effort: tracks with B2.**

### C5. Pick one API client + one language (low)

Standardize on the generated typed layer (`src/api/types.ts` + `helpers.ts`) and migrate calls off the hand-written `api.js` over time; decide whether the 3 stray `.ts`/`.tsx` files become "we're going TypeScript" or get converted back to match the JSX majority. Also: `/api/comms/conversations/summary` is fetched 3× per navigation — cache or dedupe it. **Risk: low. Effort: incremental.**

---

## D. Recommended sequence

Grouped so the safe, high-clarity wins come first and the risky structural change comes after the codebase is already lighter.

**Phase 0 — Quick wins, do now (≈1 day, near-zero risk)**
- B1: delete dead `property_intelligence` (models + module + `.tsx`)
- C1: delete 2 orphaned page files (`Today.jsx`, `Calendar.jsx`) — *not* Quoting/Invoicing (they're live inside Billing)
- A-caveats: remove the duplicate `db_bootstrap` call; confirm Connecteam env var

**Phase 1 — Consolidations, low/medium risk (≈1 week)**
- B5: fold `QuoteRequest` into `LeadIntake`
- B7: route quote email/SMS through `IntegrationEvent`
- B6: single pipeline state + restore `Opportunity.quotes`
- B4: drop legacy `Property.ical_url`, pick one parsed-event store
- C2: merge the two timeline components

**Phase 2 — The big structural simplification (1–2 weeks, high risk, behind tests)**
- B2 + B3 + C4: collapse `Job`/`Visit` to one occurrence model, one cleaner-assignment field, one frontend scheduling endpoint

**Phase 3 — Polish (ongoing)**
- B8/B9: address + contact normalization
- C3/C5: split mega-pages, unify API client, settle TS-vs-JS, decide Alembic-only schema management

### Effort vs. value at a glance

| Item | Value | Risk | Effort |
|---|---|---|---|
| B1 delete property_intelligence | High (clarity) | None | ~1h |
| C1 delete orphaned pages | High (clarity) | Very low | ~1h |
| A duplicate bootstrap / Connecteam | Med | Low | ~1h |
| B5 merge intake tables | Med | Med | 1–2d |
| B7 one delivery table | Med | Low–Med | 1–2d |
| B6 one pipeline state | Med | Med | 1–2d |
| B4 consolidate iCal | Med | Med | ~3d |
| C2 merge timelines | Med | Low | ~1d |
| **B2/B3/C4 Job–Visit unification** | **Very high** | **High** | **1–2wk** |
| B8/B9 address + contacts | Med | Med | defer |
| C3 split mega-pages | Med (maintainability) | Low | ongoing |

---

## Appendix — How these findings were verified

- **Live app:** loaded Dashboard, Clients, Schedule, Billing in-browser; checked network (`200`s except the Connecteam `503`) and console (no errors).
- **Dead code:** confirmed `models_property_intelligence` and `PropertyProfileForm.tsx` have zero inbound imports; confirmed no `crews` table exists; confirmed `Today.jsx` and `Calendar.jsx` have zero `import` statements anywhere. Correction after a second pass: `Quoting.jsx`/`Invoicing.jsx` ARE live — `Billing.jsx` imports and renders them — so they are explicitly excluded from deletion.
- **Job/Visit:** confirmed duplicate scheduling columns in the models, the `/api/health` `jobs_without_visits == 0` check, and the split `/api/jobs` vs `/api/visits` usage across frontend components.
- **Usage weighting:** counted backend references to gauge what's load-bearing (e.g. `Visit` 87, `Opportunity` 69, `ContactPhone` 62, `LeadIntake` 58 vs `QuoteRequest` 6) so nothing load-bearing is recommended for deletion.
