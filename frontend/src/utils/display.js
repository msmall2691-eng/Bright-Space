/**
 * Contact-name display helpers.
 *
 * Production has Client/LeadIntake rows where `name` is a placeholder
 * like "SMS +12075551234" (created by the Twilio inbound webhook for
 * unknown numbers) or just a phone number string. Rendering those
 * directly looks bad — `displayContactName()` derives a usable label
 * by checking, in order:
 *   1. first_name + last_name if either is set
 *   2. name if not a placeholder
 *   3. email local-part (titled), if email is real
 *   4. "Lead <phone>" if a phone exists
 *   5. "Unnamed Lead" as last resort
 *
 * Cherry-picked from PR #12.
 */

export function toTitleCase(input = '') {
  return input
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

export function isPlaceholderName(name = '') {
  const n = name.trim().toLowerCase()
  if (!n) return true
  if (n.startsWith('sms +') || n.startsWith('sms lead')) return true
  if (/^\+?\d{7,}$/.test(n.replace(/[^\d+]/g, ''))) return true
  return false
}

export function displayContactName({ name, first_name, last_name, phone, email } = {}) {
  const first = (first_name || '').trim()
  const last = (last_name || '').trim()
  if (first || last) return `${first} ${last}`.trim()

  const cleanName = (name || '').trim()
  if (cleanName && !isPlaceholderName(cleanName)) return cleanName

  const cleanEmail = (email || '').trim().toLowerCase()
  if (cleanEmail && !cleanEmail.endsWith('@brightbase.test')) {
    const local = cleanEmail.split('@')[0]
    if (local) return toTitleCase(local.replace(/[._-]+/g, ' '))
  }

  if (phone) return `Lead ${phone}`
  return cleanName || 'Unnamed Lead'
}
