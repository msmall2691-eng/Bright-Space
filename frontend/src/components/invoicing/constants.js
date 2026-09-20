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

/** The client initials chip that leads each row. Deliberately a single
 *  neutral surface, not a per-client color: in this design language color
 *  belongs to data (status, overdue), never to decorative chrome, so a
 *  rainbow of tinted avatars was exactly the SaaS look the owner vetoed. */
export function avatar(name = '') {
  return { color: 'bg-bg-2 text-ink-2', initials: name.slice(0, 2).toUpperCase() }
}

/** Blank line-item scaffold used to seed a new draft invoice and to
 *  append rows to an existing form. */
export const EMPTY_ITEM = { name: '', description: '', qty: 1, unit_price: 0 }

/** Shared input / label className strings — every invoice-form
 *  field reuses these so tweaking the focus ring or spacing lands
 *  in one place. */
export const inp = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400 transition-colors'
export const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1.5'

/** Line-item subtotal — sum of qty × unit_price with defensive
 *  parseFloat so empty strings coming out of controlled inputs
 *  don't NaN the total. */
export const sub = (items) => items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)

/** Grand total: subtotal + tax (a percentage), less a flat dollar discount.
 *  Discount is subtracted AFTER tax, matching the backend's calc_totals and the
 *  quote's own math (BB-INV-01). */
export const totalAmt = (items, tax, discount = 0) =>
  sub(items) * (1 + (parseFloat(tax) || 0) / 100) - (parseFloat(discount) || 0)

/** Days past the due date for an unpaid invoice; null if paid or
 *  the invoice isn't overdue yet (so callers can tri-state on
 *  null / positive number without a magic zero). */
export const daysOverdue = (inv) => {
  if (!inv.due_date || inv.status === 'paid') return null
  const diff = Math.floor((Date.now() - new Date(inv.due_date)) / 86400000)
  return diff > 0 ? diff : null
}
