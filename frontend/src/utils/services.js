/**
 * Canonical service vocabulary — ONE place that knows what a "service" is and
 * how to label it, so every screen reads the same way.
 *
 * BrightBase carried three overlapping vocabularies for the same idea:
 *   - Job.job_type:      residential | deep_clean | commercial | str_turnover
 *   - Quote.service_type: residential | commercial | str
 *   - Property.property_type: residential | commercial | str
 * ...and "deep_clean" had no label at all, so it rendered as a raw string.
 *
 * This module is the single source: a canonical label + dot for each job_type,
 * a normalizer from the quote/property vocab, and the service GROUPING a
 * property's work rolls up into (the Jobber-style "services under this
 * property"). Dots follow the design language (quiet dot + word, no bubbles);
 * amber is reserved for attention, so it is deliberately not used here.
 */

// Canonical job_type → label / dot. Keyed by Job.job_type; "deep_clean" now
// has a real label instead of leaking its raw string onto the screen.
export const JOB_TYPE_LABEL = {
  residential:  'Residential',
  deep_clean:   'Deep clean',
  commercial:   'Commercial',
  str_turnover: 'STR Turnover',
}

export const JOB_TYPE_DOT = {
  residential:  'bg-blue-500',
  deep_clean:   'bg-violet-500',
  commercial:   'bg-emerald-500',
  str_turnover: 'bg-orange-500',
}

export const jobTypeLabel = (t) => JOB_TYPE_LABEL[t] || JOB_TYPE_LABEL.residential
export const jobTypeDot = (t) => JOB_TYPE_DOT[t] || JOB_TYPE_DOT.residential

/**
 * Normalize the quote/property vocabulary (residential | commercial | str) to a
 * canonical job_type key, so a quote's service or a property's type can be
 * labeled with the same map above.
 */
export function normalizeServiceType(value) {
  const v = String(value || '').trim().toLowerCase()
  if (v === 'str' || v === 'str_turnover' || v === 'turnover' || v === 'rental') return 'str_turnover'
  if (v === 'commercial') return 'commercial'
  if (v === 'deep_clean' || v === 'deep clean') return 'deep_clean'
  return 'residential'
}

/**
 * The service buckets a property's work rolls up into, in display order. This
 * is the per-property "services" grouping the owner wanted (like Jobber groups
 * visits under a job). Recurring vs one-time is a real distinction only for
 * residential work; the specialized types (turnover / commercial / deep clean)
 * are their own bucket whether or not they repeat.
 */
export const SERVICE_GROUPS = [
  { key: 'recurring',  label: 'Recurring clean', dot: 'bg-indigo-500' },
  { key: 'turnover',   label: 'Turnovers',       dot: 'bg-orange-500' },
  { key: 'deep_clean', label: 'Deep clean',      dot: 'bg-violet-500' },
  { key: 'commercial', label: 'Commercial',      dot: 'bg-emerald-500' },
  { key: 'one_time',   label: 'One-time',        dot: 'bg-blue-500' },
]

const GROUP_BY_KEY = Object.fromEntries(SERVICE_GROUPS.map(g => [g.key, g]))

/** Which service bucket a single job belongs to. */
export function serviceGroupKey(job) {
  const jt = job?.job_type || 'residential'
  if (jt === 'str_turnover') return 'turnover'
  if (jt === 'commercial') return 'commercial'
  if (jt === 'deep_clean') return 'deep_clean'
  if (job?.recurring_schedule_id) return 'recurring'
  return 'one_time'
}

export const serviceGroupFor = (job) => GROUP_BY_KEY[serviceGroupKey(job)] || GROUP_BY_KEY.one_time

/**
 * Group a property's jobs into ordered service sections, preserving the caller's
 * sort within each section. Returns only the buckets that actually have jobs:
 * [{ key, label, dot, jobs: [...] }].
 */
export function groupJobsByService(jobs) {
  const buckets = {}
  for (const job of jobs || []) {
    const key = serviceGroupKey(job)
    ;(buckets[key] ||= []).push(job)
  }
  return SERVICE_GROUPS
    .filter(g => buckets[g.key]?.length)
    .map(g => ({ ...g, jobs: buckets[g.key] }))
}
