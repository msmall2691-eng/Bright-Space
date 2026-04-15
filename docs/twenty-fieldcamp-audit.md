# Audit: Schema, Workflows, and Menus for Twenty CRM + FieldCamp Alignment

Date: 2026-04-15

## Executive Summary

This codebase is already close to a **cleaning-service vertical CRM/operations stack**. It has:
- a lead intake pipeline,
- quote-to-job conversion,
- dispatch/scheduling primitives,
- invoice and comms modules,
- extensible custom fields.

However, if your target positioning is **“Twenty CRM + FieldCamp in one product”**, there are three structural gaps:

1. **Schema consistency & interoperability**
   - Several temporal and status fields are stringly typed (`scheduled_date`, `start_time`, `due_date`) rather than normalized date/time types.
   - Status/state enums are implicit comments, not constrained in database or shared constants.
   - Multi-system identity fields for external CRMs/FSMs are sparse.

2. **Workflow orchestration completeness**
   - Current workflows are strong for lead -> quote -> job, but lack explicit opportunity/deal stages, SLA timers, and post-service looping (follow-up tasks, NPS, rebooking).
   - Booking/intake has two entrypoints with partially duplicated normalization logic.

3. **Navigation IA for blended CRM + FSM**
   - Menus are module-centric, but not task-journey-centric for sales and field ops personas.
   - Mobile nav emphasizes current operations only (home/requests/schedule/clients/invoicing), omitting quick access for pipeline/deals and dispatch exceptions.

---

## 1) Schema Audit

## Current strengths

- Good core entities: `Client`, `LeadIntake`, `Quote`, `Job`, `Invoice`, `Property`, `RecurringSchedule`, `FieldDefinition`, with relationships that support residential/commercial/STR use cases.
- `custom_fields` and `field_definitions` provide extensibility for CRM-style custom objects and service metadata.

## Risks / Gaps vs Twenty + FieldCamp style

1. **Date/time as strings**
   - `Job.scheduled_date`, `Job.start_time`, `Job.end_time`, `Invoice.due_date`, and others are `String` fields.
   - This complicates timezone-safe scheduling, SLA calculations, and calendar interoperability.

2. **Implicit enums and inconsistent labels**
   - Status and type values are comments and free-text values in multiple models (`Client.status`, `LeadIntake.status`, `Quote.status`, `Job.status`, `Job.job_type`), increasing drift risk.

3. **External sync keys are incomplete**
   - You have `Job.gcal_event_id` and `connecteam_shift_ids`; this is a good start.
   - For Twenty CRM + FieldCamp interoperability, most first-class objects should have optional external IDs (e.g., `twenty_contact_id`, `twenty_opportunity_id`, `fieldcamp_job_id`, `fieldcamp_customer_id`) and `last_synced_at` markers.

4. **Data governance / audit metadata**
   - Core tables have `created_at`, but not always `updated_at`, `created_by`, `updated_by`, `deleted_at` soft-delete support.
   - This limits admin auditability and conflict resolution in sync scenarios.

## Recommended schema upgrades (priority order)

### P0
- Introduce shared enum constants (application-level first, DB constraints next) for all lifecycle statuses.
- Add `updated_at` to mutable core entities.
- Add external-system identity columns + `sync_status` + `last_synced_at` on client/intake/quote/job/invoice.

### P1
- Move key scheduling and finance deadlines to proper datetime/date columns.
- Add `organization_id` (tenant partitioning) if multi-company is planned.

### P2
- Add event log table (`entity_type`, `entity_id`, `event_type`, `payload`, `occurred_at`) for deterministic workflow replay/analytics.

---

## 2) Workflow Audit

## What works today

- Robust tested pipeline: website booking submit -> intake -> reviewed -> quote -> accepted -> convert to job.
- Webhook compatibility for intake payload variants.
- Basic channel sending for quotes (email/SMS) and mocked e2e coverage for communications.

## Gaps vs Twenty CRM + FieldCamp expectations

1. **Opportunity/deal abstraction missing**
   - `LeadIntake` functions as top-of-funnel, but there is no explicit `Opportunity` object with stage progression and value forecasting.

2. **Workflow duplication risk**
   - `/api/booking/submit` and `/api/intake/webhook` both normalize incoming lead data in parallel paths.

3. **No explicit SLA/automation layer**
   - Missing structured triggers like: “new lead not reviewed in 15 min,” “accepted quote not scheduled in 24h,” “job completed but invoice unsent after 2h.”

4. **Post-job CRM loop not formalized**
   - No first-class retention sequence (follow-up task, review request, upsell opportunity creation, rebook cadence).

## Recommended workflow architecture

### Sales (Twenty-like)
1. Lead capture (`LeadIntake`) -> qualification task
2. Convert to Opportunity
3. Stage pipeline: `new`, `qualified`, `quote_sent`, `negotiation`, `won`, `lost`
4. `won` triggers job template/schedule draft + customer onboarding checklist

### Field Operations (FieldCamp-like)
1. Job planned -> dispatch assignment
2. Technician en-route/start/complete timestamps
3. Completion checklist + attachments + service notes
4. Auto invoice draft on completion
5. Payment + follow-up automation

### Cross-cutting automation
- Rule engine table or queued worker process for time-based transitions and reminders.

---

## 3) Menu / IA Audit

## Current menu observations

Desktop sidebar is grouped as:
- Dashboard/Workspace
- Clients: Clients, Requests, Quoting, Invoicing, Comms
- Scheduling: Schedule, Recurring, Properties
- Team: Dispatch, Payroll
- System: Settings

Mobile nav includes only 5 primary tabs:
- Home, Requests, Schedule, Clients, Invoicing

## IA concerns for target positioning

1. **Pipeline discoverability**
   - Pipeline/deal management is not represented as a first-class nav concept (route alias exists, but no dedicated IA signal).

2. **Dispatch urgency flow on mobile**
   - Field operations leaders need one-tap access to dispatch exceptions/overdue jobs; mobile tabs omit dispatch.

3. **CRM vs FSM persona switching**
   - Mixed module grouping may cause context switching friction.

## Suggested menu redesign

### Desktop
- **CRM**: Leads/Requests, Pipeline, Clients, Comms
- **Operations**: Calendar, Dispatch, Recurring, Properties
- **Revenue**: Quotes, Invoices, Payments
- **Team**: Payroll, Tech performance
- **Admin**: Settings, Custom Fields, Integrations

### Mobile
Primary tabs:
1. Today (ops command center)
2. Pipeline (sales)
3. Schedule
4. Clients
5. More (Quotes, Invoices, Dispatch, Settings)

---

## 4) Suggested 30-Day Execution Plan

### Week 1
- Define canonical lifecycle enums + shared constants.
- Add `updated_at` and external ID columns.
- Create integration mapping document for Twenty and FieldCamp objects.

### Week 2
- Consolidate intake normalization into one service function used by booking + webhook routes.
- Introduce opportunity entity and migrate request board to opportunity stage view.

### Week 3
- Implement automation jobs for SLA timers and follow-ups.
- Add post-completion workflow (invoice draft + review request).

### Week 4
- Rework menu IA desktop/mobile.
- Add KPI dashboard cards for lead response time, quote acceptance rate, dispatch on-time rate, DSO.

---

## 5) Quick Wins You Can Ship Immediately

1. Make “Pipeline” a first-class named destination in nav (not only route aliasing).
2. Add `updated_at` to every mutable table and populate in update endpoints.
3. Centralize status values in one constants module used by backend + frontend.
4. Add `external_ids` JSON object per major entity to unblock connectors quickly.
5. Add one “stuck workflow” cron check: reviewed intake older than 24h with no quote.

