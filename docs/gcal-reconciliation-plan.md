# Scheduling reconciliation: Google Calendar / feeds as source of truth

**Status:** proposed plan (no code changes in this doc)
**Author:** engineering, June 2026
**Context:** follow-on to the Pier-House missing-turnover work (#206–#211).

## The goal, stated precisely

The operator's instinct — "Google Calendar should be the source of truth for
scheduling" — is right, but "we don't even need a database" is not. The database
still owns everything Google can't: clients, properties, quotes, invoices, job
completion, payroll, comms history, and the iCal dedup ledger. (Twenty CRM, the
reference, is itself a Postgres app that *syncs* Google — it didn't delete its
DB.)

So the principle is a **clean source-of-truth split**, not a rewrite:

| Concern | Source of truth |
| --- | --- |
| Whether an event/turnover exists, its **date & time**, reschedules, cancellations | **Google Calendar + iCal feeds** |
| Client, property, quote, invoice, assignment, completion, payroll, history | **Database** |

Everything else is "derived": the DB *reconciles to* Google/feeds for the event
layer and never silently wins a disagreement. The Pier-House bug was exactly a
case where a stale DB row won — this plan makes that structurally impossible.

## How scheduling syncs today (grounded in the code)

Three engines, all DB-backed, run on the scheduler (`backend/scheduler.py`):

1. **iCal feeds → DB → GCal** (`integrations/ical_sync.py`, every 15 min)
   - Fetches each property's Airbnb/VRBO/etc. feed, upserts `ICalEvent` rows,
     creates `str_turnover` `Job`s for future checkouts, and pushes them to
     Google Calendar via `create_event` (which stamps
     `extendedProperties.private.brightbase_job_id`).
   - Self-heals stuck turnovers (deleted / cancelled / wrong-date linked job)
     and reports coverage (`future_bookings` / `missing_turnovers`). [#206–#211]

2. **Google Calendar ↔ DB** (`integrations/gcal_sync.py`, every 10 min)
   - `sync_calendar()` pulls events, matches them to clients (by
     `brightbase_*` extended properties, attendee email, or address), and
     **creates/updates Jobs** — treating the GCal event's **date/time as
     authoritative** (writes it back onto the Job).
   - `sync_gcal_cancellations()` soft-cancels Jobs whose GCal event vanished.
   - Docstring already declares the "GCal as source of truth" intent.

3. **Recurring schedules → DB → GCal** (`modules/recurring/router.py`, daily)
   - Materializes residential/commercial `Job`s from `RecurringSchedule`s.

The schedule/calendar UI reads from the DB (`Job`/`Visit`), so the DB must be a
faithful mirror of Google/feeds for the calendar to be trustworthy.

## Where DB and Google can still disagree (the gaps)

These are the concrete conflict surfaces found while fixing Pier House:

- **G1 — Date-type churn in `gcal_sync` (real bug).**
  `_parse_event_datetime()` returns a **string** `"YYYY-MM-DD"`, but
  `Job.scheduled_date` is a `Date`. `sync_calendar` does
  `if new_date != existing_job.scheduled_date:` (str vs date → *always* unequal),
  so every poll marks the job "changed" and writes a **string** into the Date
  column. Result: constant churn, noisy `jobs_updated`, and the same
  string-vs-date class of bug we've been eliminating. *(gcal_sync.py ~278-285)*

- **G2 — No global coverage / health view.** Coverage now exists per-property in
  the iCal result [#211], but there's no single "is the whole schedule a faithful
  mirror of the sources?" signal an operator can trust at a glance.

- **G3 — No deterministic rebuild.** When state drifts (as Pier House did), the
  only recourse was several rounds of targeted fixes. There's no one-click
  "rebuild this property's schedule from the sources."

- **G4 — Implicit, scattered precedence rules.** "Active booking always keeps a
  turnover", "GCal date wins", "feed drop cancels" are spread across three files
  with subtle interactions (e.g. a GCal delete of a feed-backed turnover is
  resurrected next iCal tick — correct per policy, but undocumented).

- **G5 — Legacy NULL/stale dates.** Multiple safety nets exist (rehydrate
  endpoint, `_backfill_turnover_gcal`, the new reconcile path). They should
  *converge* rather than each patch a symptom.

## Phased plan (each phase = one shippable, reviewable PR)

### Phase 1 — Make the event layer type-correct & idempotent *(low risk, high value)*
- Fix **G1**: normalize GCal-parsed dates/times to real `date`/`time` objects
  before comparing/assigning in `gcal_sync` (reuse the `_to_date`/`_to_time`
  helpers). A poll with no real change must produce **zero** writes.
- Add a regression test asserting a second identical GCal sync is a no-op
  (`jobs_updated == 0`), proving idempotency.
- *Outcome:* the two engines stop fighting over date representation; the
  Pier-House class of "DB silently disagrees" is closed at the type level.

### Phase 2 — One source-of-truth precedence module + docs *(low risk)*
- Extract the precedence rules into one documented place (a small
  `scheduling/reconciliation.py` or a doc + shared helpers) so the policy is
  explicit and testable: who wins for existence, date, cancellation, completion.
- Encode the agreed policy: **an active source booking always has an active
  turnover** (resurrect), **completed jobs are terminal**, **source date wins**.

### Phase 3 — "Rebuild schedule from sources" action *(the escape hatch)*
- New admin endpoint + button (per property, and an all-properties variant):
  re-fetch feeds + GCal and force the DB to match — recreate missing turnovers,
  fix dates, re-link or cancel orphans — returning a full before/after report.
  This is the deterministic recovery that would have fixed Pier House in one click.
- Idempotent and dry-run-able (preview before applying), building on the existing
  `ical-preview` diagnostic.

### Phase 4 — Global schedule-health signal *(observability)*
- A dashboard/admin readout: across all STR properties, how many upcoming
  checkouts are covered, any feeds failing, any drift. Turns the per-property
  coverage from #211 into a single trustworthy "everything's mirrored ✓".

### Phase 5 — Converge the legacy safety nets *(cleanup)*
- Fold the rehydrate / backfill / reconcile one-offs into the Phase 2 precedence
  path so there's a single reconciliation routine, and retire the redundant ones.

## Risks & mitigations

- **Two-way sync loops / churn.** Mitigated by Phase 1 idempotency (no-op when
  nothing changed) + tests that assert zero writes on a stable sync.
- **Overriding intentional manual edits.** Policy is explicit (Phase 2): the
  calendar/feed is authoritative for the *event layer*; if the operator wants a
  booking *not* cleaned, that's a first-class "skip", not a silent DB edit.
- **Destructive rebuild.** Phase 3 ships dry-run-first and never touches
  completed jobs, invoices, or the business layer.
- **Google API limits/outages.** Existing per-feed error capture + ret/status
  pills; rebuild is on-demand, not a tight loop.

## Explicitly out of scope
- Removing the database / making Google the *only* store. The DB remains the
  system of record for the business layer; this plan only makes it *defer* to
  Google/feeds for the event layer.

## Suggested order
Phase 1 first (it's a real bug fix and unblocks trustworthy idempotency), then 3
(the escape hatch the operator most wants), then 2/4/5. Each is independently
shippable and CI-gated.
