---
name: brightbase-economy
description: Request/sync economy rules — no over-syncing, no unnecessary API calls, no polling where a push exists. Load before adding any fetch, sync, tick, or external API call, and when auditing for waste.
---

# BrightBase request economy

The app runs one small Railway container for a one-owner business, and its
crew uses it on rural cell connections. Every request costs money (external
APIs), battery/data (crew phones), or headroom (the single container).
"Economical" is a feature the owner has asked for by name.

## Hard rules

1. **No new background ticks** (scheduling-invariants R1 — the count only
   goes down). New periodic work joins an existing tick or becomes
   event-driven. Grep the baseline: `grep -n "add_job" backend/scheduler.py`.
2. **No frontend polling loops** (`setInterval` around a fetch) where an
   event, WebSocket message, or user action can trigger the refresh instead.
   If polling is truly unavoidable, interval ≥60s, page-visible only
   (`document.visibilityState`), and stop on unmount.
3. **One fetch per screen per need.** No per-row requests (N+1) — lists get
   a batch endpoint or the field joins an existing payload (the crew chat
   unread count riding my-day, costing zero extra requests, is the model).
4. **External APIs are metered — cache at the row.** Google geocoding writes
   lat/lng back so each address geocodes once (services/geocoding.py is the
   pattern). Google Calendar pushes are idempotent with stable IDs (R4) —
   never re-push unchanged events. Twilio sends are deliberate, never
   retried blindly.
5. **Cache immutable, never cache authed data.** Content-hashed /assets/*
   are cache-first in sw.js; API responses and HTML are never SW-cached.
   Offline needs use explicit, deliberate caches (bb_myday_cache) — not
   blanket caching.
6. **Crew payloads stay light** (documented my-day rule): no image bytes in
   list payloads, photos lazy behind a tap, uploads downscaled client-side,
   deferred to WiFi on cellular (photoQueue.js).
7. **Sync is one-way and minimal**: BrightBase → projections, drift
   overwrites the projection (R2/R3). Never add a second sync path or a
   "just in case" re-sync. A full rebuild is an explicit admin action, not
   a schedule.

## Audit checklist (how to find waste)

- `grep -rn "setInterval" frontend/src` — every hit needs a justification.
- `grep -rn "useEffect" frontend/src/pages/<page>.jsx` on hot pages — look
  for fetch storms on mount, missing dependency guards, refetch-on-focus.
- Per-row fetches: components that call `get()` inside a `.map()`d child.
- `backend/scheduler.py` — tick inventory vs the R1 baseline; any tick doing
  work when there's nothing to do should exit early and cheaply.
- Integration logs (`utils/integration_log.py`, IntegrationEvent rows) —
  repeated identical pushes for the same record = an idempotency bug.
- WebSocket usage: prefer pushing invalidations over polling for freshness.
- Duplicate data: two components fetching the same endpoint on one screen →
  lift the fetch or share via context/props.

## When adding a feature, answer before writing

1. Can this ride an existing payload or event instead of a new request?
2. What happens on a phone with one bar — how many requests, how many KB?
3. Does the external call cache its result on a row so it never repeats?
4. If the data changes rarely, why is it fetched often?
