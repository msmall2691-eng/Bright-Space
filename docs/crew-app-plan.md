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
| 1 | Tab shell (Today/Schedule/Me) · teammates by name on job cards · client name+phone · property checklist display · Me profile (name/phone/emergency contact, migration 082) | this PR |
| 2 | Accept / decline on assigned jobs — per-cleaner response + reason, office flags on Schedule/JobDetail. Response state lives OUTSIDE `Job.cleaner_ids` (it's a status, not a schedule write — scheduling-invariants reviewed) | next |
| 3 | Open-jobs board — office marks a job open; crew claim it (atomic first-claim-wins writes `Job.cleaner_ids` server-side, activity-logged, office notified) | |
| 4 | Weekly availability — per-cleaner Mon–Sun AM/PM/Off template edited in Me; availability chip beside names in the office assign flow; complements the existing `cleaner_time_off` date ranges | |
| 5 | Training (links) + Documents (PDFs, stored in-DB like job photos) — read view in Me, managed from Crew admin | |

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
