# Claude Code: PR 1 + PR 2 instructions for Bright-Space

**Branch:** create `claude/pr1-wiring-fixes` off `main`
**Goal:** ship the P0 fixes from `docs/audit-2026-05-04.md` so Megan's Lindsey workflow actually works end to end.

---

## Step 0 — Confirm starting state on a fresh deploy

Trigger a Railway redeploy of `main` first. Then sanity-check the live app at `https://brightbase-production.up.railway.app`:

1. Open `/properties?type=str` → click Edit on **The Pier House**.
2. Inspect the side panel. Is there a "Calendar URLs" or "iCal" section?
   - **If yes:** the previous deploy was stale. Skip Task 1 below — it's already done. Move to Task 2.
   - **If no:** there's a real conditional-render bug. Continue with Task 1.

---

## Task 1 — Make sure the iCal section actually renders for STR properties

**File:** `frontend/src/pages/Properties.jsx`

The "Calendar URLs" block exists in the source but does not render on prod for The Pier House (which is type STR). Find the gate that controls whether the section shows. Look for something like:

```jsx
{property.property_type === 'str' && (
  <Section title="Calendar URLs">...</Section>
)}
```

The most likely failures:

- The API is returning `'STR'` (uppercase) and the gate compares against `'str'` (lowercase), or vice versa.
- The gate uses a stale `propertyType` prop that's not refreshed when a property is loaded into the edit drawer.
- The section is rendered but hidden via Tailwind (`hidden`, `sr-only`, `opacity-0`) due to a stuck state.

Fix: normalize the comparison with `(property.property_type || '').toLowerCase() === 'str'` and confirm the section is in the DOM by adding a temporary `data-testid="ical-feeds-section"` so the acceptance test can assert on it.

**Acceptance:** open The Pier House → Edit → the "Calendar URLs" section is in the DOM. Empty state OK if no feeds exist; existing feeds should list with `url`, `source`, `checkout_time`, `house_code`, and `last_synced_at` if present.

---

## Task 2 — Wire client-profile action buttons to pass `client_id`

**File:** `frontend/src/pages/ClientProfile.jsx`

Currently `Schedule Job`, `Recurring Schedule`, and `New Quote` on the client profile call `navigate('/schedule')` (or equivalent) with no state. They should open the same modal `Schedule.jsx` uses, pre-filled with the active client.

For each of the three buttons:

1. Replace the navigate call with `setJobModalOpen(true)` (add the state if it doesn't exist).
2. Render `<JobEditModal />` (or whatever component the schedule page uses) inside `ClientProfile.jsx` with:

```jsx
<JobEditModal
  open={jobModalOpen}
  onClose={() => setJobModalOpen(false)}
  initialClientId={client.id}
  initialPropertyId={null}
  mode="schedule_job"  // or "recurring", or "new_quote"
/>
```

3. Inside `JobEditModal`, the property dropdown must filter by `client_id` when `initialClientId` is set:

```ts
const properties = useProperties({ client_id: initialClientId });
```

If `useProperties` doesn't accept that filter, add it — the backend already supports `GET /api/properties?client_id={id}` (verify in `backend/modules/properties/router.py`).

**Acceptance:** on Lindsey Gauthier's profile, clicking Schedule Job opens a modal where Client = "Lindsey Gauthier" is pre-selected and the Property dropdown only contains her properties (or empty if she has none).

---

## Task 3 — Add a Properties tab to ClientProfile.jsx

**File:** `frontend/src/pages/ClientProfile.jsx`

Insert a new tab between Overview and Schedule. It renders a list of properties owned by this client.

```jsx
<TabPanel id="properties">
  <ClientPropertiesList clientId={client.id} />
</TabPanel>
```

`ClientPropertiesList` should:

- Call `GET /api/properties?client_id={id}`.
- Render rows with: property name, address, type pill (`residential` / `commercial` / `str`), iCal-status pill (only for STR), and actions: `+ Job` (opens `JobEditModal` pre-filled with `client_id` + `property_id`) and `Edit` (opens the existing property edit drawer).
- Empty state: a card with `+ Add Property` that opens the property modal pre-bound with `initialClientId={client.id}`.

**Acceptance:** Lindsey's profile has a Properties tab. Clicking `+ Add Property` opens the property modal with Client = Lindsey already selected — no dropdown of 54 clients to scroll through.

---

## Task 4 — Dual-write idempotency fix (the orphan-visit cleanup is already done)

> **UPDATE 2026-05-04:** The orphan-visit cleanup was completed in production by Megan + Claude during a tail-the-logs session. Coverage is now `100% (70/70), healthy: true`. **The remaining work in this task is the dual-write fix below**, which is now urgent (not optional) because without it the same orphan pattern recurs every time someone bulk-creates jobs.

### Status as of 2026-05-04

- `POST /api/jobs/admin/rehydrate-job-dates-from-gcal`: ran live, 63 jobs updated from their linked GCal events, `errors: []`.
- `POST /api/visits/admin/backfill-visits-from-jobs`: ran live, `created: 69, skipped: 1, errors: []`, ~6s.
- `GET /api/visits/admin/coverage-check`: `coverage_percent: 100, healthy: true`.
- Verified API contracts (corrections to the original audit) are documented in `docs/audit-2026-05-04-addendum.md`. Notably: rehydrate silently ignores `dry_run`/`limit`; backfill accepts no parameters at all.

### Dual-write fix

In `backend/modules/scheduling/router.py`, the create-job handler currently inserts a `Job` row and then inserts its primary `Visit` row in the same handler without an idempotency key. If the second insert fails, the Job is orphaned. That's exactly how 69 orphans accumulated before this session.

**Required change:**

1. Extract the dual-write into a single service function in a new (or existing) services module:

```python
# backend/modules/scheduling/services.py
def create_job_with_primary_visit(
    db: Session,
    payload: JobCreate,
    *,
    idempotency_key: str | None = None,
) -> Job:
    """Create a Job and its primary Visit atomically.
    Idempotent: if idempotency_key was used before, return the existing Job.
    """
    if idempotency_key:
        existing = db.query(Job).filter(Job.idempotency_key == idempotency_key).first()
        if existing:
            return existing

    with db.begin_nested():  # savepoint so partial failures don't orphan
        job = Job(**payload.dict(), idempotency_key=idempotency_key)
        db.add(job)
        db.flush()
        visit = Visit(
            job_id=job.id,
            scheduled_date=job.scheduled_date,
            start_time=job.start_time,
            end_time=job.end_time,
            status=job.status or "scheduled",
            cleaner_ids=job.cleaner_ids or [],
            gcal_event_id=job.gcal_event_id,
            notes=job.notes,
        )
        db.add(visit)
    db.commit()
    return job
```

2. Add `Job.idempotency_key` (nullable text + unique index) via Alembic migration.

3. Replace the inline dual-write in the existing `create_job` route handler with a call to this service function. Pass `idempotency_key` from a request header (`Idempotency-Key`) when present, falling back to `None`.

4. Move the GCal sync call to *after* the transaction commits, so a GCal API failure can't leave a Job + Visit with no calendar entry. Queue a follow-up task that retries GCal sync independently.

### Acceptance

- The `VISITS COVERAGE DRIFT` startup self-diagnostic in deploy logs does not reappear over a week of normal usage.
- `GET /api/visits/admin/coverage-check` stays at `coverage_percent: 100, healthy: true`.
- A unit/integration test creates a Job, simulates an exception during Visit insertion, and confirms the savepoint rolled the Job back so no partial row remains.

---

## Task 5 — Surface (don't fix) two new data-quality issues

These came up while spot-checking the residential list. Don't fix them in this PR — just add them to a `KNOWN_DATA_ISSUES.md` (or extend the audit doc) so they're tracked:

- **Duplicate property: Casey Allison.** Two rows on `/properties?type=residential` for the same Falmouth address — `17 Oakmont Dr, Falmouth, ME 04105, USA` and `17 Oakmont Drive, Falmouth, ME`. Recommended action: merge keeping the row with the ZIP, after verifying both don't have separate jobs attached. Owner: Megan to decide which to keep.
- **Properties with placeholder client names.** Several rows show `Client #58`, `Client #45`, `Client #60` instead of an actual client name. The client_id FK is intact but either the client record has no `name` set or the property→client join isn't pulling the name field. Check `backend/modules/properties/router.py` serializer and confirm `client.name` is populated for those IDs.

---

## Final acceptance test (Lindsey's actual workflow)

After merging both PRs, walk through this end to end:

1. Go to `/clients` → search "Lindsey" → open her profile.
2. Click the new **Properties** tab → see the empty state with `+ Add Property`.
3. Click `+ Add Property` → property modal opens with Client = Lindsey already pre-selected. Choose Residential. Enter `123 Test Lane, Scarborough`. Save.
4. From the new property row, click `+ Job` → JobEditModal opens with Client = Lindsey and Property = 123 Test Lane both pre-selected. Choose `recurring_clean`. Save.
5. Confirm: a GCal event exists for that job, a `visits` row exists, and `coverage-check` still reports ≥95%.
6. Add a second property for Lindsey, type STR. Open Edit → confirm the **Calendar URLs** section is visible. Paste a test Airbnb iCal URL. Save.
7. Wait for the cron (or trigger sync manually) → confirm new turnover visits appear on `/schedule` linked to that property.

If all 7 steps work without ever bouncing back to the global Properties page or having to re-pick Lindsey from a dropdown — the Lindsey workflow is fixed.

---

## Out of scope for this PR pair

- Two-way GCal sync via `events.watch` webhook (audit P1 #6) — separate PR.
- Twenty-CRM-style Activity timeline (audit P1 #7) — separate PR.
- Property detail page with iCal feed manager (audit P1 #9) — separate PR.
- Code-cleanup items P2 #2–5 — separate PR or backlog.

---

# Megan's review checklist before merging PR 1

- [ ] STR Calendar URLs section visible on The Pier House.
- [ ] Schedule Job on Lindsey's profile pre-fills her name without me touching the dropdown.
- [ ] New Properties tab on Lindsey's profile.
- [ ] Residential tab still shows 9 rows (regression check).
- [ ] No new console errors on the existing Schedule and Properties pages.
