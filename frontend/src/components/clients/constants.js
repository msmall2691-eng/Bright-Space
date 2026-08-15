/** Status dot color shared by the row chip + the inline select — status
 *  hue lives in the small dot over a quiet chip body (no tinted pills). */
export const STATUS_COLORS = {
  lead:     'bg-amber-500',
  active:   'bg-emerald-500',
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
  'bg-indigo-600/20 text-blue-400',
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
  status: 'lead', source: '', notes: '', custom_fields: {},
}

/** Default visible-columns list for the table view. Saved views can
 *  override this by storing their own `columns` array. */
export const DEFAULT_CLIENT_COLUMNS = ['name', 'phone', 'email', 'city', 'source', 'status']
