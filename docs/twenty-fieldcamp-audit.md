# Audit + Implementation Plan: BrightBase aligned to Twenty CRM + FieldCamp

Date: 2026-04-15
Scope reviewed:
- Data schema/models (`backend/database/models.py`)
- Intake/booking workflow routers (`backend/modules/booking/router.py`, `backend/modules/intake/router.py`)
- Workflow test coverage (`backend/test_pipeline.py`, `backend/test_maineclean_workflow.py`)
- Navigation/menu IA (`frontend/src/components/Sidebar.jsx`, `frontend/src/components/BottomNav.jsx`, `frontend/src/App.jsx`)

---

## Executive Summary

You already have a strong vertical foundation (lead intake -> quoting -> scheduling -> invoicing). To match a **Twenty CRM + FieldCamp** positioning, the implementation gap is mostly in:

1. **Data normalization** (typed date/time, explicit lifecycle states, external IDs)
2. **Opportunity-centric sales model** (currently intake-centric)
3. **Automation and SLA orchestration** (currently manual status transitions)
4. **Persona-driven navigation** (currently module-driven)

This document now includes:
- a **target data model**,
- **field mapping** for Twenty + FieldCamp alignment,
- **concrete API/workflow changes**,
- **menu changes**,
- **phased rollout plan with deploy gates**.

---

## 1) Current-State Findings

## 1.1 Schema findings (what exists)

Strengths:
- Core entities exist and are logically connected: `Client`, `LeadIntake`, `Quote`, `Job`, `Invoice`, `Property`, `RecurringSchedule`, custom fields.
- Existing relationship design supports residential/commercial/STR operations.

Issues:
- Multiple scheduling and deadline fields are stored as strings, limiting timezone-safe operations and reporting.
- Lifecycle status values are unconstrained text, creating drift risk across endpoints/UI.
- External system synchronization metadata is partial and inconsistent.
- Missing `updated_at` on important mutable entities.

## 1.2 Workflow findings (what exists)

Strengths:
- Website booking path and webhook path are both implemented.
- End-to-end quote conversion path has automated test coverage.

Issues:
- No first-class `Opportunity` lifecycle for sales pipeline management.
- Intake normalization exists in two route flows (booking submit + webhook), increasing duplicate logic risk.
- SLA automation is not formalized (lead response, quote follow-up, post-job tasks).

## 1.3 Menu/IA findings (what exists)

Strengths:
- Desktop sidebar has clear module categories.
- Mobile has focused tabs for primary actions.

Issues:
- “Pipeline” is not a first-class primary destination.
- Mobile lacks direct access to dispatch exceptions.
- CRM persona and field-ops persona are mixed in a single flow.

---

## 2) Target Architecture (Recommended)

## 2.1 Canonical lifecycle objects

- **Lead** (`LeadIntake`) = inbound inquiry/contact intent
- **Opportunity** (new entity) = deal progression and value
- **WorkOrder** (`Job`) = operational execution
- **Invoice** = billing artifact

### Opportunity stages (canonical)
`new`, `qualified`, `quoted`, `negotiation`, `won`, `lost`

### WorkOrder stages (canonical)
`planned`, `assigned`, `en_route`, `in_progress`, `completed`, `cancelled`

### Invoice stages (canonical)
`draft`, `sent`, `partially_paid`, `paid`, `overdue`, `void`

---

## 3) Data Model Upgrades (Implementable)

## 3.1 Add strict lifecycle constants (P0)

Create shared constants for status/type values and apply validation at router boundaries.

- Backend: central constants module + pydantic field validation
- Frontend: reuse same values for filters/badges/boards

## 3.2 Add audit metadata (P0)

Add to mutable entities:
- `updated_at` (auto-touch on update)
- optional `created_by` / `updated_by` (future-ready)

## 3.3 Add integration metadata (P0)

On `Client`, `Opportunity`, `Quote`, `Job`, `Invoice`:
- `external_ids` (JSON)
- `sync_status` (`pending`/`synced`/`error`)
- `last_synced_at` (datetime)
- `sync_error` (text, nullable)

## 3.4 Normalize temporal fields (P1)

Replace string date/time fields with typed date/datetime where possible.
Examples:
- `Job.scheduled_date` -> `Date`
- `Job.start_time`/`end_time` -> `DateTime` (or `Time` + timezone policy)
- `Invoice.due_date` -> `Date`

## 3.5 Add Opportunity entity (P1)

Suggested columns:
- `id`, `client_id`, `lead_intake_id`
- `title`, `stage`, `expected_value`, `probability`
- `next_action_at`, `owner_id`, `loss_reason`
- `source`, `created_at`, `updated_at`

---

## 4) Twenty CRM + FieldCamp Mapping Matrix

## 4.1 Contact/Customer

- Internal: `Client`
- Twenty equivalent: Contact/Company
- FieldCamp equivalent: Customer

Recommended mapping:
- `Client.name` -> display name
- `Client.email`/`phone` -> primary contact channels
- `Client.address*` -> service + billing address fields
- `Client.external_ids.twenty_contact_id`
- `Client.external_ids.fieldcamp_customer_id`

## 4.2 Opportunity/Deal

- Internal target: `Opportunity` (new)
- Twenty equivalent: Opportunity/Deal
- FieldCamp equivalent: Estimate/Job candidate (depending on workflow)

Recommended mapping:
- `Opportunity.stage` -> pipeline stage
- `Opportunity.expected_value` -> weighted forecast
- `Opportunity.external_ids.twenty_opportunity_id`

## 4.3 Work execution

- Internal: `Job`
- Twenty equivalent: related activity/task timeline
- FieldCamp equivalent: Work order / service job

Recommended mapping:
- `Job.status` + milestone timestamps
- `Job.cleaner_ids` -> assigned technicians
- `Job.external_ids.fieldcamp_job_id`

## 4.4 Billing

- Internal: `Invoice`
- Twenty equivalent: revenue record/opportunity outcome
- FieldCamp equivalent: invoice/payment object

Recommended mapping:
- `Invoice.status`, `due_date`, `paid_at`
- `Invoice.external_ids.fieldcamp_invoice_id`

---

## 5) Workflow Implementation Changes

## 5.1 Consolidate intake normalization (P0)

Current state: both `/api/booking/submit` and `/api/intake/webhook` normalize inbound payloads.

Implement:
- New shared service: `normalize_inbound_lead(payload, source)`
- Both routes call same service
- Unit tests cover both payload formats against same normalized output

## 5.2 Introduce Opportunity pipeline (P1)

On lead creation:
1. Create/attach `Client`
2. Create `LeadIntake`
3. Auto-create `Opportunity(stage='new')`
4. Route UI pipeline board to Opportunity stage transitions

## 5.3 Add SLA automation worker (P1)

Rules:
- New lead > 15 minutes without review -> alert
- Reviewed lead > 24h without quote -> task/escalation
- Accepted quote > 24h without scheduled job -> dispatch queue warning
- Completed job > 2h without invoice -> auto-generate invoice draft

## 5.4 Post-job retention loop (P2)

After `Job.status=completed`:
- Trigger review request message
- Create follow-up task at +14 days
- Create upsell/cross-sell opportunity for applicable accounts

---

## 6) Menu/IA Implementation Changes

## 6.1 Desktop navigation (recommended)

### CRM
- Leads
- Pipeline
- Clients
- Comms

### Operations
- Today
- Schedule
- Dispatch
- Recurring
- Properties

### Revenue
- Quotes
- Invoices
- Payments

### Team/Admin
- Team
- Payroll
- Settings
- Integrations
- Custom Fields

## 6.2 Mobile navigation (recommended)

Primary tabs:
1. Today
2. Pipeline
3. Schedule
4. Clients
5. More

In “More”:
- Dispatch
- Quotes
- Invoices
- Settings

---

## 7) Rollout Plan (Deploy-Oriented)

## Phase 1 (Week 1)
- Add lifecycle constants + validation
- Add `updated_at`, `external_ids`, `sync_status`, `last_synced_at`, `sync_error`
- Add DB migration + backfill defaults

Exit criteria:
- Existing tests pass
- New migration passes on staging snapshot

## Phase 2 (Week 2)
- Add Opportunity model + API
- Update pipeline UI to Opportunity stages
- Consolidate intake normalization service

Exit criteria:
- Lead creation auto-generates Opportunity
- Pipeline board uses Opportunity stages only

## Phase 3 (Week 3)
- Add SLA worker jobs
- Add escalation messaging/events

Exit criteria:
- SLA scenarios generate deterministic tasks/alerts in test env

## Phase 4 (Week 4)
- Apply menu IA redesign desktop/mobile
- Add KPI cards (response time, win rate, on-time dispatch, DSO)

Exit criteria:
- Navigation telemetry shows reduced click depth to core journeys

---

## 8) Definition of Done for “Twenty + FieldCamp ready”

- All core entities have typed time fields, normalized statuses, and sync metadata.
- Opportunity pipeline exists and is the source of truth for sales stages.
- Dispatch/job lifecycle has explicit milestone states and SLA automation.
- Menu supports two primary personas: sales (CRM) and field operations (FSM).
- Integration mappings are documented and testable per object.

---

## 9) Immediate Next 5 Tasks

1. Add lifecycle constants module and validate status writes in intake/quote/job routes.
2. Create migration adding `updated_at` and `external_ids` to `Client`, `Quote`, `Job`, `Invoice`, `LeadIntake`.
3. Build `normalize_inbound_lead()` service and refactor booking + webhook routes to call it.
4. Add `Opportunity` model + CRUD + stage transition endpoint.
5. Update sidebar/mobile nav labels to surface Pipeline and Today as first-class destinations.

