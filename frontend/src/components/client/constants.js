/**
 * Shared constants for ClientProfile and its extracted sub-components.
 *
 * These were originally declared at the top and bottom of ClientProfile.jsx.
 * None capture any state — they're pure module-level values — so hoisting
 * them out lets each sub-component import cleanly instead of the parent
 * threading them through every prop.
 */

export const STATUS_COLORS = {
  lead:     'bg-amber-500/15 text-amber-500 border-amber-500/20',
  active:   'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
  inactive: 'bg-bg-2 text-ink-3 border-hairline',
}

export const JOB_COLORS = {
  scheduled:   'bg-blue-500/20 text-blue-400',
  in_progress: 'bg-yellow-500/20 text-yellow-400',
  completed:   'bg-green-500/20 text-green-400',
  cancelled:   'bg-red-500/20 text-red-400',
}

export const INVOICE_COLORS = {
  draft:   'bg-ink-3/15 text-ink-3',
  sent:    'bg-blue-500/20 text-blue-400',
  paid:    'bg-green-500/20 text-green-400',
  overdue: 'bg-red-500/20 text-red-400',
}

export const QUOTE_COLORS = {
  draft:    'bg-ink-3/15 text-ink-3',
  sent:     'bg-blue-500/20 text-blue-400',
  viewed:   'bg-indigo-500/20 text-indigo-400',
  changes_requested: 'bg-amber-500/20 text-amber-500',
  accepted: 'bg-green-500/20 text-green-400',
  converted: 'bg-teal-500/20 text-teal-400',
  declined: 'bg-red-500/20 text-red-400',
}

export const PROPERTY_TYPE_COLORS = {
  residential: 'bg-blue-50 text-blue-700 border-blue-200',
  commercial:  'bg-emerald-50 text-emerald-700 border-emerald-200',
  str:         'bg-orange-50 text-orange-700 border-orange-200',
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

export const STATUS_PILL = {
  scheduled:   'bg-blue-50 text-blue-700 border-blue-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  completed:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled:   'bg-bg-2 text-ink-3 border-hairline',
}
