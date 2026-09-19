---
name: scheduling-invariants
description: >
  The authority contract for all scheduling, calendar, and sync work in BrightBase.
  Defines which system owns which piece of schedule state, which systems are read-only
  projections, and what is structurally forbidden. Use this skill BEFORE writing or
  modifying any code that touches scheduling, job visits, calendar sync, iCal feeds,
  Google Calendar, Connecteam, turnover scheduling, recurring schedules, or background
  sync jobs. Also trigger when the user says "sync", "schedule", "calendar", "turnover",
  "iCal", "drift", "out of sync", "reconcile", "gcal", "Connecteam schedule", or asks
  to add, fix, or debug anything that moves schedule data between two systems.
  This skill CONSTRAINS other skills — when it conflicts with full-stack-builder,
  debug-integration, or db-deploy-engineer, this skill wins.
---

# Scheduling Invariants — BrightBase Authority Contract

This is not a build guide. It is a **contract**. Your job when this skill loads is to
enforce it, and to refuse work that violates it.

The scheduling system got messy because the correct philosophy — *"BrightBase is the
master; it pushes one-way"* — was never written down as an enforceable rule. It lived in
comments and intent while the code drifted. This file is where that rule lives now.

---

## Rule 0: The Prime Directive

> **BrightBase is the single source of truth for schedule state.
> Every other system is a projection or an inbox. Never a peer.**

If you are about to write code that lets an external system change a BrightBase Job or
Job Visit's time, assignment, or existence — stop. That is a contract violation. Go to
[Changing These Rules](#changing-these-rules).

---

## The Authority Model

| System | Role | May write to BrightBase? | Rebuilding it from scratch is safe? |
|---|---|---|---|
| **BrightBase Job / Job Visit** | **Canonical** | — | ❌ No. This is the truth. |
| **Google Calendar** | Projection (read-only mirror) | ❌ Never | ✅ Yes — blow away and rebuild |
| **Connecteam schedule** | Projection (read-only mirror) | ❌ Never | ✅ Yes — blow away and rebuild |
| **iCal / Airbnb turnover feeds** | **Inbox** (inbound only) | ⚠️ Only via staging | ✅ Yes — re-ingest from feed |
| **Twenty CRM** | *Design lineage only — NOT a live integration.* The models borrow Twenty's UX/shape (inbox, timeline, per-channel sync), but no Twenty client, API, or sync exists. Writes nothing. | ❌ Never (nothing is wired) | n/a |

Three roles, and only three. Every integration must be exactly one of them:

- **Canonical** — owns the truth. Exactly one system. It is BrightBase.
- **Projection** — a mirror that is *derived*. It is always safe to delete and regenerate
  a projection from canonical state. If deleting it would lose information, it is not a
  projection and you have a bug.
- **Inbox** — receives external facts that a human or rule *promotes* into canonical
  state. An inbox never writes canonical state directly.

**There is no fourth role.** "Partially authoritative", "mostly synced", and
"bidirectional with conflict resolution" are not roles. They are the disease.

---

## The Inbound Exception (the one that actually bites)

iCal/Airbnb feeds are the only inbound path, and they are the reason the "one-way" story
kept breaking. Model them explicitly:

```
iCal feed  →  external_booking_staging  →  [promotion: rule or human]  →  Job
              (raw, immutable, dated)                                     (canonical)
```

Rules for the inbox:

1. Ingested rows land in a **staging table**, never directly in `Job` or `Job_Visit`.
2. Staging rows are **immutable** — a changed booking is a new row, not an update.
3. Promotion to a Job is an **explicit event**, logged, reversible, and attributable.
4. A booking that disappears from a feed **does not delete a Job**. It raises a flag for
   review. Silent deletion of paid work is unacceptable.
5. Staging is safe to truncate and re-ingest. If it isn't, you've put state in it that
   belongs in canonical.

---

## The Canonical Pipeline

All schedule mutation flows through one path. Not fourteen.

```
        write (single entry point)
                 ↓
      ┌──────────────────────┐
      │  schedule_event      │   append-only. immutable. ordered.
      │  (the event log)     │   the ONLY writer of canonical change
      └──────────────────────┘
                 ↓
      ┌──────────────────────┐
      │  one reconciler      │   single worker. reads log, computes desired state.
      └──────────────────────┘
                 ↓
      ┌──────────────────────┐
      │  projection_state    │   per target: last_event_applied, last_push_at,
      │                      │   last_push_status, drift_count
      └──────────────────────┘
                 ↓
        idempotent outbound push  →  Google Calendar / Connecteam
```

**Why this shape:** sync health stops being a question you *poll for* and becomes a row
you *read*. `/sync-health`, `SyncHealthPill`, `useSyncHealth`, and `SyncBadge` should all
read `projection_state` and nothing else. One table, one truth, one screen.

**Internal originators.** Creating a canonical Job is itself a canonical change, not an
exemption from the pipeline. The quote→Job conversion, recurring generation, and manual
job creation are *clients of the single write entry point*: they create work by appending
a `schedule_event` — "the ONLY writer of canonical change" above — never by writing `Job`
/ `Job_Visit` directly. They are logged, attributable, reversible, and bound by R7 (no
automatic deletion). An internal producer is **not a fourth authority**: canonical is
still the single owner, and these write *through* the entry point like everything else.
(Today `_convert_quote_to_job` and recurring `generate_jobs` construct `Job` rows
directly — routing them through the log is part of the R8 cutover, and is exactly what R9
forbids going forward.)

---

## Hard Rules

These are checkable. Violating one blocks a merge.

### R1 — No new background ticks
The system currently runs **13** — 11 `IntervalTrigger` + 2 `CronTrigger`, all registered
on the single `BackgroundScheduler` in `backend/scheduler.py` (no second scheduler, no
module-scope `asyncio.create_task`; some are flag-gated, so a running dyno registers
fewer). Verified against `main @ 904c9c1` (2026-09) — **down from 14 at `fe6113a`**, i.e.
the ratchet has already moved the right way. That number may **only go down**. New
periodic work is a task on the existing queue with a lock, not a new tick, not a new cron,
not a new `asyncio.create_task` in module scope.

### R2 — No writeback from a projection
No code path may read from Google Calendar or Connecteam and write to `Job`, `Job_Visit`,
or any canonical table. Reading a projection is allowed **only** to compute drift.

### R3 — Drift is detected, never auto-resolved upstream
If a projection disagrees with canonical, the fix is always: **overwrite the projection.**
Never reconcile "toward the middle." Never prefer the external value. If canonical is
wrong, a human fixes canonical.

### R4 — Every outbound push is idempotent
Each push carries a stable external ID and a version/etag. Pushing the same event twice
must produce the same result and no duplicate calendar entries. Assume the network will
lie to you and every push will happen at least twice.

### R5 — One lock per resource
Concurrent syncs for the same Job/Property/Visit are serialized by lock key
(`job:{id}`, `property:{id}`). Two workers must never race on the same booking.

### R6 — No sync logic in `router.py`
`router.py` is at ~190KB. It is a monolith wearing a router's name. Routers do routing:
parse the request, call a service, shape the response. Sync, reconciliation, and
calendar logic live in the service layer. **No new lines of sync logic enter that file.**

### R7 — Deletion of canonical work is never automatic
No automated path deletes a `Job` or `Job_Visit`. Automation may flag, cancel-pending,
or raise for review. A human confirms.

### R8 — Additive migration only
BrightBase is live: 1,000+ customers, 7,000+ visits. New pipeline is built alongside the
old one, dual-written, verified against real data, then cut over. No in-place refactor of
a running scheduling system. No exceptions for "it's cleaner this way."

### R9 — Canonical Jobs are created only through the write entry point
Creating a Job is a canonical change, so it happens the one way canonical change is
allowed: by appending to the `schedule_event` log (the single write entry point — "the
ONLY writer of canonical change"). No module constructs a `Job` / `Job_Visit` directly.
Quote→Job, recurring generation, and manual creation are all *producers* of
`schedule_event`s, not writers of `Job`. An internal producer that writes `Job` directly
is the same class of bug as a projection writing back (R2): it is a second writer of
canonical state. (Enforceable by grep: a `Job(...)` / `db.add(Job(...))` construction
outside the write entry point is a violation.)

---

## Prohibited Patterns

Recognize and refuse these. Each one is how the current mess got built.

❌ **"Let's just add a quick sync job for X"** → R1. Add a task, not a tick.

❌ **"Google has the newer timestamp, so use Google's version"** → R2, R3. Timestamps do
not confer authority. Authority is declared, not inferred.

❌ **"Bidirectional sync with conflict resolution"** → There is no such thing as a
conflict when there is one owner. If you need conflict resolution, you've created a
second owner.

❌ **"The Airbnb booking vanished, so cancel the cleaning"** → R7. Flag it.

❌ **"I'll add the sync call right here in the route handler"** → R6.

❌ **"Just this once, write back to BrightBase from Connecteam"** → R2. This is the exact
sentence that produced the current drift-detection machinery.

❌ **"The quote was accepted, so create the Job right here"** → R9. A Won quote is a
producer, not an authority: emit a `schedule_event` and let the write entry point
materialize the Job. Constructing `Job(...)` inline makes the quote path a second writer
of canonical state.

❌ **Adding a new `*_sync.py` module** → You almost certainly want a new *task* in the
existing reconciler. There should be one sync engine, with adapters per target — not
`ical_sync.py` + `gcal_sync.py` + `google_calendar.py` + `connecteam.py` each
reimplementing retry, drift, and state.

---

## Pre-Merge Checklist

Run this before any scheduling PR is proposed. Report it in the PR description.

```
[ ] R1  Background tick count unchanged or lower. Current count: ____ (baseline 13)
[ ] R2  No new writes to canonical tables from projection reads
[ ] R3  All drift resolution overwrites the projection, not canonical
[ ] R4  Every new outbound call is idempotent (stable external ID + version)
[ ] R5  Concurrent work on the same resource is lock-serialized
[ ] R6  Zero net new lines of sync logic in router.py
[ ] R7  No automated deletion of Job / Job_Visit
[ ] R8  Change is additive; old path still works; rollback is one config flag
[ ] R9  Canonical Jobs created only via schedule_event; no direct Job/Job_Visit construction
[ ] Every integration touched is still exactly one of: canonical / projection / inbox
```

If any box is unchecked, say so plainly and stop. Do not merge and note it as follow-up —
that is precisely how the fourteen ticks accumulated.

---

## When You Load This Skill

1. **State the authority model back** in one sentence before proposing anything, so the
   assumption is visible and correctable.
2. **Classify the request**: is this canonical logic, a projection push, or inbox
   ingestion? If you can't tell, ask. Ambiguity here is the root cause of the mess.
3. **Check it against the Hard Rules** before writing code.
4. **Prefer deleting a tick over adding a feature.** The best scheduling PR reduces
   surface area.

---

## Changing These Rules

These rules are not sacred, but they are **expensive to change and cheap to follow.**

To change one:
1. Say explicitly which rule and why the current one fails.
2. Get Meg's approval — in writing, in the conversation. Not inferred from enthusiasm.
3. Update this file **in the same PR** as the code that depends on the change.

A rule that gets quietly worked around is worse than no rule, because it teaches the
next session that the contract is decorative. If the contract is wrong, fix the contract.

---

## Provenance / verification log

- **2026-08 — R9 added** ("Canonical Jobs are created only through the write entry point")
  + the "Internal originators" note, with Meg's written approval. Closes the gap where the
  quote→Job canonical write was unclassified.
- **2026-09 — Confirm-Before-First-Use items resolved:**
  1. **Twenty CRM is not a live integration.** Codebase read: `backend/integrations/` has
     no Twenty client; no `TWENTY_*` env, REST, or GraphQL call; every "twenty" reference
     is either the number or a design-lineage comment ("Twenty-style timeline", "Twenty's
     message/calendar channels"). It writes nothing, so it cannot be a fourth authority.
     The authority-table row is kept, relabeled as design lineage rather than a running
     projection.
  2. **Background tick count pinned at 13** in R1 — 11 interval + 2 cron, verified against
     `main @ 904c9c1`; down from 14 at `fe6113a`, so R1's ratchet has already moved down
     once (a tick was removed — the good direction).
