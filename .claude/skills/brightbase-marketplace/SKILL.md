---
name: brightbase-marketplace
description: The subcontractor marketplace — the three constraints that are legal rather than stylistic, what is already built, what is deliberately out of scope, and the traps that have already bitten. Load before touching anything under the sub/bench/claim/route/payout surface, before changing who can see an open job, and before anything that looks like matching a job to a person.
---

# The subcontractor marketplace

The Maine Cleaning Co. is moving off payroll onto a closed bench of ~10–20
vetted subcontractors. A cleaner applies through a public form, gets an
account, puts documents on file, sees open jobs, asks for one at a price, and
gets paid per job.

Most of this is built. What follows is the part that is expensive to
rediscover: **which decisions are load-bearing, and why.**

---

## Rule 0: three constraints, and they are legal

These read like product preferences. They are not. Each maps onto a criterion
in the standard Maine judges this arrangement against, and getting one wrong
does not produce a worse UX — it produces an employee.

| Constraint | What it means in code |
|---|---|
| **A sub requests or accepts. The office never assigns.** | No path may put a sub on a job they did not ask for or agree to. |
| **A sub is paid per job, never per hour.** | `Job.agreed_rate` short-circuits the hourly ladder in `modules/payroll/router.py`. Never normalize to $/hr, not even for display. |
| **Availability is a signal, not a schedule.** | `CleanerAvailability` down-ranks. It never blocks, and it never obliges. |

The codebase already says this to itself in the two places it matters most —
believe them:

> *"Offered, never assigned: a route a sub can decline is work they chose…
> load-bearing for contractor classification."* — `models.py`, `Route`

> *"Auto-assign is the employee path… which is precisely what a subcontractor
> arrangement cannot do — a sub requests or accepts, the office never
> assigns."* — `modules/scheduling/router.py`

## The standard these serve

Maine uses **one unified employment standard** across workers' comp,
unemployment and wage & hour. It is often called an ABC test, but it is *not*
the strict California form — "work outside the usual course of the business"
is only one of seven disjunctive criteria, and you need three. **A cleaning
company can legitimately use cleaning subcontractors in Maine.** Do not
re-panic about this.

**Part 1 — all five must hold:**

1. The person controls the means and progress of the work
2. They are customarily engaged in an independently established business
3. They have opportunity for **profit and loss**
4. They hire, pay and supervise their own assistants, if any
5. They make their services available to a client community

**Part 2 — at least three of seven**, of which these are the reachable ones:
not required to work exclusively; contractually responsible for satisfactory
completion; **a written contract defining the relationship**; and **payment
based on the work performed, not solely on time expended**.

Penalty for intentional misclassification: **up to $10,000**.

Where the code sits against Part 1:

- **#1 control** and **#5 availability to others** — satisfied by design, by
  Rule 0. Anything that erodes them is the whole risk.
- **#3 profit and loss** — the counter-offer is this. Keep it.
- **#2 independently established business** — evidence-based; needs documents.
- **#4 own assistants** — **currently a gap.** The app models one cleaner per
  claim. If a sub cannot bring a helper, this is hard to satisfy in fact.

Also live: **Form WCB-267**, Maine's Independent Contractor Statement, filed
with the Workers' Compensation Board, creates a **rebuttable presumption** of
contractor status and is **valid for one year**. That is a document with an
expiry — exactly the shape `SubDocument` already handles.

> Not legal advice, and the standard can change. Re-check maine.gov before
> relying on the specifics; the *shape* of the argument is what this file is
> preserving.

---

## What is built

Migrations 097–104. The chain a person actually walks:

```
public /apply  →  office approves  →  account + set-password invite
      →  documents on file (W-9, COI, agreement)  →  cleared to work
      →  sees open jobs  →  asks, optionally at their own price
      →  office approves the claim  →  does it  →  payout ledger
```

- **Vetting** — `services/sub_vetting.py`. `blocking_requirements` is the one
  gate; `can_take_jobs` is **derived on every call, never cached** ("the cost
  of a stale yes is an uninsured person in a customer's house"). Existing crew
  are grandfathered via the `crew_vetting_enforce_from` setting.
- **Claims** — `JobClaimRequest` is a *request*, not a claim. Several subs can
  hold one on the same job; the office picks. `services/claim_approval.py` is
  the single approve implementation, shared by the office endpoint and the
  auto-approver so they cannot drift.
- **Auto-approve** — `services/claim_autoapprove.py`, **off by default**. It
  refuses on `counter_above_posted`, `over_ceiling`, and `competing_requests`.
- **Money** — `services/sub_payouts.py`. `UNIQUE(user_id, job_id)`, per-row
  savepoints, `void` instead of delete, and the manual rail marks **sent**,
  never **paid**.
- **Turnover ladder** — `services/turnover_windows.py`. Steps are a percentage
  of **base**, deliberately non-compounding; a taken job is never repriced.

---

## Out of scope. Not "later" — out.

- **Any path that assigns a sub to a job they did not request or accept.**
  Including a "smart" one. Including as a tiebreaker.
- **Any path that prices a sub's work by the hour**, including deriving an
  hourly figure for display or comparison.
- **Removing the employee payroll code.** Both models run side by side.
- **Auto-approve as a tiebreaker between competing requests.** `why_not()`
  returns `competing_requests` on purpose; first-come-first-served was
  considered and rejected. A match score here would be the system picking a
  winner.

Ranking and surfacing is fine. **Picking and booking is not.** If a change
makes the app choose the person, stop.

---

## Traps that have already bitten

Every one of these shipped. They are cheap to re-create.

**`Job.property_id` is `NOT NULL`, and generation copies it off the series.**
A recurring series with no property generates *nothing* — each insert trips the
constraint and gets swallowed by the race-safe handler as a "duplicate". Three
live series were silently dead. Never let a constraint failure be logged as a
duplicate.

**`post()` JSON-stringifies its body.** `JSON.stringify(new FormData())` is
`"{}"`. Every document upload 422'd for months, and the test passed because it
mocked `post`. **File uploads use `upload()`; authenticated downloads use
`download()`.** A plain `<a href>` to an API endpoint carries no
`Authorization` header and 401s into a blank tab.

**Being in `TENANT_TABLES` does nothing by itself.** The policy exists where a
migration calls `apply_org_rls()`, and it silently skips tables that do not
exist yet. Sixteen tables sat listed-but-unprotected. **Every new tenant table
calls `apply_org_rls` in the same migration that creates it**, and
`tests/test_migrations_from_scratch.py` asserts the whole list has policies
after the real chain.

**Timestamps are UTC; the dates the business reasons about are Maine-local.**
From 8pm until midnight they disagree by a day. Use
`utils.dates.business_date()` before comparing a stored timestamp against a
business date. This shipped in seven places at once.

**Approval is an account, not clearance.** Anything gated on "is a cleaner"
rather than `blocking_requirements` is open to a stranger who filled in a web
form ten minutes ago.

**An open offer is not a work order.** Access codes, WiFi and notes were always
stripped; the customer's *name and street address* were not. An offer carries
**town, size and rate**. Identity waits until they have won it.

---

## Before you build

1. **Which of the three constraints does this touch?** If none, say so and
   move on. If one, say which and how it stays satisfied.
2. **Who can see it, and are they vetted?** Not "are they logged in".
3. **New tenant table?** `org_id`, `TENANT_TABLES`, `apply_org_rls` in the same
   migration, and a membership test.
4. **Comparing a timestamp to a date?** `business_date()`.
5. **New tick?** No — see `scheduling-invariants` R1. Baseline is 13.
6. **Crew-facing payload?** Rural cell data. See `brightbase-economy`.

---

## Known gaps, as of migration 104

Real, verified, unfixed. Do not rediscover them from scratch.

- **The subcontractor agreement has no text.** `CURRENT_AGREEMENT_VERSION`
  points at no document, no endpoint, no screen. Subs tap "sign" on a version
  string — while Part 2's "a written contract defining the relationship" is one
  of the criteria this arrangement most needs. **Highest-value open item, and
  it is a writing task, not a coding one.**
- **A sub cannot bring a helper** — Part 1 #4.
- **W-9 scans contain SSNs.** The rule "never store SSNs or TINs" is honored in
  the schema and defeated by the file store: a sole proprietor's W-9 has one
  printed on it. Consider pushing W-9 collection to a payments rail that also
  files the 1099-NECs you owe anyone paid $600+.
- **Posting a job notifies nobody.** No push, no SMS. The bench finds out by
  opening the app, and everyone sees the same unranked list.
- **No service radius, rate floor, capability tags or reliability signals.**
  A design for all four exists; the ranking must remain a *recommendation
  ordering on the existing pull*.
- **`services/claim_approval.py` nulls a prior decline's `reason` on
  approval**, so the decline trail is lossy and cannot be repaired
  retroactively. Capture the signal before that write, not after.
- Per-IP rate limits are bypassable via `X-Forwarded-For`; `POST /api/crew/ask`
  is unmetered; uploads buffer fully before the size check; `Routes.jsx` cannot
  add houses to a route.
