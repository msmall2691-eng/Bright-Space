/**
 * Shared constants + tiny helpers for the Schedule page and its extracted
 * sub-components. Everything here is closure-free — pure values or pure
 * functions with no captured state.
 */
import { Wind, Home, Building2 } from 'lucide-react'

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
// Keyed by the raw Job.job_type OR Property.property_type strings we ship
// from the API. The `str_turnover` alias is just so CalendarView (which
// keys by Job.job_type) resolves to the same visual as `str`.
export const PROPERTY_TYPE_CONFIG = {
  str: {
    label: 'STR',
    icon: Wind,
    color: 'bg-amber-50 border-l-4 border-l-amber-400',
    badge: 'bg-amber-100 text-amber-700',
    dot:   'bg-amber-500',
    pill:  'bg-amber-50 text-amber-700 border-amber-200',
    pillHover: 'hover:bg-amber-100',
  },
  residential: {
    label: 'Residential',
    icon: Home,
    color: 'bg-blue-50 border-l-4 border-l-blue-400',
    badge: 'bg-blue-100 text-blue-700',
    dot:   'bg-blue-500',
    pill:  'bg-blue-50 text-blue-700 border-blue-200',
    pillHover: 'hover:bg-blue-100',
  },
  commercial: {
    label: 'Commercial',
    icon: Building2,
    color: 'bg-purple-50 border-l-4 border-l-purple-400',
    badge: 'bg-purple-100 text-purple-700',
    dot:   'bg-purple-500',
    pill:  'bg-purple-50 text-purple-700 border-purple-200',
    pillHover: 'hover:bg-purple-100',
  },
}
// Job.job_type = 'str_turnover' resolves to the same palette entry as 'str'.
PROPERTY_TYPE_CONFIG.str_turnover = PROPERTY_TYPE_CONFIG.str

export const VISIT_STATUS_CONFIG = {
  // Computed pseudo-status for a job whose DB status is 'scheduled' but which
  // is missing a real schedule (no date, no property, or no crew). Shown as
  // amber so operators don't mistake a half-set-up job for one they can walk
  // away from. See computeDisplayStatus() below.
  needs_setup: { label: 'Needs setup',  dot: 'bg-amber-500',  badge: 'warning', pillMobile: 'bg-amber-50 text-amber-700' },
  scheduled:   { label: 'Scheduled',   dot: 'bg-blue-500',   badge: 'info',    pillMobile: 'bg-blue-50 text-blue-700' },
  dispatched:  { label: 'Dispatched',  dot: 'bg-green-500',  badge: 'success', pillMobile: 'bg-green-50 text-green-700' },
  en_route:    { label: 'En Route',    dot: 'bg-cyan-500',   badge: 'info',    pillMobile: 'bg-cyan-50 text-cyan-700' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-500',  badge: 'warning', pillMobile: 'bg-amber-50 text-amber-700' },
  completed:   { label: 'Completed',   dot: 'bg-green-600',  badge: 'success', pillMobile: 'bg-emerald-50 text-emerald-700' },
  no_show:     { label: 'No Show',     dot: 'bg-red-500',    badge: 'danger',  pillMobile: 'bg-red-50 text-red-700' },
  cancelled:   { label: 'Cancelled',   dot: 'bg-ink-3',      badge: 'danger',  pillMobile: 'bg-bg-2 text-ink-2' },
}

/** Turn a job/visit's DB status into the status the UI should show.
 *
 *  A quote converted to a job with no date, or a job created with no property
 *  or no crew, previously read as "Scheduled" — misleading, because it wasn't
 *  actually on the calendar and operators could easily walk away from it. This
 *  returns "needs_setup" for those, and passes through everything else.
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
  const cleanerIds = entity.cleaner_ids
  const missingCrew = Array.isArray(cleanerIds) && cleanerIds.length === 0
  if (!hasDate || missingProperty || missingCrew) return 'needs_setup'
  return raw
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
