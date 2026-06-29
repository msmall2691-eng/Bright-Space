# BrightBase — Claude Code Implementation Pack

Companion to `health-check-and-simplification-plan-2026-06.md`. Copy-paste prompts for Claude Code, ordered safest-first. Each task is self-contained: goal, exact files, steps, acceptance criteria, and verification. Do them one at a time, commit after each, and confirm CI/tests pass before moving on.

Repo: `msmall2691-eng/Bright-Space` · backend = FastAPI/SQLAlchemy (`backend/`), frontend = React/Vite (`frontend/`).

Before you start (one time):

```
git checkout -b cleanup/phase-0
cd backend && pip install -r requirements.txt -r requirements-dev.txt
cd ../frontend && npm ci
```

Baseline check (should pass before any change):

```
cd backend && python -m pytest -q
cd ../frontend && npm run build
```

---

## PHASE 0 — Safe deletions & config (do now, ~1 hour total)

### Task 0.1 — Delete the dead `property_intelligence` feature

```
In the Bright-Space repo, remove the orphaned "property intelligence" feature. It is dead code: it is not imported anywhere, its models use UUID primary keys and foreign-key to clients.id/jobs.id (which are Integer) and to a "crews" table that does not exist.

First VERIFY it is unused, then delete:
1. Run: grep -rn "models_property_intelligence\|properties_intelligence\|PropertyProfile\|PropertyPhoto\|TimeEstimateHistory" backend --include=*.py | grep -v "modules/properties_intelligence/" | grep -v "database/models_property_intelligence.py"
   - Expect: no results in main.py, database/__init__.py, or database/base.py. If anything other than the files being deleted shows up, STOP and report it.
2. Run: grep -rn "PropertyProfileForm" frontend/src
   - Expect: no results. If found, STOP.
3. Delete these files:
   - backend/database/models_property_intelligence.py
   - backend/modules/properties_intelligence/  (whole directory)
   - frontend/src/components/PropertyProfileForm.tsx
4. Search for any leftover references to the deleted symbols and remove dead imports if any surface.

Acceptance criteria:
- grep for the deleted symbols returns nothing outside of (now-removed) files.
- backend: `python -m pytest -q` passes.
- frontend: `npm run build` succeeds.
Do NOT touch the real Property model in backend/database/models.py or the properties module.

Commit message: "chore: remove dead property_intelligence feature (unused, incompatible UUID/crews schema)"
```

### Task 0.2 — Delete the two orphaned page files (Today, Calendar)

```
In Bright-Space frontend, two page files are orphaned: their routes in App.jsx are redirects and nothing imports the page components. Remove them, but KEEP the redirect routes.

IMPORTANT — do not delete Quoting.jsx or Invoicing.jsx. Those are still rendered as child components inside pages/Billing.jsx ("import Quoting from './Quoting'"). Only Today.jsx and Calendar.jsx are dead.

Steps:
1. VERIFY no imports:
   grep -rn "from '.*/Today'\|from './Today'\|pages/Today" frontend/src --include=*.jsx --include=*.tsx
   grep -rn "from '.*/Calendar'\|from './Calendar'\|pages/Calendar" frontend/src --include=*.jsx --include=*.tsx
   - Both should return nothing (note: components/CalendarView.jsx is a DIFFERENT file — do not touch it).
   - If either page is imported anywhere, STOP and report.
2. Delete:
   - frontend/src/pages/Today.jsx
   - frontend/src/pages/Calendar.jsx
3. Leave App.jsx routes "/today" -> /dashboard and "/calendar" -> /schedule exactly as they are (they're <Navigate> redirects, no import needed).

Acceptance criteria:
- npm run build succeeds.
- App.jsx still has the /today and /calendar redirect routes.

Commit message: "chore: delete orphaned Today and Calendar pages (routes already redirect)"
```

### Task 0.3 — Remove the duplicate database bootstrap

```
The DB bootstrap runs twice on deploy: railway.json has preDeployCommand "python scripts/db_bootstrap.py", and the Dockerfile CMD also runs it before uvicorn. Keep the Railway preDeployCommand as the single place; make the Dockerfile CMD start uvicorn only.

Edit the Dockerfile CMD (currently):
  CMD ["sh", "-c", "python scripts/db_bootstrap.py && uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
to:
  CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]

Do not change railway.json. Verify the Dockerfile still builds: `docker build -t brightbase-test .` (if Docker is available; otherwise just confirm the file edit).

Acceptance criteria:
- Dockerfile CMD no longer calls db_bootstrap.py.
- railway.json preDeployCommand is unchanged.

Commit message: "chore: run db_bootstrap once (Railway preDeploy), not also in Dockerfile CMD"
```

### Task 0.4 (optimization) — De-duplicate the comms summary fetch

```
The endpoint GET /api/comms/conversations/summary is requested 3+ times on a single navigation (observed in production network logs). Reduce redundant fetches.

Investigate frontend/src first:
  grep -rn "conversations/summary" frontend/src
Likely callers: a header/badge unread count (hooks/useUnreadCount.js), the Comms page, and the dashboard.

Implement ONE of these (prefer the smallest change that works in this codebase):
- Add a short client-side cache / in-flight de-dupe so concurrent identical GETs share one request (e.g., a module-level promise cache in api.js with a few-seconds TTL), OR
- Hoist the summary into a single shared source (the existing useUnreadCount hook / a context) and have consumers read from it instead of each calling the endpoint.

Acceptance criteria:
- On a fresh dashboard load, /api/comms/conversations/summary fires at most once (verify in browser devtools Network tab).
- Unread badge, Comms, and dashboard still show correct counts.
- npm run build succeeds; existing tests pass.

Commit message: "perf: de-duplicate /api/comms/conversations/summary fetches"
```

After Phase 0: push the branch, open a PR, let CI run (backend tests + Postgres RLS + frontend build), and merge. Then branch again for Phase 1.

---

## PHASE 1 — Consolidations (low/medium risk, ~1 week)

Do each as its own branch + PR. Each must keep `python -m pytest` and `npm run build` green, and add/adjust tests for the behavior it changes. Write an Alembic migration for every schema change — do not rely on bootstrap/create_all.

### Task 1.1 — Fold `QuoteRequest` into `LeadIntake`

```
backend/database/models.py defines both LeadIntake (the primary web-intake table, ~58 refs) and QuoteRequest (~6 refs, used only in modules/quoting/router.py and modules/booking/router.py). They model the same thing: a customer web form requesting service. Consolidate onto LeadIntake and retire QuoteRequest.

Plan:
1. Map every QuoteRequest field to a LeadIntake field (add columns to LeadIntake only if a field has no equivalent). LeadIntake already has name/email/phone/address/service_type/etc.; QuoteRequest adds requester_* names, description, preferred_date/time, and a quote_id link.
2. Update modules/quoting/router.py and modules/booking/router.py to read/write LeadIntake instead of QuoteRequest.
3. Write an Alembic migration that: (a) adds any new LeadIntake columns, (b) copies existing quote_requests rows into lead_intakes, (c) drops the quote_requests table.
4. Remove the QuoteRequest model + QuoteRequestStatus enum.
5. Add/adjust tests covering the booking and quote-request intake flows.

Acceptance: pytest green; new migration applies cleanly up and down; no remaining references to QuoteRequest.
Commit: "refactor: merge QuoteRequest into LeadIntake; drop quote_requests table"
```

### Task 1.2 — Route quote email/SMS delivery through `IntegrationEvent`

```
Quote send tracking is split across QuoteEmail, QuoteSMS, and the general IntegrationEvent table (which already supports provider in {gcal,email,sms,connecteam} and entity_type in {job,visit,quote,invoice}). Consolidate quote deliveries into IntegrationEvent.

Plan:
1. In the quote email service (backend/services/quote_email_service.py) and the SMS path, write delivery records to IntegrationEvent (entity_type="quote", provider="email"/"sms", action="send", status, external_id, error_message).
2. Replace reads of QuoteEmail/QuoteSMS in modules/quoting with IntegrationEvent queries filtered by entity_type="quote".
3. Alembic migration: backfill existing quote_emails/quote_sms rows into integration_events, then drop quote_emails and quote_sms.
4. Remove QuoteEmail/QuoteSMS models + their status enums; update Quote relationships (emails, sms_messages) accordingly.
5. Update tests (test_public_quote_flow.py and any quote send tests).

Acceptance: pytest green; quote detail still shows send/delivery history sourced from IntegrationEvent; migration reversible.
Commit: "refactor: track quote email/SMS via IntegrationEvent; drop quote_emails/quote_sms"
```

### Task 1.3 — Single pipeline state + restore `Opportunity.quotes`

```
Lead/deal status is duplicated across Client.status + Client.lifecycle_stage, LeadIntake.status, and Opportunity.stage. Make Opportunity.stage the source of truth and remove the redundant Client.lifecycle_stage (keep Client.status as lead/active/inactive only if it drives existing queries — verify with grep first).

Also: the Opportunity model has a removed `quotes` relationship with a stale comment claiming Quote uses UUID FKs. Quote is now Integer-keyed (see Quote docstring), so restore the relationship:
  quotes = relationship("Quote", back_populates="opportunity", foreign_keys="Quote.opportunity_id")
and add the matching back_populates on Quote.opportunity. Verify the mapper initializes (run pytest; a bad relationship fails at import).

Plan:
1. grep -rn "lifecycle_stage" backend frontend to find all readers/writers; migrate them to derive from Opportunity.stage.
2. Alembic migration to drop clients.lifecycle_stage (after code no longer reads it).
3. Restore Opportunity.quotes <-> Quote.opportunity relationship; remove the stale comment.
4. Tests: pipeline stage transitions; opportunity -> quotes navigation.

Acceptance: pytest green; app boots (mapper init OK); dashboard funnel still correct.
Commit: "refactor: single pipeline state on Opportunity.stage; restore Opportunity<->Quote relationship"
```

### Task 1.4 — Drop legacy `Property.ical_url`; one parsed-event store

```
iCal data lives in 4 places: Property.ical_url (legacy single feed), PropertyIcal (real multi-feed), ICalEvent (parsed events linked to Job), and Visit.ical_* fields.
Step A (this task): remove the legacy single feed.
1. grep -rn "ical_url" backend frontend — confirm PropertyIcal covers all real usage; migrate any code still reading Property.ical_url to PropertyIcal.
2. Alembic migration to drop properties.ical_url (and ical_last_synced_at if it's only for the legacy single feed — verify).
3. Tests: ical sync (test_ical_auto_sync.py) still pass.
Defer the ICalEvent-vs-Visit dedupe to Phase 2 (it couples to Job/Visit).

Acceptance: pytest green; iCal feeds still sync via PropertyIcal.
Commit: "refactor: drop legacy Property.ical_url in favor of PropertyIcal"
```

### Task 1.5 — Merge the two timeline components (frontend)

```
frontend/src/components has ActivityTimeline.jsx (used by ClientProfile, OpportunityDetail) and UnifiedTimeline.jsx (used by JobDetail). They render the same kind of activity stream. Consolidate to one configurable <Timeline> component with props for the data source, and update the three consumers. Delete the redundant file.

Acceptance: npm run build + existing component tests pass; all three screens render their timelines unchanged.
Commit: "refactor: unify ActivityTimeline and UnifiedTimeline into one component"
```

---

## PHASE 2 — The big one: collapse Job/Visit (high risk, 1–2 weeks, behind tests)

Treat this as a project, not a single prompt. Land it behind a feature branch with thorough tests. Use the prompt below to plan first, then implement in small PRs.

### Task 2.1 — Plan the Job/Visit unification (planning prompt — produce a design doc, no code yet)

```
In Bright-Space, Job and Visit duplicate scheduling fields (scheduled_date, start_time, end_time, cleaner_ids, status, gcal_event_id, ical_*). In practice they are 1:1 — the /api/health endpoint enforces jobs_without_visits == 0. The frontend reads /api/jobs (CalendarView, JobEditModal) AND /api/visits (WeekView, Today, Dashboard, PropertyDetail) for the same data.

Produce a written migration plan (no code changes yet) that:
1. Confirms the true cardinality: search the codebase for any place that creates >1 Visit per Job. Report findings. If strictly 1:1, recommend collapsing Visit into Job.
2. Lists every backend reader/writer of Visit (modules/scheduling/visits_router.py and others) and every frontend caller of /api/visits.
3. Proposes the target model: keep Job as the scheduling unit; move visit-only fields (checklist_results, photos, completed_at/completed_by) onto Job; keep /api/jobs and make /api/visits a thin compatibility shim (or migrate callers).
4. Specifies the Alembic migration (copy visit data onto jobs, then drop visits) with a reversible path.
5. Specifies a test plan: scheduling, calendar two-way sync, dispatch, iCal turnover creation, "Complete Visit" flow.
6. Sequences the work into 3-4 small PRs.

Output the plan as docs/job-visit-unification.md. Do not modify models or routers in this task.
```

### Task 2.2 — One cleaner-assignment field (do during 2.x)

```
There are three assignment mechanisms: Job.cleaner_ids (JSON), Job.assigned_cleaner_user_id (FK), Visit.cleaner_ids (JSON). As part of the Job/Visit unification, pick ONE source of truth. Recommended: a single assignment representation on Job. Migrate data, update the scheduling guard (which checks CleanerTimeOff against cleaner ids), dispatch, and the frontend assignment UI. Add tests for assign/unassign and time-off conflicts.
```

### Task 2.3 — Unify the frontend scheduling data path

```
After Job/Visit is unified, update WeekView.jsx, Today (now removed), Dashboard.jsx, and PropertyDetail.jsx to read the single scheduling endpoint instead of /api/visits, matching CalendarView/JobEditModal. Remove the /api/visits shim once no caller remains. Verify all scheduling screens show identical data.
```

---

## PHASE 3 — Polish (ongoing, lowest priority)

- Split mega-pages: `ClientProfile.jsx` (2,233), `Schedule.jsx` (2,198), `Settings.jsx` (1,617), `Comms.jsx` (1,333), and Billing's `Quoting.jsx` (1,491) into section components. One PR per page.
- One API client: migrate calls from the hand-written `src/api.js` onto the generated typed layer (`src/api/types.ts` + `helpers.ts`); regenerate types via `npm run gen:types`. Decide TS-vs-JS for the 3 stray `.ts`/`.tsx` files.
- Schema management: make Alembic the single source of truth — reduce `scripts/db_bootstrap.py` to "run migrations," and remove `reconcile_prod_schema.py` once migrations are authoritative.
- Address normalization: treat Property as canonical; have Job/RecurringSchedule reference it rather than copying address strings.
- Contact storage: decide whether `Client.email`/`phone` scalars or `ContactEmail`/`ContactPhone` tables are the source of truth; derive the other. (`ContactPhone` is load-bearing for phone-tail matching — handle carefully.)

---

## Working rules for Claude Code (paste at the top of any session)

```
- This is a production app (live on Railway). Work on a feature branch, never commit straight to main.
- For ANY database schema change, write an Alembic migration in backend/alembic/versions. Do not rely on db_bootstrap or create_all to alter prod schema.
- After every change: run `cd backend && python -m pytest -q` and `cd frontend && npm run build`. Both must pass before you commit.
- Before deleting or merging anything, grep to prove it's unused and report what you found. If a "dead" item turns out to be referenced, STOP and tell me.
- Make one logical change per commit with a clear message. Open a PR so CI runs (backend tests, Postgres RLS, frontend build).
- Do not change auth, billing math, or external integration credentials without calling it out explicitly.
```
