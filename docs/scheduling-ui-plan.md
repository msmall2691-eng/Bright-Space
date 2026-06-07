# Twenty-style scheduling UI — plan

**Status:** Increment 1 implemented (this PR); later increments proposed.
**Context:** Owner: "I can't schedule a client / I want to schedule residentials and have them on Google Calendar, like Twenty CRM."

## Finding (the gap was UX, not backend)
The backend already creates residential jobs (one-time + recurring) and pushes
them to Google Calendar. The blocker was the **create-job UX on the Schedule
page**: its "New Job" opened `JobEditModal` in a **property-first** mode —
Property is required and the client is *derived* from the chosen property. So if
you think "schedule this client," or the client has no property yet, you're
stuck. There was no client picker, no inline client/property creation, and no
one-time-vs-recurring choice in that flow.

Meanwhile a better, **client-first** modal (`JobCreateModal`) already existed but
was only reachable from a client profile.

## Increment 1 — make scheduling client-first from the calendar (this PR)
- `JobCreateModal` now works **standalone**: when opened without a fixed client
  it shows a **client picker with inline "+ New client"**, then loads that
  client's properties (with the inline "+ New property" added earlier). Supports
  **one-time or recurring**, defaults to **residential**, and (via the existing
  backend) the job lands on **Google Calendar**.
- The Schedule page's **"New Job"** button now opens this client-first modal
  (pre-filled to the day you're viewing) instead of the property-only one.
  `JobEditModal` still handles *editing* existing jobs.

Result: from the Schedule page you can now do client → property → job (creating
any missing records inline), one-time or recurring, residential by default,
synced to Google.

## Later increments (proposed, each its own PR)
2. **Click-a-day-to-create on the in-app calendar.** `CalendarView` already
   supports drag-to-reschedule; add "click an empty day → New Job pre-dated to
   that day" so the month grid is a true scheduling surface (not just viewing).
3. **Client/record-level "Schedule" action.** A visible "Schedule" button on the
   client list + client profile (Twenty-style inline action), reusing the same
   modal with the client pre-selected.
4. **Calendar-centric layout polish.** Make the in-app calendar (not the
   read-only Google embed) the default Schedule view, with create/edit inline —
   closer to Twenty's calendar object. (Larger; do after 2–3 land.)

## Out of scope
Replacing Google Calendar as the event store — Google remains the source of
truth for events (see docs/gcal-reconciliation-plan.md); this is purely the
in-app creation/UX layer.
