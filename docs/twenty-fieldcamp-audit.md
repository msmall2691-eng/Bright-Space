# Audit + Implementation Plan: BrightBase aligned to Twenty CRM + FieldCamp

Date: 2026-04-15  
Canonical status: merged (no conflict markers); this is the source version.

## Executive Summary

BrightBase already has strong vertical foundations (lead intake, quote-to-job, dispatch/scheduling, invoicing, comms).
To align tightly with a **Twenty CRM + FieldCamp** positioning, the main gaps are:

1. Data normalization (typed dates/times, explicit lifecycle states, external IDs)
2. Opportunity-centric sales model (currently intake-centric)
3. SLA/automation orchestration
4. Persona-driven navigation (CRM vs field-ops)

## Current-State Findings

### Schema
- Core entities are present and connected (`Client`, `LeadIntake`, `Quote`, `Job`, `Invoice`, `Property`, `RecurringSchedule`).
- Main risks: string-based temporal fields, unconstrained statuses, partial sync metadata, limited audit fields.

### Workflows
- Existing booking/webhook → quote → conversion flow is strong.
- Main risks: no first-class `Opportunity`, duplicated intake normalization paths, no structured SLA engine.

### Menu / IA
- Existing module IA works, but pipeline discoverability and operations urgency are weaker than target.

## Target Architecture

- **Lead** (`LeadIntake`) = inbound intent
- **Opportunity** (new) = sales pipeline object
- **WorkOrder** (`Job`) = execution object
- **Invoice** = billing object

Canonical stages:
- Opportunity: `new`, `qualified`, `quoted`, `negotiation`, `won`, `lost`
- WorkOrder: `planned`, `assigned`, `en_route`, `in_progress`, `completed`, `cancelled`
- Invoice: `draft`, `sent`, `partially_paid`, `paid`, `overdue`, `void`

## Priority Upgrades

### P0
- Centralize lifecycle constants + validation.
- Add `updated_at` on mutable entities.
- Add sync metadata (`external_ids`, `sync_status`, `last_synced_at`, `sync_error`).

### P1
- Normalize key temporal fields to date/datetime types.
- Introduce `Opportunity` model + stage transitions.

### P2
- SLA automation worker and post-job retention loop.
- Event log table for replay/audit analytics.

## Mapping Guide (Internal → Twenty / FieldCamp)

- `Client` → Contact/Company / Customer
- `Opportunity` (new) → Opportunity/Deal / Estimate candidate
- `Job` → activity timeline / Work order
- `Invoice` → revenue outcome / Invoice-payment object

## Workflow Implementation Plan

1. Build shared `normalize_inbound_lead(payload, source)` service and route all intake channels through it.
2. Auto-create `Opportunity(stage='new')` when lead intake is created.
3. Add SLA triggers:
   - new lead > 15m no review
   - reviewed > 24h no quote
   - accepted quote > 24h no scheduled job
   - completed job > 2h no invoice
4. Add post-completion follow-up automation.

## Menu / IA Direction

### Desktop
- CRM: Leads, Pipeline, Clients, Comms
- Operations: Today, Schedule, Dispatch, Recurring, Properties
- Revenue: Quotes, Invoices, Payments
- Admin: Settings, Integrations, Custom Fields

### Mobile
- Today, Pipeline, Schedule, Clients, More

## 30-Day Rollout

- **Week 1**: lifecycle constants + sync metadata + migrations
- **Week 2**: Opportunity model + intake normalization consolidation
- **Week 3**: SLA worker + alerts
- **Week 4**: IA rollout + KPI cards

## Immediate Next 5 Tasks

1. Add lifecycle constants module and validate writes in intake/quote/job routes.
2. Add migration for `updated_at` + sync metadata.
3. Introduce shared inbound-lead normalizer.
4. Add `Opportunity` model + CRUD + stage transitions.
5. Finalize nav labels with Pipeline/Today as first-class destinations.
