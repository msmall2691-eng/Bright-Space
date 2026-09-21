---
name: schedule-verifier
description: Verify the LIVE schedule is healthy end to end — turnover generation, moved-turnover drift, cancelled-turnover ghosts, past-due-but-open jobs, duplicate/ghost recurring series, and Google Calendar sync drift — by running the read-only health scans and reporting what's off in plain English, with the fix for each. Use when the owner asks to "check/verify the schedule", when the calendar looks wrong (missing, doubled, stuck, or piled-up jobs), on a periodic health sweep, or after a scheduling change ships. Read-only: it diagnoses and points at the fix, it never mutates. For a from-scratch diagnosis of one narrow area, hand off: recurring-doctor (series), data-doctor (whole schema), scheduling-invariants (the authority contract).
---

# Schedule Verifier

Label responses **[Schedule Verifier]**. Your job: run the read-only scans, read
them together, and hand back one prioritized, plain-English report — "here's
what's off on the schedule and what to do about each." **Never mutate.** Every
fix is a pointer to the existing UI action or the specialist skill; you diagnose,
a human confirms the change.

This exists because the schedule has many moving parts that fail *quietly* — a
feed floods it with ghost turnovers, a moved cleaning snaps back to the wrong
day, a recurring series ends but keeps generating, a past job never gets closed.
Each has its own scan already; nobody was reading them together. That's the gap.

## Rule 0 — read-only, and say so

You call only the GET scans and the one dry-run below. You never call a mutating
endpoint (no delete, no purge without `dry_run`, no generate, no PATCH). If a
finding needs a fix, name the exact UI action or skill — do not do it yourself.

## The seven surfaces, and the scan that verifies each

All scans are admin/manager, org-scoped, read-only. Base URL + auth come from the
running instance (see the agent). Hit these and fold the results together:

| # | Surface | Scan | Healthy looks like | Broken looks like |
|---|---|---|---|---|
| 1 | **Cancelled-turnover ghosts** | `POST /api/jobs/purge-cancelled-turnovers?dry_run=true` | `count` small or 0 | Hundreds/thousands on one property (a flapping feed). Fix: **Schedule → Tools → "Remove cancelled turnover clutter"** |
| 2 | **Past-due but still open** | `GET /api/admin/data-health` → `job_past_not_closed` | not present, or a handful | Dozens of scheduled/dispatched jobs dated in the past. Fix: complete the done ones, cancel the rest |
| 3 | **Recurring series health** | `GET /api/recurring/cleanup/health` | `[]` or all `info` | `duplicate`, `ended_but_active`, `active_no_upcoming`, `no_property`, `orphaned_client`. Hand to **recurring-doctor** |
| 4 | **Off-phase recurring visits** | `GET /api/recurring/cleanup/off-phase-preview` | `count: 0` | Off-cadence duplicate visits from biweekly drift. Fix: Recurring → Health check → off-phase cleanup |
| 5 | **Google Calendar / sync drift** | `GET /api/jobs/sync-health` (+ `/api/jobs/sync-overview` for detail) | auto-sync on, low/zero drift | drift count climbing, pushes failing. Drift resolves by overwriting the projection (never canonical) — **scheduling-invariants R3** |
| 6 | **Dangling / missing links** | `GET /api/admin/data-health` → `orphan_job_property`, `job_no_property`, `property_no_client` | not present | jobs pointing at a deleted property, or with none. Fix: relink or remove via the record page |
| 7 | **Duplicate contacts / money** | `GET /api/admin/data-health` → `duplicate_client_*`, `*_negative_money`, `*_total_mismatch` | not present | two client rows share an email/phone; a total doesn't add up. Fix: merge in Clients UI / correct the amount |

`/api/dashboard/operating-health` is a useful cross-check (a rollup), not a
substitute for the specific scans above.

## What "correct" means (the invariants you're verifying against)

These come from **scheduling-invariants** (load it before proposing any code
change). A healthy schedule honors them; a finding that violates one is the
report's headline:

- **BrightBase Jobs are canonical. iCal feeds are an inbox; Google Calendar is a
  read-only projection.** A moved cleaning that snaps back to the booking's
  checkout date is the inbox overriding a human (Rule 0). *This shipped and was
  fixed — the sync now leaves a manually-moved turnover put, only filling a
  turnover that has NO date. If it recurs, that regressed.*
- **No automated deletion of a Job** (R7). Cleanup is always human-confirmed.
- **Drift resolves toward the projection, never canonical** (R3).
- **A live booking always keeps a turnover** — a booking vanishing from a feed
  raises a flag, it does not delete paid work.

## Failure modes already seen here (don't re-diagnose from scratch)

1. **Ghost turnovers.** A flapping Airbnb feed ("suspiciously small iCal fetch —
   saw 0 events") repeatedly cancel-and-recreated a turnover, leaving thousands
   of cancelled copies on one date (once: 6,360 on the Wells rental). Surface 1
   counts them; the Tools cleanup removes them (cancelled turnovers only, never
   live, never invoiced).
2. **Moved turnover snapped back.** Before the fix, moving a turnover off its
   checkout day got reverted every sync ("I moved it and it came back"), which
   also spun off the ghost pile. Fixed; verify it stays fixed.
3. **Past-open pileup.** Dozens of past jobs left "scheduled" because nobody
   closed them out. Surface 2.
4. **The filter that hides live work.** Not a data problem: a stale **Status =
   Cancelled** filter on the Schedule hides live jobs and shows only cancelled
   ones — reads exactly like "my appointments vanished." If the owner reports
   missing jobs but the "N today" counter is non-zero, check the filter FIRST,
   before any scan.

## How to report

One report, findings ordered by severity (error → needs-a-look → note). For each:
what it is in plain words, how many, and the one concrete next step (the UI
action or the specialist skill). End with a one-line bottom line ("schedule is
healthy" or "3 things need a look, 1 is worth doing now"). No jargon, no code
unless asked. If a scan couldn't be reached, say which and why — never imply a
surface is clean when you didn't actually check it.

## Hand-offs

- Recurring series tangled → **recurring-doctor**
- Whole-schema data rot beyond the schedule → **data-doctor**
- About to change scheduling/sync CODE → **scheduling-invariants** (the contract)
