---
name: recurring-doctor
description: Diagnose and clean up recurring series data — duplicates, junk titles, ended-but-active rows, stalled generation, paused leftovers. Use when the Recurring page looks wrong or the owner reports duplicate/ghost series.
---

# Recurring Doctor

You are debugging the recurring-series data for The Maine Cleaning Co. Label
responses **[Recurring Doctor]**. Never mutate production data silently:
propose first, show original values, flag destructive fixes with ⚠️.

## Start with the built-in scan

`GET /api/recurring/cleanup/health` (admin/manager) is the authoritative
audit. It is read-only and returns, per sick series: `problems[]` with
`code`, `severity` (error/warn/info), `message`, `suggestion`, and
`destructive`. Codes:

| code | meaning | fix path |
|---|---|---|
| `duplicate` | live series identical to another (client+property+cadence+time, overlapping days) | keep one; pause (`PATCH {active:false}`) or cancel (`DELETE`, soft) the rest — the Recurring page's duplicate review panel walks through it |
| `no_time_set` | NULL start/end time (schema drift — model says NOT NULL) | edit the series, set the window |
| `ended_but_active` | `series_end_date` passed but still `active` | pause it; history is kept |
| `active_no_upcoming` | live but zero future jobs | `POST /{id}/generate` or inspect the rule |
| `junk_title` | title like "biweekly" that names nothing | rename to "Client — Cadence" |
| `stale_paused` | inactive, nothing upcoming | ⚠️ cancel only with explicit confirm |
| `no_property` / `property_missing` | property link absent or dangling | relink |
| `orphaned_client` | client row gone | cancel or relink |

The matching/grouping logic lives in `backend/services/recurring_guards.py`
(`audit_series`, `find_similar_series`) — extend it there, never in the
router (scheduling-invariants R6). Tests: `backend/tests/test_recurring_health.py`,
`test_recurring_dup_guard.py`.

## Root causes already identified (don't re-diagnose from scratch)

1. **Splits leave the predecessor active.** An "all future visits" edit
   (`POST /{id}/split`) retires the old series only via `series_end_date`;
   `active` stays True. That is why ended rows historically looked live.
   Frontend `isLiveSeries()` (frontend/src/utils/recurringDuplicates.js) and
   the audit both treat end-date-passed as not live. Do NOT "fix" split by
   flipping `active` — history views rely on it (R8: additive only).
2. **Creation had no dedupe** until the `allow_duplicate` 409 guard
   (`find_similar_series`); pre-guard duplicates persist in data and must be
   cleaned by hand via the review panel.
3. **`pause` and `cancel` are byte-identical** in the DB (`active=false`);
   only UI copy differs. A real status column is a proposed migration the
   owner has NOT approved — don't add it casually (R8 dual-write required).
4. **Schema drift**: production allows NULL `start_time` and NULL
   `Job.property_id` despite the models. Treat model constraints as
   aspirational when reasoning about prod data.

## Rules

- The scan never writes; every fix goes through the normal endpoints with a
  human confirm. Bulk fixes: propose the exact list (ids + before/after)
  and wait for approval.
- Cancelling a series is soft (DELETE keeps the row + history) but still
  ⚠️-flag it.
- Never auto-delete Jobs (scheduling-invariants R7) — off-phase visit
  cleanup has its own endpoints (`/cleanup/off-phase-preview` + `-apply`).
- After any fix wave, re-run the health scan and show before/after counts.
