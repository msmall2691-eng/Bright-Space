# Scheduling Sync Redesign — the Sync Control Center

**Status:** Phase 1 shipped (Sync Control Center). Phases 2–4 are a roadmap.

This doc is the companion to [`workflow-map.md`](./workflow-map.md). Where the
workflow map walks the operational pipeline (Request → … → Recurring), this one
is about the **sync layer** underneath Stage 3–4 — everything that keeps the
BrightBase schedule in step with Google Calendar, Connecteam, and the Airbnb/VRBO
rental feeds. It exists because that layer *felt* out of control, and the fix was
mostly to make it **legible**.

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

Phase 1 made the syncing *legible*. Phases 2–4 make it *smaller*. Each is
independently shippable and ordered by risk. None is required for the Control
Center to be useful — it already reflects whatever the engine does.

### Phase 2 — collapse redundant catch-up paths (low risk)

Today several ticks + endpoints overlap: `push-to-gcal`, `sync-reconcile`, the
reconcile tick, and the Connecteam outbox drain all exist to get "unsynced jobs"
onto their target system.

- Make **`sync-reconcile` the single outbound catch-up** (Google push + Connecteam
  dispatch in one), and reduce `push-to-gcal` to a thin alias.
- Fold the STR turnover auto-assign into the reconcile pass so an imported
  turnover is assigned and dispatched in one tick instead of three.
- **Goal:** ~14 ticks → ~8, with no behavior change the operator can observe. The
  Control Center's "Under the hood" list is the before/after scoreboard.

### Phase 3 — make Google strictly one-way, retire drift-babysitting (medium risk)

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

### Phase 4 — one durable outbound queue (medium risk)

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
