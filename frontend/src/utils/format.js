/**
 * Shared formatting helpers.
 *
 * - htmlToText: turn an email/message body that may be raw HTML
 *   ("<!DOCTYPE html><html>…") into readable plain text. Inbound emails arrive
 *   as full HTML documents; rendering the markup verbatim is the "raw HTML body"
 *   bug from the June 15 audit.
 * - formatDateTime / formatDate: render ISO timestamps consistently instead of
 *   leaking "2026-06-15T08:07:53.933Z" next to nicely-formatted dates.
 */

export function htmlToText(input) {
  if (input == null) return ''
  const s = String(input)
  // Fast path: nothing that looks like a tag → already plain text.
  if (!/<[a-z!/][\s\S]*>/i.test(s)) return s.trim()
  try {
    const doc = new DOMParser().parseFromString(s, 'text/html')
    // Strip non-content nodes so their CSS/JS text doesn't bleed in.
    doc.querySelectorAll('style, script, head').forEach((el) => el.remove())
    const text = doc.body ? doc.body.textContent || '' : ''
    return text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    // jsdom/parse failure — fall back to a regex strip.
    return s.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
  }
}

export function formatDateTime(value, opts) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value) // not a date — leave as-is
  return d.toLocaleString('en-US', opts || {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export function formatDate(value, opts) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-US', opts || {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}
