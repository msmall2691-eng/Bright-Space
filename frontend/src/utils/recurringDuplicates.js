// Duplicate-series detection for /recurring — pure helpers shared by the
// list's "Possible duplicate" pills and the Review-duplicates panel, so
// there is exactly ONE definition of what counts as a duplicate.
//
// Informational only: nothing in this module (or the panel it powers) ever
// pauses, cancels, or deletes anything on its own — every action is an
// explicit, per-series confirm through the existing Manage endpoints.

/** Two ACTIVE series with the same client + cadence + day-of-week are almost
 *  always an accidental double-create (the confusing "two Sandra Fox, every 4
 *  weeks on Fri" case). This key groups them. (Moved verbatim from
 *  Recurring.jsx's seriesDupKey — same definition, now shared.) */
export function seriesDupKey(s) {
  const days = (s.days_of_week && s.days_of_week.length ? s.days_of_week : [s.day_of_week ?? 0])
    .slice().sort((a, b) => a - b).join(',')
  return `${s.client_id}|${s.frequency}|${s.interval_weeks || 1}|${s.day_of_month || ''}|${days}`
}

/** Default keeper suggestion for a duplicate group: the series with the most
 *  upcoming generated visits (it's the one actually feeding the calendar);
 *  tiebreak: oldest created_at (the original, not the accidental re-create).
 *  Returns { id, reason } — reason is the user-facing "why" — or null.
 *  A suggestion, never an action: the owner picks the actual keeper. */
export function suggestKeeper(seriesList) {
  const pool = (seriesList || []).filter(Boolean)
  if (!pool.length) return null
  const created = (s) => s.created_at || '9999-12-31' // missing date sorts newest
  const sorted = [...pool].sort((a, b) =>
    (b.upcoming_job_count || 0) - (a.upcoming_job_count || 0)
    || created(a).localeCompare(created(b))
    || (a.id - b.id))
  const top = sorted[0]
  const reason = (sorted.length > 1
    && (top.upcoming_job_count || 0) > (sorted[1].upcoming_job_count || 0))
    ? `most upcoming visits (${top.upcoming_job_count || 0})`
    : 'tied on upcoming visits — oldest series'
  return { id: top.id, reason }
}

// "Skip this group" persistence: group keys the owner marked as NOT
// duplicates (false positives), so the banner count excludes them. Plain
// group keys only — nothing sensitive is stored.
const REVIEWED_KEY = 'bb_recurring_dup_reviewed'

export function loadReviewedDupKeys() {
  try {
    const arr = JSON.parse(localStorage.getItem(REVIEWED_KEY) || '[]')
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

export function saveReviewedDupKeys(keys) {
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify([...keys]))
  } catch { /* storage unavailable (private mode) — skip state just won't persist */ }
}
