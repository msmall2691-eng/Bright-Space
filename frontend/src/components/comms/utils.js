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

/** First name for a friendly SMS greeting: prefers the client's structured
 *  first_name, else the first token of the display name — but never a
 *  phone-number-shaped "name" (unknown senders), where we drop the greeting. */
export function firstNameOf(conv) {
  const client = conv?.client
  const first = (client?.first_name || '').trim()
  if (first) return first
  const raw = client?.name || ''
  if (!raw || isPhoneNumber(raw)) return ''
  return raw.trim().split(/\s+/)[0]
}

/** "Tue, Jun 20 at 9:00 AM" — the human phrase for an appointment, used in
 *  reminder/confirmation SMS. Time is optional (all-day visits omit it). */
export function apptDatePhrase(job) {
  if (!job?.scheduled_date) return ''
  const s = String(job.scheduled_date)
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00`) : new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const t = (job.start_time || '').slice(0, 5)  // "09:00"
  if (!t) return date
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = ((h + 11) % 12) + 1
  return `${date} at ${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

/** Pre-composed SMS templates that pull the real appointment + names, so a
 *  one-tap chip lands a ready-to-send message. `company` falls back upstream;
 *  the greeting is skipped when we don't have a real first name. */
export function apptReminderText({ job, firstName, company }) {
  const hi = firstName ? `Hi ${firstName}, ` : 'Hi, '
  const co = company ? ` from ${company}` : ''
  const when = apptDatePhrase(job)
  return `${hi}friendly reminder${co}: your cleaning is scheduled for ${when}. ` +
    `Reply here if anything changes — see you then!`
}

export function apptConfirmText({ job, firstName }) {
  const hi = firstName ? `Hi ${firstName}, ` : 'Hi, '
  return `${hi}just confirming your cleaning for ${apptDatePhrase(job)}. See you then!`
}

export function onWayText({ firstName }) {
  const hi = firstName ? `Hi ${firstName}, ` : 'Hi, '
  return `${hi}we're on our way for your cleaning now!`
}

/** Best-effort display name for a conversation — client name, external
 *  contact string, or "Unknown". Phone-number-shaped names are prettified. */
export function contactDisplay(conv) {
  const name = conv?.client?.name || conv?.external_contact || 'Unknown'
  return isPhoneNumber(name) ? formatPhone(name) : name
}
