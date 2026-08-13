# Crew App 2.0 — plan of record

Owner-approved 2026-08-13. The crew app (the `/my-day` surface + `modules/crew/`)
grows from "today's list + clock" into the one app a cleaner needs, in five
independently-shippable phases. Each phase is its own PR; nothing here lands as
a big bang.

**The shape:** a bottom tab bar — **Today** / **Schedule** / **Me** — same
glove-friendly design language the clock and photos already use (big targets,
bottom sheets, no chrome).

## Decisions of record (owner, 2026-08-13)

1. **Decline keeps the assignment.** A cleaner declining a job flags the office
   (with their reason) but never removes them from the job — the office decides
   the reassignment. Nothing silently falls off the schedule.
2. **Only office-marked jobs are claimable.** The office flips a job to
   "open for claims"; unassigned jobs are NOT automatically claimable.
3. **Availability is per-day AM / PM / Off.** A simple weekly pattern, not time
   ranges. It renders as a signal in the office's assign UI — never a hard block.
4. **Crew see customer name AND phone** on the job card (tel: link) — the crew
   handle "I'm outside" texts themselves.

## Phases

| # | What ships | Status |
|---|------------|--------|
| 1 | Tab shell (Today/Schedule/Me) · teammates by name on job cards · client name+phone · property checklist display · Me profile (name/phone/emergency contact, migration 082) | merged #684 |
| 2 | Accept / decline on assigned jobs — per-cleaner response + reason (migration 083), Accept / Can't-make-it on crew job cards, per-cleaner state on JobDetail, decline pushes a staff notification + timeline entry. Response state lives OUTSIDE `Job.cleaner_ids` (a status, not a schedule write — scheduling-invariants reviewed) | this PR |
| 3 | Open-jobs board — office toggles "Open for claims" on JobDetail (migration 084); crew see "Up for grabs" on Today/Schedule with a Claim button; claim is atomic first-claim-wins (row lock, one winner, loser 409s), seeds an accepted response, activity-logs + pushes to staff. Listings hide access details/customer phone until claimed. Office unassign now clears stale responses (Phase 2 edge). | this PR |
| 4 | Weekly availability — per-cleaner Mon–Sun AM/PM/Off template edited in Me (migration 085); feeds `/api/jobs/cleaner-availability` as a soft `usually_off` status → JobEdit picker hints + dispatch-board crew chips. Real `cleaner_time_off` always outranks the pattern. Shipped together with the office Schedule redesign (3 tabs — Day auto-switches board↔agenda at 1100px — plus collapsible board columns), since the chips live on that surface. | this PR |
| 4b | Week-anchored availability (owner feedback on 4): `cleaner_week_availability` (migration 087, Monday-anchored — design-review decision; office board's Sunday strip is display-only). Crew set specific weeks up to 8 ahead; the running week is LOCKED (business-clock, server-enforced, revert included). A week row masks the template both directions; explicit rows resolve as firm `unavailable` (outranks same_day), template stays soft `usually_off`. Saves that uncover an existing assignment report it to the cleaner and push-notify the office. Both office status maps updated same deploy; unknown statuses degrade to no-hint, never green. Built after a 3-lens agent design review (cleaner-UX / office-workflow / data-time). | this PR |
| 5 | Training & docs — `crew_docs` (migration 086): office writes/curates on the Crew page (categories, pinned, drafts, optional http(s) links for videos/guides); crew reads in a new **Learn** tab (pinned first, category chips, plain-text reader with "- " step lists, link docs open in browser). PDF uploads consciously cut from v1 (photos-style in-DB storage is the pattern if wanted later) — text + links cover the actual onboarding content and stay maintainable by one person. | this PR |

## Ground rules carried across all phases

- **Schedule truth stays with the office.** Crew actions are either statuses
  (responses, availability) or narrowly-gated self-assignment (claiming an
  explicitly opened job). No crew action ever deletes or moves a job.
- **Object-level auth everywhere:** cleaners see/touch only their own jobs,
  their own profile, their own responses. Not-yours reads as 404.
- **One data fetch per screen** where possible — the crew app runs on driveway
  LTE. my-day already carries jobs, clock, and (now) teammates in one call.
- Existing assets get reused, not duplicated: `cleaner_time_off` (time off),
  `checklist_template` (property checklists), the photo-bytes storage pattern
  (documents), `_names_by_cleaner_id` (name resolution).
