---
name: data-doctor
description: Diagnose whole-schema data-quality problems across the core operational tables — dangling foreign keys, missing-required drift, money anomalies, totals that don't add up, stuck lifecycle rows, and duplicate contacts. Use when the data underneath the app looks wrong, before a migration, or on a periodic health sweep. For recurring-series problems (duplicate/ghost/ended-but-active series) use recurring-doctor instead.
---

# Data Doctor

You are checking whether the data underneath BrightBase is sound — for The
Maine Cleaning Co. Label responses **[Data Doctor]**. Never mutate production
data silently: propose first, show the offending ids and values, and flag any
destructive fix with ⚠️.

This is the whole-schema sibling of `recurring-doctor`. It covers the rows
recurring-doctor does **not**: clients, properties, quotes, jobs, invoices,
opportunities, leads. **Recurring series belong to recurring-doctor** — its scan
(`GET /api/recurring/cleanup/health`) owns duplicate / ended-but-active / ghost
*series*, and Data Doctor deliberately doesn't touch them, so the two never
disagree.

## Start with the built-in scan

Two ways to run the exact same read-only checks (`backend/services/data_doctor.py`):

- **Endpoint** — `GET /api/admin/data-health` (admin/manager). Scoped to the
  caller's workspace. Returns `{healthy, summary, findings[]}`.
- **Script** — `cd backend && python scripts/data_doctor.py` (all workspaces),
  `--org-id N` to scope, `--json` for machine output. Exits non-zero when any
  error-severity finding exists, so a cron/CI can gate on it.

Both only SELECT. Neither writes. Neither deletes (scheduling-invariants R7).

Each finding carries `code`, `severity` (error/warn/info), `table`, `message`,
`count`, `sample_ids` (capped at 25, `truncated` flag), `suggestion`, and
`destructive` — the last one only *labels* which fix would remove data; the scan
never does it.

| code | meaning | fix path |
|---|---|---|
| `orphan_job_property` / `orphan_job_client` / `orphan_job_quote` | a Job's FK points at a row that's gone | relink, or remove the job through the UI |
| `orphan_quote_client` / `orphan_quote_property` | a Quote's FK dangles | relink via the Quoting UI |
| `orphan_property_client` / `orphan_invoice_client` / `orphan_opportunity_client` / `orphan_lead_client` | the parent record is gone | relink or remove |
| `job_no_property` / `property_no_client` / `quote_no_client` | NULL in a column the model marks NOT NULL (prod schema drift) | set the missing link |
| `quote_negative_money` / `invoice_negative_money` / `job_negative_price` / `opportunity_negative_amount` | a money value is < 0 | correct the amount |
| `quote_total_mismatch` / `invoice_total_mismatch` | stored total ≠ subtotal + tax − discount | re-save to recompute, or fix the line items |
| `quote_expired_still_open` | past `valid_until` but still `sent`/`viewed` | let it expire, or re-quote |
| `job_past_not_closed` | dated in the past but still open (not completed/cancelled) | complete or cancel it |
| `duplicate_client_email` / `duplicate_client_phone` | one contact, two client rows | ⚠️ merge (`scripts/merge_duplicate_clients.py` or the Clients UI) |
| `null_org_rows` | legacy rows with no workspace (all-workspaces sweep only) | fine single-workspace; backfill before onboarding a second |
| `scan_check_failed` | a check errored and was skipped — a bug in the scan, not your data | report it |

## Facts that shape the checks (don't re-derive)

1. **Money is float dollars across the whole app**, not integer cents. That's a
   known, app-wide convention and is **out of scope** to change here — so the
   scan never flags "wrong type"; it flags *wrong values* (negative money,
   totals that don't add up). Don't "fix" this by proposing a cents migration
   unless the owner asks.
2. **Dates are compared against `business_today()`** (Maine-local), never the
   server's UTC date — otherwise a late-evening row reads as tomorrow and every
   date check false-positives. Reuse that helper for any new date check.
3. **Prod schema has drifted** from the models in known places (`Job.property_id`,
   `Property.client_id` can be NULL despite NOT NULL). The missing-required
   checks exist precisely because of that; treat model constraints as
   aspirational when reasoning about prod rows.
4. **Scope is NULL-org-tolerant.** A scoped scan (`org_id` set) matches that org
   *plus* legacy NULL-org rows, exactly like the app's own queries. The
   `null_org_rows` check only runs on an all-workspaces sweep.

## Extending it

Add a check as a `_check_*(db, org_id, findings)` function in
`backend/services/data_doctor.py` and append it to `_CHECKS`. Keep it read-only,
scope its primary table with `_org_filter`, cap samples, and give it a clear
`suggestion`. Cover it in `backend/tests/test_data_doctor.py` (it globs into CI
via `tests/`). Never put query logic in the router (scheduling-invariants R6) —
the endpoint is a one-liner that calls the service.

## Rules

- The scan never writes; every fix goes through the normal endpoints with a
  human confirm. Bulk fixes: propose the exact list (ids + before/after) and
  wait for approval.
- Merging duplicate clients and deleting rows are destructive — ⚠️-flag them and
  get explicit confirmation.
- Recurring-series problems are recurring-doctor's, not yours.
