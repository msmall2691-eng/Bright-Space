import { formatPhone } from '../../utils/display'

/** Relative-time label ("now", "5m", "3h", "2d", "Jan 5"). */
export function relTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Just the clock: "14:32" style. */
export function fullTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Header for a day of the thread: Today / Yesterday / "Monday, Jan 5". */
export function dayLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

export function isPhoneNumber(s) { return /^\+?\d[\d\s\-\(\)]+$/.test(s || '') }

/** Best-effort display name for a conversation — client name, external
 *  contact string, or "Unknown". Phone-number-shaped names are prettified. */
export function contactDisplay(conv) {
  const name = conv?.client?.name || conv?.external_contact || 'Unknown'
  return isPhoneNumber(name) ? formatPhone(name) : name
}
