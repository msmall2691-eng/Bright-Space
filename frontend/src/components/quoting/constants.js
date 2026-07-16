/**
 * Shared constants + tiny pure helpers for the Quoting page and its
 * extracted sub-components. Everything here is closure-free — pure values
 * or pure functions with no captured state.
 */
import { toLocalYMD } from '../../utils/format'

export const QUOTE_STATUS_COLORS = {
  draft:    'bg-bg-2 text-ink-3 border-hairline',
  sent:     'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800',
  viewed:   'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800',
  changes_requested: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  converted: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800',
  declined: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800',
  expired: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
}

export const LEAD_STATUS_COLORS = {
  new:       'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  reviewed:  'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800',
  quoted:    'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800',
  converted: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
}

// Inline-edit status options (Twenty-style chips) for the leads/quotes tables.
// 'converted' is intentionally NOT selectable here — it's a derived state set only
// by the quote→job conversion flow, never a manual status pick (audit item 2).
export const QUOTE_STATUS_OPTIONS = ['draft', 'sent', 'viewed', 'accepted', 'declined']
  .map(s => ({ value: s, label: s, chipClass: QUOTE_STATUS_COLORS[s] || QUOTE_STATUS_COLORS.draft }))
export const LEAD_STATUS_OPTIONS = ['new', 'reviewed', 'quoted', 'converted']
  .map(s => ({ value: s, label: s, chipClass: LEAD_STATUS_COLORS[s] }))

// Guided "next step" per quote status — turns the quotes list into a worklist so
// it's always obvious what moves a lead toward becoming a (recurring) client.
export const QUOTE_NEXT_STEP = {
  draft:             { text: 'Next: send it to the customer', cls: 'text-blue-600' },
  sent:              { text: 'Next: waiting on the customer — nudge if it goes quiet', cls: 'text-ink-3' },
  viewed:            { text: 'Next: they opened it — follow up to close', cls: 'text-blue-600' },
  changes_requested: { text: 'Next: revise and resend', cls: 'text-amber-600' },
  accepted:          { text: 'Next: schedule the job', cls: 'text-emerald-600' },
  declined:          { text: 'Next: follow up or archive', cls: 'text-ink-3' },
  converted:         { text: 'Won ✓ — set up a recurring plan to keep them', cls: 'text-emerald-600' },
}

export const SERVICE_TYPES = ['residential', 'commercial', 'str']
export const EMPTY_ITEM = { name: '', description: '', qty: 1, unit_price: 0 }

// Title-case a phrase for customer-facing display: capitalizes each word but
// leaves already-uppercase tokens (state codes like "ME", "STR") intact.
// "ridge rd" -> "Ridge Rd", "100 congress street" -> "100 Congress Street".
export const titleCase = (s) => (s || '')
  .split(/(\s+)/)
  .map(w => {
    if (!w.trim()) return w
    if (w.length <= 3 && w === w.toUpperCase()) return w   // ME, STR, LLC…
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  })
  .join('')

// Customer-facing label for a service type.
export const serviceLabel = (t) => t === 'str' ? 'STR / Vacation Rental Cleaning'
  : `${(t || 'residential').charAt(0).toUpperCase()}${(t || 'residential').slice(1)} Cleaning`

// Friendly cadence label, or '' when one-time / unknown.
export const freqLabel = (f) => {
  const map = { weekly: 'Weekly', biweekly: 'Biweekly', 'bi-weekly': 'Biweekly',
    monthly: 'Monthly', 'one-time': '', onetime: '', once: '' }
  const key = (f || '').toLowerCase().trim()
  return map[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : '')
}

// Default customer-facing scope per service type — a sensible starting point
// the admin can edit. Keeps the quote from going out with an empty "what's
// included" section.
export const SERVICE_SCOPE = {
  residential: 'Full home cleaning: kitchen, bathrooms, bedrooms, and living areas — dusting, vacuuming, mopping, and surface sanitizing. Trash removed and floors finished throughout.',
  commercial: 'Commercial cleaning of all common and work areas: restrooms, break areas, floors, and high-touch surfaces sanitized. Trash removed and entryways finished.',
  str: 'Turnover clean between guests: full kitchen and bathroom reset, fresh linens and towels staged, floors cleaned, trash removed, and the space restocked and guest-ready.',
}

// The list of services + scopes is editable in Settings (Service Scopes) and
// loaded from GET /api/settings/service-scopes into a `services` array of
// {key,label,scope}. These read that array with a safe fallback to the
// built-ins, so the quote composer keeps working if the fetch fails or an
// intake references a service the operator has since renamed.
export const scopeForService = (services, key) => {
  const hit = Array.isArray(services) ? services.find(s => s.key === key) : null
  return (hit?.scope || '').trim() || SERVICE_SCOPE[key] || ''
}
export const labelForService = (services, key) => {
  const hit = Array.isArray(services) ? services.find(s => s.key === key) : null
  return (hit?.label || '').trim() || serviceLabel(key)
}
// The service options for the composer's Service Type selector: the loaded
// list, or the built-in three when nothing's loaded yet.
export const serviceOptions = (services) =>
  (Array.isArray(services) && services.length)
    ? services.map(s => ({ key: s.key, label: s.label || serviceLabel(s.key) }))
    : SERVICE_TYPES.map(t => ({ key: t, label: serviceLabel(t) }))

// Build a quote title from a lead/request: "Biweekly Residential Cleaning — 24 Pine Street".
export const titleFromIntake = (intake) => {
  const freq = freqLabel(intake.frequency)
  const svc = serviceLabel(intake.service_type)
  const where = titleCase((intake.address || intake.property_name || intake.city || '').split(',')[0].trim())
  const lead = [freq, svc].filter(Boolean).join(' ')
  return where ? `${lead} — ${where}` : lead
}

// Round to the nearest $5 — matches the website instant-quote rounding so the
// pre-filled price lands on the same clean number the customer was shown.
export const roundTo5 = (n) => Math.round((Number(n) || 0) / 5) * 5

// Flat 30-day validity policy: a new quote's "Valid Until" defaults to 30 days
// out (still editable) so it's never empty and matches the backend default.
export const defaultValidUntil = () => {
  const d = new Date()
  d.setDate(d.getDate() + 30)
  return toLocalYMD(d)
}

// Names that are really phone numbers / intake placeholders — never greet
// with these ("Hello +12074329492" shipped to a real customer on June 11).
export const PLACEHOLDER_RE = /^(unknown|brightbase webhook test|webhook test|test client|n\/a|\+?[\d\s().-]+)$/i
export const isPlaceholderName = (n) => !n || !n.trim() || PLACEHOLDER_RE.test(n.trim())
