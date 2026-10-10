/** Status dot color shared by the row chip + the inline select — status
 *  hue lives in the small dot over a quiet chip body (no tinted pills). */
import { STATUS_DOT } from '../../theme/statusDots'
export const STATUS_COLORS = {
  lead:     STATUS_DOT.attention,
  active:   STATUS_DOT.ok,
  inactive: 'bg-ink-3',
}

/** Options for the inline-editable status chip in the table
 *  (Twenty-style). Each carries the leading dot color so InlineSelect can
 *  render them without extra lookups. */
export const STATUS_OPTIONS = [
  { value: 'lead',     label: 'lead',     dot: STATUS_COLORS.lead },
  { value: 'active',   label: 'active',   dot: STATUS_COLORS.active },
  { value: 'inactive', label: 'inactive', dot: STATUS_COLORS.inactive },
]

/** Deterministic tinted palette for row avatars. `avatarColor(name)`
 *  hashes the name into an index — same name always gets the same
 *  color across the app. */
export const AVATAR_COLORS = [
  'bg-indigo-600/20 text-link',
  'bg-emerald-600/20 text-emerald-400',
  'bg-violet-600/20 text-violet-400',
  'bg-amber-600/20 text-amber-400',
  'bg-rose-600/20 text-rose-400',
  'bg-cyan-600/20 text-cyan-400',
]

export function avatarColor(name) {
  let h = 0
  for (const c of (name || '')) h = ((h << 5) - h + c.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

/** Empty scaffold for a new/reset client form. Keep every persisted
 *  field here so `setForm(EMPTY)` fully resets state between edits. */
export const EMPTY = {
  first_name: '', last_name: '', email: '', phone: '',
  address: '', city: '', state: '', zip_code: '',
  billing_address: '', billing_city: '', billing_state: '', billing_zip: '',
  // A client you add by hand is someone you're working with — start them
  // Active, not as a lead. Website/intake leads come in through Requests and
  // are promoted to a client on conversion; this form is the office entering a
  // real customer, and defaulting to lead is what regrew the lead pile that
  // guardrail #5 had to hide. (Still editable in the form's status field.)
  status: 'active', source: '', notes: '', custom_fields: {},
}

/** Default visible-columns list for the table view. Saved views can
 *  override this by storing their own `columns` array. */
export const DEFAULT_CLIENT_COLUMNS = ['name', 'phone', 'email', 'city', 'balance', 'next_visit', 'status']

/** The status tab the Clients list lands on. Active, not "" (All) — the book
 *  is mostly leads (an import left ~100 lead rows against ~40 real customers),
 *  and the old All default buried the people the office actually works with
 *  under that pile. Leads stay one tap away (the Leads tab / the clickable
 *  "Leads" stat), and website leads live on their own Requests page. */
export const DEFAULT_CLIENT_STATUS = 'active'
