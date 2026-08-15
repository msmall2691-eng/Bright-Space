/** Backend iCal sync timestamps are naive UTC (no offset). Parse them as UTC —
 *  same normalization SyncCenter uses — otherwise `new Date()` reads them as
 *  local time and a feed that synced 2h ago shows "just now" in Maine. */
function parseUtc(iso) {
  const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`
  return new Date(norm).getTime()
}

/** Relative-time label for iCal sync timestamps: "just now", "5m ago",
 *  "3h ago", "2d ago". Returns null when the input is empty. */
export function relTimeAgo(iso) {
  if (!iso) return null
  const then = parseUtc(iso)
  if (Number.isNaN(then)) return null
  const ms = Math.max(0, Date.now() - then)
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Mirror of the backend's _ICAL_STALE_AFTER (24h): a feed whose last clean
 *  sync is older than this is "stale" — the same cutoff that drives the
 *  property-level ical_health rollup, so per-feed pills and the rolled-up
 *  "Feed stale" chip never disagree. */
export const ICAL_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** True when a last-synced timestamp is missing or older than the stale
 *  cutoff. Display-only vocabulary helper — no sync logic. */
export function isStaleSync(iso) {
  if (!iso) return true
  const then = parseUtc(iso)
  if (Number.isNaN(then)) return true
  return Date.now() - then > ICAL_STALE_AFTER_MS
}
