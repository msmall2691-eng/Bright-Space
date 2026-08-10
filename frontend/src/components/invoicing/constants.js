/** Status chip config for invoices — dot + text color + display label
 *  keyed by the persisted status. Consumed by both the row summary
 *  and the send/edit slide-over header. */
export const STATUS = {
  draft:   { dot: 'bg-ink-3',        text: 'text-ink-3',        label: 'Draft'   },
  sent:    { dot: 'bg-blue-400',     text: 'text-blue-400',     label: 'Sent'    },
  paid:    { dot: 'bg-emerald-400',  text: 'text-emerald-400',  label: 'Paid'    },
  overdue: { dot: 'bg-red-400',      text: 'text-red-400',      label: 'Overdue' },
}

/** Invoice status filter options for the list toolbar. `''` = All.
 *  Shared so the Invoicing page can validate an inbound `?status=` deep
 *  link against the same vocabulary the toolbar renders. */
export const STATUS_FILTERS = ['', 'draft', 'sent', 'paid', 'overdue']

/** Deterministic tinted palette for the client avatar chip that
 *  leads each row. `avatar(name)` hashes the first char into an
 *  index so the same client always renders the same color. */
export const AVATAR_COLORS = [
  'bg-violet-500/20 text-violet-300',
  'bg-sky-500/20 text-blue-400',
  'bg-emerald-500/20 text-emerald-300',
  'bg-orange-500/20 text-orange-300',
  'bg-pink-500/20 text-pink-300',
  'bg-yellow-500/20 text-yellow-300',
]

export function avatar(name = '') {
  const i = name.charCodeAt(0) % AVATAR_COLORS.length
  return { color: AVATAR_COLORS[i], initials: name.slice(0, 2).toUpperCase() }
}

/** Blank line-item scaffold used to seed a new draft invoice and to
 *  append rows to an existing form. */
export const EMPTY_ITEM = { name: '', description: '', qty: 1, unit_price: 0 }

/** Shared input / label className strings — every invoice-form
 *  field reuses these so tweaking the focus ring or spacing lands
 *  in one place. */
export const inp = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 transition-colors'
export const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1.5'

/** Line-item subtotal — sum of qty × unit_price with defensive
 *  parseFloat so empty strings coming out of controlled inputs
 *  don't NaN the total. */
export const sub = (items) => items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)

/** Grand total including tax as a percentage. */
export const totalAmt = (items, tax) => sub(items) * (1 + (parseFloat(tax) || 0) / 100)

/** Days past the due date for an unpaid invoice; null if paid or
 *  the invoice isn't overdue yet (so callers can tri-state on
 *  null / positive number without a magic zero). */
export const daysOverdue = (inv) => {
  if (!inv.due_date || inv.status === 'paid') return null
  const diff = Math.floor((Date.now() - new Date(inv.due_date)) / 86400000)
  return diff > 0 ? diff : null
}
