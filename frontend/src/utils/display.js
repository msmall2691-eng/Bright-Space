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
  if (['unknown', 'test', 'n/a', 'na', 'webhook test', 'test client', 'brightbase webhook test'].includes(n)) return true
  if (n.startsWith('test ') || n.startsWith('test-') || n.startsWith('test –') || n.startsWith('test —')) return true
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

export function formatPhone(p) {
  if (!p) return ''
  const digits = p.replace(/\D/g, '')
  if (digits.length === 11 && digits[0] === '1')
    return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`
  if (digits.length === 10)
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
  return p
}

// Extract the raw digits from anything a user might type into a phone
// field — parens, dashes, spaces, +, and even a leading "1" country code
// get stripped so downstream validation just looks at the 10-digit NANP
// subscriber number.
export function phoneDigits(p) {
  const digits = (p || '').replace(/\D/g, '')
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
}

// Format-as-you-type: shape whatever the user has typed so far into the
// closest partial `(XXX) XXX-XXXX` template. Callers should feed this
// back into the field's value so the cursor stays intuitive.
export function formatPhoneAsTyping(p) {
  const d = phoneDigits(p).slice(0, 10)
  if (!d) return ''
  if (d.length < 4) return `(${d}`
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

// True when the input contains a plausible 10-digit US phone number.
// Blank inputs return true (nothing to send, nothing to reject); the
// caller decides whether an empty value is acceptable.
export function isValidPhoneUS(p) {
  const digits = phoneDigits(p)
  if (!digits) return true
  return digits.length === 10
}
