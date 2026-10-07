/**
 * Shared constants + tiny helpers for the Schedule page and its extracted
 * sub-components. Everything here is closure-free — pure values or pure
 * functions with no captured state.
 */
import { Wind, Home, Building2 } from 'lucide-react'
import { JOB_TYPE_DOT, JOB_TYPE_EDGE, JOB_STAGE_DOT } from '../../theme/scheduleScales'

// Property/job type palette — the single source of truth for how a job
// is colored ANYWHERE in the schedule UI (agenda cards, VisitCards,
// CalendarView month chips, day-cell highlights). Canonical hues:
//   STR / str_turnover → amber
//   residential        → blue
//   commercial         → purple
// The previous state had CalendarView using its own map (commercial=green,
// turnover=orange), so the same job was a different color depending on the
// view — audit called this out. All fields on one config; call sites pick
// the ones they need.
//
// BB-A11Y-02: the colour itself now comes from theme/scheduleScales.js — a
// measured CATEGORICAL scale, because job type is identity rather than
// good-or-bad. The steps that used to be written out here (amber-500 1.77:1,
// blue-500 2.98:1, purple-500 2.74:1) all missed the 3:1 non-text floor. The
// hues are unchanged; only the steps moved. Read that file before touching
// them — commercial sits deep on the ramp on purpose.
//
// Keyed by the raw Job.job_type OR Property.property_type strings we ship
// from the API. The `str_turnover` alias is just so CalendarView (which
// keys by Job.job_type) resolves to the same visual as `str`.
export const PROPERTY_TYPE_CONFIG = {
  // NOTE (owner veto of "big bubbles", Aug 2026): the tinted `pill` /
  // `pillHover` / `badge` chip classes were removed — type color is carried
  // by the `dot` class or the `edge` bar only, over quiet panel
  // surfaces. Don't reintroduce filled colored capsules here.
  str: {
    label: 'STR',
    icon: Wind,
    color: 'bg-amber-50 dark:bg-amber-950 border-l-4 border-l-amber-400',
    dot: JOB_TYPE_DOT.str,
    // A real colour value, not a class — for callers that are inline-styled
    // and absolutely-positioned (the dispatch timeline, route ribbon, week
    // blocks) so those views can't drift from this single source of truth the
    // way CalendarView once did. It is a `var()` rather than a literal hex
    // because no one fixed value clears the floor in BOTH themes; index.css
    // picks the step per theme, exactly as --accent-link does.
    edge: JOB_TYPE_EDGE.str,
  },
  residential: {
    label: 'Residential',
    icon: Home,
    color: 'bg-blue-50 dark:bg-blue-950 border-l-4 border-l-blue-400',
    dot: JOB_TYPE_DOT.residential,
    edge: JOB_TYPE_EDGE.residential,
  },
  commercial: {
    label: 'Commercial',
    icon: Building2,
    color: 'bg-purple-50 dark:bg-purple-950 border-l-4 border-l-purple-400',
    dot: JOB_TYPE_DOT.commercial,
    edge: JOB_TYPE_EDGE.commercial,
  },
}
// Job.job_type = 'str_turnover' resolves to the same palette entry as 'str'.
PROPERTY_TYPE_CONFIG.str_turnover = PROPERTY_TYPE_CONFIG.str

export const VISIT_STATUS_CONFIG = {
  // Two computed pseudo-statuses for a job whose DB status is 'scheduled'.
  //
  // `needs_setup` (amber) means the visit isn't really on the calendar at all
  // — no date, or no property. Something is genuinely missing and nobody can
  // work it as it stands.
  //
  // `unassigned` (quiet) means it IS on the calendar, at a real place and
  // time, and only the crew hasn't been picked yet. That's an ordinary
  // mid-week state — most recurring visits sit there until dispatch — so it
  // gets a neutral dot, not an alarm. Lumping it in with `needs_setup` made
  // nearly every recurring visit read amber "Needs setup" forever, which
  // taught operators to ignore the one label that was supposed to mean
  // "this one is broken". See computeDisplayStatus() below.
  //
  // `badge` is the StatusBadge tone; `dot` is for inline dot+word renders.
  // (The tinted `pillMobile` capsule classes were removed with the owner's
  // bubble veto — status renders as dot + word everywhere now.)
  //
  // BB-A11Y-02: `dot` now comes from theme/scheduleScales.js — a measured
  // ORDINAL ramp ("warms up as it goes", the owner's pick). Two things the old
  // values got wrong beyond contrast, both fixed there: `dispatched` and
  // `completed` were both green and rendered identically, so a dispatched job
  // looked finished; and `scheduled` — most of the calendar — was the loudest
  // blue on the page. Read that file before changing a step.
  needs_setup: { label: 'Needs setup', dot: JOB_STAGE_DOT.needs_setup, badge: 'warning' },
  unassigned:  { label: 'Unassigned',  dot: JOB_STAGE_DOT.unassigned,  badge: 'neutral' },
  scheduled:   { label: 'Scheduled',   dot: JOB_STAGE_DOT.scheduled,   badge: 'info' },
  dispatched:  { label: 'Dispatched',  dot: JOB_STAGE_DOT.dispatched,  badge: 'success' },
  en_route:    { label: 'En Route',    dot: JOB_STAGE_DOT.en_route,    badge: 'info' },
  in_progress: { label: 'In Progress', dot: JOB_STAGE_DOT.in_progress, badge: 'warning' },
  completed:   { label: 'Completed',   dot: JOB_STAGE_DOT.completed,   badge: 'success' },
  no_show:     { label: 'No Show',     dot: JOB_STAGE_DOT.no_show,     badge: 'danger' },
  cancelled:   { label: 'Cancelled',   dot: JOB_STAGE_DOT.cancelled,   badge: 'danger' },
}

/** Turn a job/visit's DB status into the status the UI should show.
 *
 *  A quote converted to a job with no date, or a job created with no property,
 *  previously read as "Scheduled" — misleading, because it wasn't actually on
 *  the calendar and operators could easily walk away from it. Those return
 *  "needs_setup".
 *
 *  A missing CREW is different and no longer counted as needs_setup: a
 *  recurring series can be created with no cleaners (ScheduleCreate defaults
 *  cleaner_ids to []) and every visit it generates inherits that, so "crew not
 *  picked yet" is the normal state of most of the calendar, not a fault. Those
 *  return "unassigned" instead — visible, but quiet.
 *
 *  Only overrides when the raw status is 'scheduled' — a completed / cancelled
 *  job with a missing field is a data quirk, not something we want to relabel.
 *  Accepts a job (checks scheduled_date + property_id + cleaner_ids) or a
 *  visit (checks scheduled_date + cleaner_ids; property comes via the linked
 *  job upstream). */
export function computeDisplayStatus(entity) {
  if (!entity) return 'scheduled'
  const raw = entity.status || 'scheduled'
  if (raw !== 'scheduled') return raw
  const hasDate = !!(entity.scheduled_date && String(entity.scheduled_date).trim())
  // property_id absence only counts as incomplete when the field is on the
  // record we were given (jobs have it; raw visits do not — the caller resolves).
  const missingProperty = ('property_id' in entity) && !entity.property_id
  if (!hasDate || missingProperty) return 'needs_setup'
  const cleanerIds = entity.cleaner_ids
  if (Array.isArray(cleanerIds) && cleanerIds.length === 0) return 'unassigned'
  return raw
}

/** Field key → the word the operator sees for it. Lives here, not in the edit
 *  modal, because the scope dialog names the fields it is about to apply and
 *  more than one screen opens that dialog — two copies of this map is how one
 *  of them ends up calling `cleaner_ids` something the other doesn't. */
export const FIELD_LABELS = {
  scheduled_date: 'Date', start_time: 'Start time', end_time: 'End time',
  cleaner_ids: 'Crew', title: 'Title', address: 'Address', notes: 'Notes',
  property_id: 'Property',
}

export const VISIT_ACCENT = {
  str: 'border-l-amber-400',
  str_turnover: 'border-l-amber-400',
  residential: 'border-l-blue-400',
  commercial: 'border-l-purple-400',
}

export const DEFAULT_CHECKLIST = [
  'Kitchen cleaned',
  'Bathrooms cleaned',
  'Floors vacuumed/mopped',
  'Trash removed',
  'Surfaces wiped',
  'Final walkthrough',
]

/** "Jun 5" style date label for booking check-in/out timestamps. */
export const shortDate = (iso) => {
  if (!iso) return ''
  try {
    return new Date(`${String(iso).slice(0, 10)}T00:00`).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    })
  } catch { return iso }
}

/** First initials of the first two whitespace-separated words in a name. */
export const cleanerInitials = (name) =>
  (name || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?'
