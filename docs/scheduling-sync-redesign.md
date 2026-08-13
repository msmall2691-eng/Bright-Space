# Scheduling Sync Redesign — the Sync Control Center

**Status:** Phase 1 shipped (Sync Control Center). Phase 2 (`schedule_events` log)
merged and dark. See **Current state** (below) for the live running log.

This doc is the companion to [`workflow-map.md`](./workflow-map.md). Where the
workflow map walks the operational pipeline (Request → … → Recurring), this one
is about the **sync layer** underneath Stage 3–4 — everything that keeps the
BrightBase schedule in step with Google Calendar, Connecteam, and the Airbnb/VRBO
rental feeds. It exists because that layer *felt* out of control, and the fix was
mostly to make it **legible**.

---

## Current state (running log — updated 2026-08-13)

A living snapshot so a fresh session doesn't pay a reconstruction tax. This is the
first thing to read; update it as state changes.

**✅ Security gate — cleared (2026-08-12).** The Railway Postgres credential was rotated
and the access review came back clean (TCP auth on the new password `AUTH_OK`; `pg_roles`
shows exactly one login role, `postgres`; app reconnected at `073`). Activation / Phase 3
is unblocked. Do **not** re-run the rotation — it's done.

**Phase 2 — `schedule_events` log:** shipped and merged (#664, squash → `06d7860`).
Append-only `schedule_events` + `projection_state`, a flush-listener dual-write, and
migration 068. Currently **dark**: `SCHEDULE_EVENT_LOG_ENABLED` defaults OFF.

- *Flag blast-radius (load-bearing invariant):* the flag gates only
  `INSERT INTO schedule_events`, and **no code path reads the log**. Turning it on
  therefore *writes rows* — it does **not** push to Google / Connecteam. Anyone who
  adds a *reader* of the log changes that blast radius and must re-check the Phase 3
  sequencing below.
- *Activation — safety prep SHIPPED (this branch / #665), flag still OFF:* migration
  **077** drops the `schedule_events` FKs (`job_id` CASCADE + `org_id`) so the append-only
  log retains a deleted job's history and a `deleted`-event insert can't FK-violate the
  just-removed row on Postgres (which would otherwise roll back the job deletion); the
  flush listener is now **fail-safe** — a logging error can never break a Job write
  (regression test `test_listener_error_never_breaks_the_job_write`). The log is still
  **dark**; this prep changes no observable behavior.
- *Cut-over BUILT (this branch / #665):* a read-only **log-health surface** in the Sync
  Control Center (`schedule_log` in sync-overview + a "Schedule log" card showing
  Capturing/Dark, counts, and a by-type breakdown) plus `ENV SCHEDULE_EVENT_LOG_ENABLED=1`
  in the Dockerfile. **Merging #665 turns the log ON in prod** and the card shows it
  capturing against real data. Kill-switch: set `SCHEDULE_EVENT_LOG_ENABLED=0` in Railway
  (no redeploy). Code default stays OFF, so local/dev/tests remain dark.

**R1 baseline: 13 ticks (2026-08-13, Connecteam-removal step 3).** Was 14 (re-verified
@ `af379fa`, 2026-08-12); the `connecteam_outbox_drain` tick is deleted and
`sync_reconcile` is Google-only — the ratchet went DOWN for the first time. The
Connecteam projection is retired: no drain, no reconcile half, no inline dispatch on
job create, no recurring-generation/reschedule dispatch, no iCal turnover dispatch.
The Sync Control Center shows the channel as a static "Retired" card; per-job manual
dispatch endpoints remain until their UI is removed (steps 4–5). Crew schedule +
time clock are native (My Day; payroll_source defaults native). Ratchet check:
`git grep -c '_scheduler\.add_job(' backend/scheduler.py`.

**⚠️ Open — Google Calendar durable idempotency token (BLOCKS the Phase 3 reconciler):**
the GCal push calls `events().insert()` with no client-supplied event id, so a crash
after the insert but before the `gcal_event_id` commit orphans a Google event.
Connecteam already has durable intent (outbox + unique dedupe + skip-locked drain);
GCal does not. Must be fixed **before** the Phase 3 reconciler pushes to Google from the
log. Tracked as a blocking checkbox in the Phase 3 section and (to-do) an R4 "Known
Violations" entry in the `scheduling-invariants` contract.

**Phase 3 plan (after the live log is verified):** merge `sync_reconcile_tick` ∪
`connecteam_outbox_drain_tick` into one reconciler that reads the log forward per
`(target, job_id)`, advances `projection_state`, and does the idempotent push (giving
GCal the durable token above). `schedule_audit` / `turnover_coverage` become reads off
`projection_state`. Inbound ticks (iCal / gcal / gmail / watch-renew) stay out of scope.
Producers (`recurring_jobs`, `str_turnover_autoassign`) stay upstream — they *emit*
events, they don't reconcile.

---

## 1. The complaint, and the real diagnosis

> "It's kinda crazy with how much it syncs with other schedules."

That instinct is right, but the cause isn't what it looks like. The scheduling
**engine is sound** — it already follows one clean rule:

> **BrightBase is the master.** The `Job` row is the single source of truth. It
> pushes *out* to Google Calendar and Connecteam; it pulls Airbnb/VRBO turnovers
> *in* as new jobs; it generates recurring visits *itself*. Edits made directly
> in Google are surfaced as "drift" and re-asserted, not obeyed (default
> `calendar_source_of_truth = "brightbase"`).

The problem was never the model. It was that the model was **invisible and
scattered**:

1. **~14 background jobs run on their own timers** (`backend/scheduler.py`) and
   nothing surfaced them. Google push every 10 min, iCal pull every 15, reconcile
   every 30, Connecteam outbox drain, recurring generation, STR auto-assign,
   schedule audit, SMS reminders, dunning, coverage checks, quote expiry, two
   watch-channel renewals, Gmail inbox. Fourteen hands moving the schedule, none
   of them visible.

2. **The "one-way" story has real exceptions** that were never shown plainly:
   - Airbnb/VRBO **iCal feeds push inbound** — they create turnover jobs
     (`integrations/ical_sync.py`).
   - Google/Connecteam edits create **drift** that's detected, logged, and
     silently overridden (`integrations/gcal_sync.py`,
     `integrations/connecteam_auto.py`).

3. **Status was fragmented** across three places that never showed the whole
   picture at once:
   - a compact health **pill** (`/api/jobs/sync-health` → `SyncHealthPill`),
   - a **toggles** panel (`ScheduleSyncSettings`, Settings → Automation),
   - per-feed status buried on **property pages** (`PropertyIcal.last_sync_*`).

So the schedule behaved like a black box with fourteen hidden hands. Even when it
was doing exactly the right thing, you couldn't *see* that — which reads as
chaos.

---

## 2. Phase 1 — the Sync Control Center (shipped)

One screen (`/sync`, **Scheduling → Sync** in the nav) that makes the whole
nervous system legible and controllable, without changing any of the underlying
sync behavior.

### Backend

`GET /api/jobs/sync-overview` → `modules/scheduling/sync_overview.build_sync_overview(db, org_id)`.

A single **read-only** aggregation (no external API calls, no mutations, fully
org-scoped for MT-3). It rolls up:

- **Channels** — one entry per external schedule, each with:
  - `direction` — `out` (Google, Connecteam), `in` (Airbnb), `internal` (recurring);
  - `authority` — who wins a conflict (`brightbase` / `google` / `external`);
  - `connected`, `enabled` (+ the `toggle_key` its pause switch posts);
  - `last_sync_at` — derived, since no per-tick "last ran" store exists:
    `MAX(integration_events.created_at)` by provider for Google/Connecteam,
    `MAX(PropertyIcal.last_synced_at)` for feeds, newest recurring-linked job for
    recurring;
  - `backlog` — jobs waiting to reach that system; a `status` verdict
    (`ok` / `syncing` / `paused` / `attention` / `disconnected`).
- **`background_jobs`** — the ~14 ticks with their real cadences, grouped
  (scheduling / health / messaging / housekeeping). The hidden hands, made visible.
- **`attention`** — only what a human should act on (Google disconnected, a feed
  failing to import, duplicate jobs, orphaned shifts, a backlog while auto-pilot
  is off). Each carries an action.
- **`auto_pilot`** — whether the schedule maintains itself with zero manual
  pushes, plus the toggle snapshot.

It's the richer sibling of `/sync-health` (which still powers the compact pill);
the two share helpers (`_sync_overall`, `_app_flag`, `find_schedule_issues`) so
they can't disagree.

### Frontend

`pages/SyncCenter.jsx` + `hooks/useSyncOverview.js`:

- a **master banner** stating the mental model ("BrightBase is the master…") with
  the overall status and **one auto-pilot switch**;
- an **attention** list (only when there's something to do);
- four **channel cards** — flow direction, who-wins, last-sync, what's waiting,
  a per-channel **pause** toggle and **Sync now** button; the Airbnb card expands
  to per-feed health (the status that used to hide on property pages);
- an **"Under the hood"** panel listing the 14 background jobs and their cadences;
- **read-only** for viewer/cleaner roles (write actions hidden).

Every action **reuses an existing endpoint** — nothing new to maintain:

| Control | Endpoint |
| --- | --- |
| Pause / resume a channel, master auto-pilot | `POST /api/settings/automation` |
| Sync now — Google | `POST /api/jobs/push-to-gcal` |
| Sync now — crews (Google + Connecteam) | `POST /api/jobs/sync-reconcile` |
| Sync now — rental feeds | `POST /api/properties/sync-all` |
| Sync now — recurring visits | `POST /api/recurring/generate-all` |

**Tests:** `backend/tests/test_sync_overview.py` (channel shape, flow directions,
failing-feed rollup, the 14 ticks, the disconnected-backbone verdict — in the
curated CI set) and `frontend/src/pages/__tests__/SyncCenter.test.jsx`.

### Why this was the right first move

It's **additive and safe** — an observability + control layer on top of the
existing machinery. Nothing was ripped out, so daily operations can't regress,
and the owner gets a screen they can trust *today*. It also turns the deeper
cleanup below from "scary rewrite" into "measurable simplification," because now
there's a place that shows what each piece is actually doing.

---

## 3. Roadmap — actually reducing the moving parts

Phase 1 made the syncing *legible*. Phases 2–5 make it *smaller*. Each is
independently shippable and ordered by risk. None is required for the Control
Center to be useful — it already reflects whatever the engine does.

### Phase 2 — foundation: an append-only schedule log (shipped, dark)

Before collapsing the catch-up paths we laid the substrate they'll all reconcile
*from*, so the later phases become "migrate onto the log" instead of "rewrite the
sync engine." Shipped additively and **dark** — a flag-gated dark-launch that
cannot change any observable behavior until it's turned on.

- **`schedule_events`** — an append-only, per-tenant event log. Every canonical
  `Job` mutation (create / reschedule / reassign / cancel / complete / delete)
  writes exactly one ordered row, *in the same transaction* as the Job change,
  via a single SQLAlchemy flush listener (`services/schedule_events.py`). One
  write chokepoint, not scattered call-sites — so no mutation can silently skip
  the log.
- **`projection_state`** — per-target (`google` / `connecteam` / …) bookkeeping:
  which event each projection has applied, last push status, drift count,
  external id. This is where "is Google caught up?" becomes a *row you can read*
  instead of a sweep you have to run.
- **Gated OFF by default** (`SCHEDULE_EVENT_LOG_ENABLED`). Flag off → the listener
  is a total no-op, nothing is written, live behavior is byte-identical. That's
  what makes this safe to merge before anything consumes it.
- **Additive migration** (`068_schedule_event_log`): two new tables + Postgres
  RLS, both added to `TENANT_TABLES`. No existing table touched (invariant R8).

This is the event-sourced spine the contract calls for: *canonical log → one
reconciler → projection_state → idempotent outbound push*. The reconciler and the
outbound push are the next phases; the log they read is now in place.

### Phase 3 — collapse redundant catch-up paths (low risk)

Today several ticks + endpoints overlap: `push-to-gcal`, `sync-reconcile`, the
reconcile tick, and the Connecteam outbox drain all exist to get "unsynced jobs"
onto their target system.

- Make **`sync-reconcile` the single outbound catch-up** (Google push + Connecteam
  dispatch in one), and reduce `push-to-gcal` to a thin alias.
- Fold the STR turnover auto-assign into the reconcile pass so an imported
  turnover is assigned and dispatched in one tick instead of three.
- **Goal:** ~14 ticks → ~8, with no behavior change the operator can observe. The
  Control Center's "Under the hood" list is the before/after scoreboard.

### Phase 4 — make Google strictly one-way, retire drift-babysitting (medium risk)

The `calendar_source_of_truth = "google"` legacy two-way mode
(`integrations/gcal_sync.py`) is the single biggest source of conceptual
complexity: drift detection, writeback, and the "who wins" branch all exist to
serve a mode that's off by default.

- Confirm no tenant relies on `"google"` mode (the Control Center now reports
  `authority` per tenant — check it before removing).
- Retire two-way pull; keep the one useful inbound signal (**cancellations sync
  both ways**) as an explicit, named path rather than a mode.
- Delete the drift-detection/re-assert bookkeeping that only existed to reconcile
  a mode nobody uses.
- **Goal:** Google becomes an unambiguous *projection* of BrightBase. "Who wins"
  stops being a question.

### Phase 5 — one durable outbound queue (medium risk)

Connecteam already has a transactional outbox (`ConnecteamOutbox`, rollback-safe,
deduped, retried). Google pushes don't — they're inline with an ad-hoc reconcile
sweep as the safety net.

- Route **Google event writes through the same outbox pattern**, so every
  outbound sync (Google + Connecteam) is one durable, observable queue with one
  retry policy and one failure surface.
- The Control Center then shows a single "outbound queue" depth instead of two
  different backlog notions.
- **Goal:** one mental model for "changes flowing out," one place they can fail,
  one place to watch them — which is exactly what the Control Center is already
  shaped to display.

### Guardrails for every phase

- Keep `sync-health` and `sync-overview` behavior-compatible; they're the
  regression tripwire.
- Anything that bounds coverage (a retired tick, a dropped mode) gets a line in
  this doc and a test in the curated set.
- Ship one phase per PR; watch the Control Center's attention list in production
  between them.
