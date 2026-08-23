// Duplicate-series detection for /recurring — pure helpers shared by the
// list's "Possible duplicate" pills and the Review-duplicates panel, so
// there is exactly ONE definition of what counts as a duplicate.
//
// Informational only: nothing in this module (or the panel it powers) ever
// pauses, cancels, or deletes anything on its own — every action is an
// explicit, per-series confirm through the existing Manage endpoints.

// Local YYYY-MM-DD (NOT toISOString, which flips the date across UTC midnight).
function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A series that is still producing visits: active AND not past its end date.
 *  series_end_date is the backend's EXCLUSIVE boundary (first date NOT
 *  generated), so an end date of today or earlier means the series is
 *  finished — split retires predecessors exactly this way (active stays true,
 *  only series_end_date is set), and those must read as "Ended", not as live
 *  duplicates. */
/**
 * What to call a series in the UI: 'active' | 'ended' | 'cancelled' | 'paused'.
 *
 * `active=false` used to mean both "paused" and "cancelled" — the two write
 * identical rows and only the button copy differed, so a series the owner
 * cancelled came back reading "Paused" and looked like the button had done
 * nothing ("when I try to cancel or delete them they dont go away").
 * `cancelled_at` (migration 096) is what tells them apart; NULL is paused,
 * which is how every row written before that migration reads.
 *
 * Shared by the list, the detail header and the duplicate review panel so
 * one series can't be called two different things on two screens.
 */
export function seriesState(s) {
  if (isLiveSeries(s)) return 'active'
  if (s?.cancelled_at) return 'cancelled'
  // Active but past its end date — how a split retires its predecessor.
  return s?.active ? 'ended' : 'paused'
}

export const SERIES_STATE_LABEL = {
  active: 'Active', ended: 'Ended', cancelled: 'Cancelled', paused: 'Paused',
}

export function isLiveSeries(s) {
  if (!s || !s.active) return false
  if (!s.series_end_date) return true
  return String(s.series_end_date).slice(0, 10) > todayYMD()
}

// "09:00:00" (backend time serialization) and "09:00" compare equal.
function normTime(t) {
  return String(t || '').slice(0, 5)
}

function effectiveDays(s) {
  const raw = (s.days_of_week && s.days_of_week.length
    ? s.days_of_week : [s.day_of_week ?? 0])
  return [...new Set(raw.map(Number))].sort((a, b) => a - b)
}

// Everything two series must share EXACTLY to be duplicate candidates —
// aligned with the backend guard's definition (services/recurring_guards.py):
// client + property (both-empty counts as same) + frequency + interval +
// day-of-month + start time. Days of week are deliberately NOT here: they
// match by OVERLAP, not equality (see groupDuplicateSeries).
function baseKey(s) {
  return `${s.client_id}|${s.property_id ?? ''}|${s.frequency}|${s.interval_weeks || 1}|${s.day_of_month || ''}|${normTime(s.start_time)}`
}

/** Full identity key for one series (base + its sorted day set). Kept for
 *  callers that need a stable per-series string; duplicate GROUPING goes
 *  through groupDuplicateSeries, which matches day sets by overlap. */
export function seriesDupKey(s) {
  return `${baseKey(s)}|${effectiveDays(s).join(',')}`
}

/** Group LIVE series into duplicate groups: same base key (client + property
 *  + cadence + time) and an overlapping day-of-week set — a new Wednesday
 *  series duplicates an existing Mon/Wed/Fri one. Ended and paused series
 *  never count (isLiveSeries). Returns [{ key, members }] with members.length
 *  >= 2; `key` is stable for a given membership (base + union of days) and is
 *  what the "skip this group" persistence stores. */
export function groupDuplicateSeries(seriesList) {
  const live = (seriesList || []).filter(isLiveSeries)
  const buckets = new Map()
  for (const s of live) {
    const b = baseKey(s)
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(s)
  }
  const groups = []
  for (const [b, members] of buckets) {
    if (members.length < 2) continue
    // Union-find over shared weekdays: overlap isn't transitive (Mon/Wed and
    // Wed/Fri and Fri-only chain into one group), so connected components.
    const parent = members.map((_, i) => i)
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const daySets = members.map(s => new Set(effectiveDays(s)))
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        // Monthly series don't have a meaningful day-of-week — day_of_month
        // is already part of the bucket key (baseKey), so same-bucket monthly
        // series always overlap here. Mirrors the backend's
        // _group_live_duplicates (services/recurring_guards.py), which
        // bypasses the day-set check entirely for frequency === 'monthly';
        // without this, two monthly duplicates whose (cosmetic, UI-unused)
        // day_of_week values happened to differ would silently NOT group on
        // the frontend while the backend's health scan still flagged them.
        const overlaps = members[i].frequency === 'monthly'
          || [...daySets[i]].some(d => daySets[j].has(d))
        if (overlaps) {
          parent[find(i)] = find(j)
        }
      }
    }
    const byRoot = new Map()
    members.forEach((s, i) => {
      const r = find(i)
      if (!byRoot.has(r)) byRoot.set(r, [])
      byRoot.get(r).push(s)
    })
    for (const g of byRoot.values()) {
      if (g.length < 2) continue
      const unionDays = [...new Set(g.flatMap(effectiveDays))].sort((a, b) => a - b)
      groups.push({ key: `${b}|${unionDays.join(',')}`, members: g })
    }
  }
  return groups
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

/** Recognize POST /api/recurring's overridable 409 (guard 1). The backend
 *  raises HTTPException(409, detail={detail: 'similar_series_exists',
 *  matches: [...]}) and api.js JSON-stringifies a non-string detail, so this
 *  parses it back. Returns the matches array, or null when the error is
 *  something else (callers fall through to their normal error path). */
export function parseSimilarSeriesConflict(err) {
  if (!err || (err.status !== undefined && err.status !== 409)) return null
  try {
    const d = typeof err.detail === 'string' ? JSON.parse(err.detail) : err.detail
    if (d && d.detail === 'similar_series_exists') return d.matches || []
  } catch { /* not the structured payload — not ours */ }
  return null
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
