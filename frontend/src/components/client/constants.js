/**
 * Shared constants for ClientProfile and its extracted sub-components.
 *
 * These were originally declared at the top and bottom of ClientProfile.jsx.
 * None capture any state — they're pure module-level values — so hoisting
 * them out lets each sub-component import cleanly instead of the parent
 * threading them through every prop.
 */

// Status renders are dot + word (owner's veto of tinted pill bubbles):
// DOT_CHIP is the quiet bordered body, the *_COLORS maps now hold the
// little dot's color class. Same export names as before so consumers only
// changed their render markup, not their imports.
export const DOT_CHIP = 'inline-flex items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 py-0.5 text-[11px] font-medium capitalize leading-none text-ink-2'
export const DOT = 'w-1.5 h-1.5 rounded-full shrink-0'

export const STATUS_COLORS = {
  lead:     'bg-amber-500',
  active:   'bg-emerald-500',
  inactive: 'bg-ink-3',
}

export const JOB_COLORS = {
  scheduled:   'bg-blue-500',
  in_progress: 'bg-amber-500',
  completed:   'bg-green-500',
  cancelled:   'bg-red-500',
}

export const INVOICE_COLORS = {
  draft:   'bg-ink-3',
  sent:    'bg-blue-500',
  paid:    'bg-green-500',
  overdue: 'bg-red-500',
}

export const QUOTE_COLORS = {
  draft:    'bg-ink-3',
  sent:     'bg-blue-500',
  viewed:   'bg-indigo-500',
  changes_requested: 'bg-amber-500',
  accepted: 'bg-green-500',
  converted: 'bg-teal-500',
  declined: 'bg-red-500',
}

export const OPP_COLORS = {
  new: 'bg-amber-500',
  qualified: 'bg-blue-500',
  quoted: 'bg-purple-500',
  won: 'bg-green-500',
  lost: 'bg-red-500',
}

export const PROPERTY_TYPE_COLORS = {
  residential: 'bg-blue-500',
  commercial:  'bg-emerald-500',
  str:         'bg-orange-500',
}

export const PROPERTY_TYPE_LABELS = {
  residential: 'Residential',
  commercial: 'Commercial',
  str: 'STR'
}

export const INPUT_CLASS = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none'

/* ─── ClientCalendarTab-adjacent constants ─── */

export const MINI_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
export const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

export const JOB_TYPE_DOT = {
  residential:  'bg-blue-500',
  commercial:   'bg-green-500',
  str_turnover: 'bg-orange-500',
}

export const JOB_TYPE_LABEL = {
  residential:  'Residential',
  commercial:   'Commercial',
  str_turnover: 'STR Turnover',
}

// Same dot-not-tint rule for the calendar tab's status chips.
export const STATUS_PILL = {
  scheduled:   'bg-blue-500',
  in_progress: 'bg-amber-500',
  completed:   'bg-emerald-500',
  cancelled:   'bg-ink-3',
}

export const EMPTY_ICAL = {
  url: '', source: '', checkout_time: '', duration_hours: '',
  house_code: '', instructions: '',
}
