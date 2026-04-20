export const STATUS_COLORS = {
  lead:     'bg-amber-500/15 text-amber-500 border-amber-500/20',
  active:   'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
  inactive: 'bg-zinc-100 text-zinc-400 border-zinc-200',
}

export const JOB_COLORS = {
  scheduled:   'bg-blue-500/20 text-blue-400',
  in_progress: 'bg-yellow-500/20 text-yellow-400',
  completed:   'bg-green-500/20 text-green-400',
  cancelled:   'bg-red-500/20 text-red-400',
}

export const INVOICE_COLORS = {
  draft:   'bg-zinc-500/20 text-zinc-400',
  sent:    'bg-blue-500/20 text-blue-400',
  paid:    'bg-green-500/20 text-green-400',
  overdue: 'bg-red-500/20 text-red-400',
}

export const QUOTE_COLORS = {
  draft:    'bg-zinc-500/20 text-zinc-400',
  sent:     'bg-blue-500/20 text-blue-400',
  accepted: 'bg-green-500/20 text-green-400',
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

export const INPUT_CLASS = 'w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none'

// Tab redirect mapping for backward compatibility
export const TAB_REDIRECTS = {
  details: 'overview',
  crm: 'overview',
  properties: 'overview',
  calendar: 'schedule',
  recurring: 'schedule',
  jobs: 'schedule',
  emails: 'activity',
  quotes: 'money',
  invoices: 'money',
  opportunities: 'money',
}
