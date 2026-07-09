# BrightBase Workflow Map

The operational pipeline: **Request → Quote → Accept → Schedule/Job → Dispatch → Complete → Invoice → Paid → Recurring.**

For each stage this documents the trigger, the owner's action, and the exact data that hands off to the next stage — grounded in the current code (`backend/modules/**`, `database/models.py`, `frontend/src/pages/**`), not the aspirational version. Where the code's actual behavior diverges from what a comment or the obvious UI story suggests, that's called out explicitly — those gaps are the parts worth fixing first.

A meta-note before the stages: a "dispatch-first redesign" (`DispatchBoard`, `UnassignedQueue`, `CrewUtilization`, etc.) was reviewed and merged into `Schedule.jsx` as part of this same pass, so the Dispatch section below describes the *current* merged behavior, not a future one.

---

## Stage 1 — Request (Lead Intake)

**Model:** `LeadIntake` (`database/models.py:553-611`), table `lead_intakes`.

**Trigger:** three public, unauthenticated endpoints all funnel through one canonical path:
- `POST /api/booking/submit` (`modules/booking/router.py:222`) — the maineclean.co booking/quote-request form.
- `POST /api/intake/submit` (`modules/intake/router.py:98`) — the maineclean.co contact form.
- `POST /api/intake/webhook` (`modules/intake/router.py:380`) — the "InstantEstimate" webhook / CRM-forward shape.

All three call `build_intake()` + `upsert_lead()` (`modules/intake/normalize.py:151,443`), which is where the real logic lives:
- **Idempotency-key short-circuit** — a client-supplied UUID collapses duplicate submits from the dual-forward pattern into one row (migration 044).
- **5-minute dedup window** — a second submit from the same email/phone within 5 minutes updates the existing row (fill-if-missing merge) instead of creating a second lead, guarded by a Postgres advisory lock against a true race.
- **Client match-or-create** by email/phone; the old contact value is preserved into `ContactEmail`/`ContactPhone` before being overwritten.
- **Property attach** — the booking address becomes a `Property` on the client (deduped on normalized address), so later stages have structured data instead of re-typed text.
- **Opportunity creation** — every lead becomes a deal at `stage="new"`; `LeadIntake.opportunity_id` is set.
- A price estimate (`estimate_min`/`estimate_max`) is computed if the caller didn't send one.

**Owner action:** works the **Requests page** (`pages/Requests.jsx`). Each card shows contact info, source, status, priority, estimate range. Row actions: **View Details**, **Create Quote**, **Archive**, **Delete**.

**Handoff to Quote — two paths that behave differently:**
1. A backend endpoint exists for this (`POST /api/intake/{id}/convert-to-quote`, `modules/intake/router.py:203`) that properly stamps `intake.status="quoted"` and `intake.converted_quote_id` — **but no UI calls it.** It's dead code from the frontend's perspective (only referenced in generated `types.ts`).
2. **What "Create Quote" actually does:** `Requests.jsx` navigates to `/billing?view=quotes` with the intake in `location.state`; `Quoting.jsx` pre-fills a draft (client match/create, address, price from the estimate midpoint, `intake.message` → `internal_notes`) that the operator reviews and saves via plain `POST /api/quotes`. **This path never sets `lead_intakes.status` or `converted_quote_id`.**

**→ Known gap:** because only the unused endpoint updates intake status, a request that's been quoted through the real UI flow still shows as `new`/`reviewed` on the Requests list. If "Requests" filtering by quoted/converted status matters, this is the first thing to fix — either wire `Requests.jsx` to the existing endpoint, or have `create_quote()` set the intake status itself.

**Fields that do carry forward regardless of path:** `Quote.client_id`, `Quote.intake_id`, `Quote.property_id`, `Quote.address`, `Quote.service_type`, `Quote.items[0].unit_price` (estimate midpoint), `Quote.frequency` (from `intake.frequency`), `Quote.internal_notes` (from `intake.message`).

---

## Stage 2 — Quote → Accept

**Model:** `Quote` (`database/models.py:919-1019`). Integer PK, inline JSON `items`. Status: `draft → sent → viewed → (changes_requested) → accepted → converted`, or `declined`/`expired`/`archived`.

**Trigger — send:** owner clicks **Send** on `QuoteDetail.jsx` or a Quotes-list row → `POST /api/quotes/{id}/send`. Generates/reuses the public `token`, builds a PDF, emails/texts. First send: `draft→sent`. A resend just bumps `follow_up_sent_at`. Blocked for $0 quotes.

**Trigger — accept (three entry points, one finalizer):**
1. Owner-initiated: `POST /api/quotes/{id}/accept` (e.g. "customer said yes on the phone").
2. Customer public link: `POST /api/quotes/public/{token}/accept` — row-locked against double-taps, checks `valid_until` expiry.
3. Customer self-schedule: `POST /api/quotes/public/{token}/schedule` — accepts **and** creates/dates a Job in one step (bypasses the normal cleaner-conflict guards since the customer can't react to a 409).

All three converge on `_finalize_quote_accept()` (`modules/quoting/router.py:1169`): logs `quote_accepted`; if `quote.property_id` is set, calls `_convert_quote_to_job()` (creates the Job **and** advances the Opportunity to `"won"`); otherwise just advances the Opportunity directly (an accepted-but-unconverted quote still counts as won). Emails the owner, and the customer if requested.

**Owner action:** the status dropdown on `QuoteDetail.jsx` routes "accepted"/"declined" through the real accept/decline endpoints (not a raw PATCH) specifically so the conversion side effects fire. "converted" is not manually selectable — it's a derived state reached only via Convert-to-Job.

**Handoff → Job:** (`_convert_quote_to_job()`, `modules/quoting/router.py:783-870`)
- `job.client_id ← quote.client_id`, `job.quote_id ← quote.id` (unique FK — one job per quote), `job.opportunity_id ← quote.opportunity_id`
- `job.property_id ← quote.property_id`, or the client's first existing property, or a new one created from `quote.address` — every Job requires a property.
- `job.job_type` ← mapped from `quote.service_type` (`str`/`str_turnover → "str_turnover"`, `commercial → "commercial"`, else `"residential"`)
- `job.title`, `job.address`, `job.notes` ← copied from the quote (with fallbacks)
- If a full schedule was supplied, delegates to `scheduling.create_job()` (all guards run — see Stage 3); otherwise inserted directly with `status="unscheduled"`.
- `quote.status → "converted"`, `quote.converted_at` stamped.

---

## Stage 3 — Schedule / Job creation

**Model:** `Job` (`database/models.py:463-549`) — the single source of truth for a scheduled occurrence.

**Job vs. Visit:** `Visit` is fully retired (migration `039_drop_visits_table.py`). Completion state (`completed_at`, `completed_by`, `checklist_results`, `photos`) lives on `Job` itself. Frontend "visit" naming (`Schedule.jsx`'s `visits` state, `CompleteVisitModal.jsx`) is a UI-layer label only — every write resolves `visit.job_id ?? visit.id` before hitting a real API.

**Trigger:** one canonical backend function, `scheduling.create_job()` (`modules/scheduling/router.py:642`), reached from three frontend components that all delegate to it:
1. **`JobCreateModal.jsx`** — the "+ New Job" button on Schedule, and the same modal reused as "Set up schedule" on an accepted quote (pre-filled with the quote's property/type/frequency).
2. **`ConvertToJobModal.jsx`** — reached only from `QuoteDetail.jsx`'s "Convert to job" button; delegates to `create_job()` when a full schedule is supplied.
3. **`JobEditModal.jsx`**'s new-job case.

(Recurring-schedule materialization and the customer self-schedule path insert/call this separately — see Stage 3's guards note and Stage 7.)

**What `create_job()` actually does:**
- Idempotent on `quote_id` — if the source quote is already converted, returns the existing Job instead of duplicating.
- Validates timing, checks for a same-property/same-date `str_turnover` conflict (409), and — unless `allow_conflicts=True` — runs cleaner-conflict, time-off, and daily-capacity guards, plus a Google Calendar Free/Busy check if enabled.
- Defaults `property_id` if omitted (client's first property, or a new one).
- **Pushes to Google Calendar immediately** (GCal is the system's "source of truth" for the calendar side).
- **Auto-dispatches to Connecteam immediately** if cleaners are already assigned at creation — no separate "Dispatch" click needed.

**Owner action:** fills out `JobCreateModal` — client/property, one-time date or recurring cadence (this modal is the fork point between Stage 3 and Stage 7), optional inline crew assignment.

**Handoff → Dispatch:** `job.cleaner_ids` is the actual trigger. `job.property_id`, `scheduled_date`/`start_time`/`end_time`, `address` are what dispatch and the calendar event both read.

---

## Stage 4 — Dispatch

Dispatch is **not a separate click** — it's an automatic side effect of `cleaner_ids` being set on a Job, wherever that happens: at creation (Stage 3), on any edit that changes cleaners/time (`update_job()` diffs a "Connecteam-relevant signature" and calls `resync_job()` or `auto_dispatch_job()` as needed), or on cancel (shifts are pulled).

**The actual logic** lives in `backend/integrations/connecteam_auto.py`:
- `auto_dispatch_job()` — one Connecteam shift per assigned cleaner. No-ops with a reason (`inactive_status`, `not_configured`, `no_cleaners`, `already_dispatched`) rather than erroring.
- `remove_job_from_connecteam()` — deletes shifts; keeps any that fail so a retry can clean up.
- `resync_job()` — remove then re-add, used on reschedule/reassign.

**Owner action:** assign crew inline in `JobEditModal`/`JobCreateModal`/`ConvertToJobModal`; dispatch fires on save. The **desktop Dispatch view** (merged in this pass — `DispatchBoard.jsx`) surfaces this directly: an `UnassignedQueue` (jobs today with no crew, sorted by start time), a `DispatchTimeline` (jobs positioned by time, colored by service type), and `CrewUtilization` (per-crew hours + capacity bar) so assigning a crew and triggering dispatch happen in the same click. A manual catch-up action, **"Fix sync now"** on the Schedule health strip, pushes unsynced jobs to Google Calendar and dispatches upcoming assigned-but-unpushed jobs in one call (`POST /api/jobs/sync-reconcile`); this also runs automatically on a scheduled background tick.

**Handoff → completion:** `job.connecteam_shift_ids` and `job.dispatched` are the durable record; `job.gcal_event_id`/`gcal_account_id` record the calendar side. Same `Job` row proceeds.

---

## Stage 5 — Job Completion (the important asymmetry)

**There are two distinct "mark complete" code paths with materially different side effects** — this is the single highest-value correction in this document.

**Path A — `POST /api/jobs/{id}/complete`:** sets `status`, `completed_at`, `completed_by`, `checklist_results`, `photos`, `notes` in one idempotent call. **Does not auto-create an invoice.** Used by `Schedule.jsx`'s **"Complete Visit"** flow (checklist + photo upload, `CompleteVisitModal.jsx`) — the actual field-completion UX — and a completion action on `PropertyDetail.jsx`.

**Path B — `PATCH /api/jobs/{id}` with `{status: "completed"}`:** the generic field-update endpoint. **This path auto-creates a draft Invoice the first time a job lands on "completed"** (idempotent — skips if one already exists), pulling line items from the source Quote if one exists, else a placeholder line; `tax_rate` from the quote or a `5.5` default; `due_date = now + 14 days`. Used by `JobDetail.jsx`'s status dropdown and `JobEditModal.jsx`'s "Completed" pill.

**Practical consequence:** whether a completed job automatically gets a draft invoice depends on *which UI the operator used*. `JobDetail.jsx` also shows a client-side "Ready to bill?" banner any time status flips to completed in that session with no invoices loaded yet — this fires regardless of which path was used, so an operator who completes via the dropdown (which already auto-invoiced) and then also clicks that banner's "Create invoice" can produce two invoices for one job (only the *auto*-invoice logic checks for an existing one first).

**Owner action:** field/dispatch side uses **CompleteVisitModal** (checklist + photos); office side uses the **JobDetail status dropdown** or **JobEditModal's Completed pill**.

**Handoff → Invoice:** `invoice.client_id/job_id/opportunity_id ← job.*`; `invoice.items ← quote.items` (via `job.quote_id`) or a placeholder; `invoice.tax_rate ← quote.tax_rate` or `5.5`; `invoice.status = "draft"`.

---

## Stage 6 — Invoice → Sent → Paid

**Model:** `Invoice` (`database/models.py:616-651`). No `quote_id` column — reachable only transitively via `job.quote_id`.

**Trigger — creation:** auto-create on completion (Stage 5, Path B only), or manually via `POST /api/invoices` from `JobDetail.jsx`, `OpportunityDetail.jsx`, or the Billing page's "New invoice" button.

**Owner action — send:** **"Send invoice"** on `InvoiceDetail.jsx` → `POST /api/invoices/{id}/send` — emails/texts the client, logs a `Message`, flips `draft → sent`.

**Owner action — mark paid:** **"Mark paid"** → `POST /api/invoices/{id}/pay`. **This is not real payment processing** (the code says so directly) — it accepts the click and sets `status="paid"`, `paid_at=now()`, with a `Message` row as an audit trail. A public payment portal exists (`PublicPayment.jsx`, HMAC-token-gated) for the customer-facing side.

**Handoff forward:** paid invoices don't create anything new directly. `paid_at`/`status` feed the dunning scheduler (resets on payment) and the revenue dashboard. **There is no automatic "paid → set up recurring" link** — recurring setup is tied to the Quote's `frequency` and the accept event (Stage 7), not to invoice payment.

---

## Stage 7 — Recurring

**Model:** `RecurringSchedule` (`database/models.py:380-416`) + `RecurrenceException` for per-occurrence skip/reschedule.

**Trigger — creation:** `POST /api/recurring`, reached via `JobCreateModal` when the operator picks a cadence instead of a single date, or via "Set up schedule" on an accepted quote (`QuoteRow.jsx` → pre-filled `JobCreateModal`). Creation immediately calls `generate_jobs()` for the first batch, and flips the linked quote to `"converted"` server-side too (belt-and-suspenders vs. the frontend's own PATCH).

**Trigger — ongoing generation:** a background scheduler tick (`recurring_jobs_tick()`, default every 24h) plus manual `POST /api/recurring/generate-all` / `/{id}/generate` from `Recurring.jsx`.

**`generate_jobs()` logic:** expands the rule out to `generate_weeks_ahead` (default 8) weeks, honoring frequency/interval/days-of-week; subtracts skip exceptions and adds reschedules; skips dates that already have a Job (idempotent, safe to re-run). **For each new date, the Job is a near-verbatim clone of the schedule's template fields** (`client_id`, `property_id`, `job_type`, `title`, `address`, `cleaner_ids`, `notes`) — not derived from the previously-completed occurrence. Pushes to Google Calendar the same way `create_job()` does, but **does not run the cleaner-conflict/capacity/Free-Busy guards** and **does not auto-dispatch to Connecteam** — dispatch for recurring-generated jobs happens later via the sync-reconcile tick or a manual edit.

**Owner action:** `Recurring.jsx` draws a clear line between **"just this visit"** (Skip/Reschedule → creates a `RecurrenceException`, immediately cancels/materializes the affected Job) and **"all future visits"** (PATCH the rule itself — frequency/days/times/duration; pause via `active:false`; cancel via soft-disable DELETE).

**Handoff → Job (repeating):** each generated `Job.recurring_schedule_id` points back at the schedule; nothing carries from one occurrence to the next, so a one-off time change via a reschedule exception does not propagate to future occurrences (exceptions are deliberately per-date-scoped).

---

## Cross-cutting corrections

1. **Job vs Visit:** `Visit` is fully retired. `Job` is the single source of truth including completion state. Frontend "visit" terminology is a UI label only.
2. **Job creation:** one canonical backend function (`scheduling.create_job()`), reached from three frontend components (`JobCreateModal`, `ConvertToJobModal`, `JobEditModal`'s new-job case) that all funnel into it — not three independent creation paths with different guarantees.
3. **Dispatch is a side effect, not a page.** It fires automatically when `cleaner_ids` changes; the merged Dispatch view (Stage 4) makes that assignment action visible and central rather than adding a new manual step.
4. **Two "complete" code paths with different consequences** (Stage 5) is the highest-value fix candidate: auto-invoicing only fires on the PATCH-status path, not the `/complete` endpoint the actual field-completion checklist UI uses.
5. **Intake → Quote status handoff doesn't work today** (Stage 1): the live "Create Quote" flow never calls the endpoint that stamps `lead_intakes.status = "quoted"` — only an endpoint with no UI caller does that.
