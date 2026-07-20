# Requests inbox + client/property dedup (Twenty-style)

Date: 2026-07-20

## Why

The app was generating duplicate **clients** and **properties**. The root
cause was the intake write path: every inbound website request auto-created a
Client, a Property, *and* an Opportunity. A returning customer, a typo'd email,
a second phone number, or a fuzzy match that just missed each spawned a fresh
set of records.

We now model requests the way Twenty CRM (and Linear) model inbound work: a
**Request is an inbox item**. It is not a customer until a human says so.
Properties are — and always were — **nested under a Client** (`Property.client_id`,
cascade delete); the change is *when* those records get created.

## What changed

### 1. Inbound requests are inbox-only

`modules/intake/normalize.py :: upsert_lead` now creates **only** a `LeadIntake`
row. It does **not** create or mutate a Client, Property, or Opportunity.
Lead-level dedup still runs so one website visit that hits two endpoints
collapses into a single request:

- idempotency-key short-circuit (deterministic, cross-endpoint),
- a per-contact advisory lock (concurrent-race backstop), and
- a 5-minute recency merge that back-fills missing fields.

A brand-new request has `client_id = NULL` until staff convert it.

### 2. Conversion is the single dedup gate

A request becomes a customer only through an explicit staff action. Both paths
share `modules/intake/router.py :: _resolve_client_for_intake`, which:

1. uses the already-linked client if `intake.client_id` is set, else
2. reuses an existing client matched on email/phone
   (`find_client_by_contact`, which also searches the multi-value
   `contact_emails` / `contact_phones` tables), else
3. creates a new `lead` client.

It also records the request's email/phone on the resolved client so the *next*
request from the same person dedups to it. Property attachment
(`_resolve_property_for_intake`) reuses an existing property at the same
normalized `(street, city, state, zip)` key instead of adding a duplicate.

- `POST /api/intake/{id}/convert-to-client` — promote to a Client (+ property,
  + pipeline deal) without a quote. Idempotent. Surfaced in the Requests UI as
  **Convert to client**.
- `POST /api/intake/{id}/convert-to-quote` — unchanged entry point, now routed
  through the same dedup-or-create resolver.

### 3. Property creation is idempotent

`POST /api/properties` returns the existing property when the same client
already has one at the same normalized address, so a double-submit or re-add
can't create a duplicate.

## Cleaning up existing duplicates (dry-run first)

Two offline scripts find and merge duplicates. **Both default to a dry run** —
they print the merge plan and change nothing. Re-run with `--commit` to apply.
Run the client merge first (properties are keyed per client, so collapsing
duplicate clients first gives the property pass the correct grouping).

```bash
cd backend

# 1. Preview duplicate CLIENTS (same normalized email or last-10 phone, per org)
python scripts/merge_duplicate_clients.py

# 2. Preview duplicate PROPERTIES (same client + normalized address)
python scripts/merge_duplicate_properties.py

# When the plans look right, apply — clients first, then properties:
python scripts/merge_duplicate_clients.py --commit
python scripts/merge_duplicate_properties.py --commit
```

Both scripts keep the **oldest** row as the keeper, repoint every foreign-key
table (discovered generically via the SQLAlchemy inspector, so new FK tables
are handled automatically), and delete the duplicates. The property merge also
back-fills any size fields (bedrooms/bathrooms/square_footage) the keeper was
missing from a duplicate, so no captured detail is lost.

> Run these against a backup/branch first if you can. `--commit` deletes rows.

## Tests

- `tests/test_intake_fidelity.py` — inbox-only contract + conversion dedup.
- `tests/test_intake_property_and_contact_lock.py` — conversion-layer property
  dedup (same address → one property; different city → two) + lock keys.
- `tests/test_canonical_contacts.py` — contacts populated at conversion.
- `tests/test_request_inbox_dedup.py` — convert-to-client create/reuse,
  idempotency, `create_property` dedup, and property-merge grouping.
