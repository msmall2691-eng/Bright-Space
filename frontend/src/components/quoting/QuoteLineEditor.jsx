/**
 * The line items on a quote, editable where you read them.
 *
 * The quote page could Send, Preview, Download, Copy and Archive a quote —
 * everything except change what it says. Title, valid-until and address were
 * click-to-edit; the items, quantities, prices, discount and tax were a
 * read-only table, and the only editor lived on a different page reachable by
 * knowing to click a row there. Owner report: "I'm not able to edit the quotes
 * easily." The capability existed; it wasn't where she was.
 *
 * CLICK-TO-EDIT PER CELL, not a form mode. It matches the rest of this page,
 * and it means changing one price is one click and one number rather than
 * entering and leaving an editor. Escape cancels a cell, so a mis-click costs
 * nothing.
 *
 * THE SERVER OWNS THE MONEY. Every commit PATCHes the whole `items` array and
 * takes back the quote the server recomputed (_compute_totals). The preview
 * while you type is local, but nothing is ever *stored* from arithmetic done
 * here — two implementations of a total is how a quote and an invoice come to
 * disagree by a penny.
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { patch } from '../../api'
import { toast } from '../../utils/toastBus'

const money = (n) => `$${Number(n || 0).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Items arrive in two historical shapes (qty/quantity, unit_price/price).
 *  Normalize on read so the editor only ever deals in one, and write back the
 *  canonical shape the backend's _items_to_dicts expects. */
export function normalizeItems(items) {
  return (items || []).map(it => ({
    name: it.name || '',
    description: it.description || '',
    qty: Number(it.qty ?? it.quantity ?? 1) || 0,
    unit_price: Number(it.unit_price ?? it.price ?? 0) || 0,
  }))
}

export const lineTotal = (it) => (Number(it.qty) || 0) * (Number(it.unit_price) || 0)
export const subtotalOf = (items) => (items || []).reduce((s, it) => s + lineTotal(it), 0)

/** One click-to-edit cell. Text or number, right-aligned for money. */
function Cell({ value, onCommit, type = 'text', align = 'left', placeholder, editable, className = '' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const start = () => { if (!editable) return; setDraft(value == null ? '' : String(value)); setEditing(true) }
  const commit = () => {
    setEditing(false)
    const next = type === 'number' ? (draft.trim() === '' ? 0 : Number(draft)) : draft.trim()
    if (type === 'number' && !Number.isFinite(next)) return
    if (String(next) === String(value ?? '')) return
    onCommit(next)
  }

  if (editing) {
    return (
      <input
        autoFocus type={type === 'number' ? 'number' : 'text'}
        step={type === 'number' ? 'any' : undefined}
        value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setEditing(false)
        }}
        className={`w-full bg-panel border border-blue-400 rounded px-1.5 py-0.5 text-[13px] text-ink
          focus:outline-none focus:ring-1 focus:ring-blue-400/30 ${align === 'right' ? 'text-right' : ''} ${className}`}
      />
    )
  }
  const shown = value === '' || value == null ? null : value
  return (
    <button type="button" onClick={start} disabled={!editable}
      title={editable ? 'Click to edit' : undefined}
      className={`w-full rounded px-1 -mx-1 py-0.5 transition-colors ${align === 'right' ? 'text-right' : 'text-left'} ${
        editable ? 'hover:bg-bg-2 cursor-text' : 'cursor-default'} ${className}`}>
      {shown ?? <span className="text-ink-3 italic">{placeholder}</span>}
    </button>
  )
}

export default function QuoteLineEditor({ quote, editable = false, onSaved }) {
  const [items, setItems] = useState(() => normalizeItems(quote.items))
  const [saving, setSaving] = useState(false)

  // The customer is looking at whatever was in the email. Any edit after that
  // makes their copy and this one disagree, silently, until she resends —
  // which is exactly the trap worth naming out loud rather than leaving her to
  // discover it on a phone call.
  const sentAt = quote.sent_at ? Date.parse(quote.sent_at) : null
  const updatedAt = quote.updated_at ? Date.parse(quote.updated_at) : null
  const staleForCustomer = Boolean(sentAt && updatedAt && updatedAt > sentAt)

  const persist = async (nextItems, extra = {}) => {
    const before = items
    setItems(nextItems)          // optimistic: typing shouldn't wait on a round trip
    setSaving(true)
    try {
      const updated = await patch(`/api/quotes/${quote.id}`, { items: nextItems, ...extra })
      // The server recomputed subtotal/tax/total — take its answer, not ours.
      setItems(normalizeItems(updated.items))
      onSaved?.(updated)
    } catch (e) {
      setItems(before)           // put the old numbers back rather than showing a lie
      toast.error(e?.detail || e?.message || 'Could not save that change')
    } finally {
      setSaving(false)
    }
  }

  const setField = (i, key, value) =>
    persist(items.map((it, idx) => (idx === i ? { ...it, [key]: value } : it)))

  const addLine = () =>
    persist([...items, { name: '', description: '', qty: 1, unit_price: 0 }])

  const removeLine = (i) => persist(items.filter((_, idx) => idx !== i))

  const liveSubtotal = subtotalOf(items)

  return (
    <div className="bg-panel border border-hairline rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] min-w-[420px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-ink-3 border-b border-hairline">
              <th className="text-left font-medium px-3 py-2">Item</th>
              <th className="text-right font-medium px-3 py-2 w-16">Qty</th>
              <th className="text-right font-medium px-3 py-2 w-24">Unit</th>
              <th className="text-right font-medium px-3 py-2 w-24">Amount</th>
              {editable && <th className="w-8" aria-label="Remove" />}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={editable ? 5 : 4} className="text-center text-ink-3 italic py-6">
                  No line items{editable ? ' — add one below' : ''}
                </td>
              </tr>
            ) : items.map((it, i) => (
              <tr key={i} className="border-b border-hairline/60 last:border-0 align-top">
                <td className="px-3 py-2 text-ink">
                  <Cell value={it.name} editable={editable} placeholder="Item"
                    onCommit={v => setField(i, 'name', v)} />
                  <Cell value={it.description} editable={editable} placeholder="Add a description"
                    className="text-[11px] text-ink-3"
                    onCommit={v => setField(i, 'description', v)} />
                </td>
                <td className="px-3 py-2 text-ink-2">
                  <Cell value={it.qty} type="number" align="right" editable={editable}
                    onCommit={v => setField(i, 'qty', v)} />
                </td>
                <td className="px-3 py-2 text-ink-2">
                  <Cell value={it.unit_price} type="number" align="right" editable={editable}
                    onCommit={v => setField(i, 'unit_price', v)} />
                </td>
                {/* Derived, never typed — the one number on the row that can't
                    disagree with the other two. */}
                <td className="px-3 py-2 text-right text-ink">{money(lineTotal(it))}</td>
                {editable && (
                  <td className="px-1 py-2 text-right">
                    <button type="button" onClick={() => removeLine(i)} disabled={saving}
                      aria-label={`Remove ${it.name || 'line'}`}
                      title="Remove this line"
                      className="p-1 rounded text-ink-3 hover:text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="border-t border-hairline px-3 py-2">
          <button type="button" onClick={addLine} disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add a line
          </button>
        </div>
      )}

      <div className="border-t border-hairline px-3 py-2 space-y-1 text-[13px]">
        <div className="flex justify-between text-ink-2">
          <span>Subtotal</span>
          {/* Shows the live sum while a save is in flight so the number never
              lags a keystroke behind the rows above it. */}
          <span>{money(saving ? liveSubtotal : (quote.subtotal ?? liveSubtotal))}</span>
        </div>
        <div className="flex justify-between text-ink-2">
          <span>Discount</span>
          <span className="w-24">
            <Cell value={quote.discount || 0} type="number" align="right" editable={editable}
              onCommit={v => persist(items, { discount: v })} />
          </span>
        </div>
        <div className="flex justify-between text-ink-2">
          <span>Tax rate %</span>
          <span className="w-24">
            <Cell value={quote.tax_rate || 0} type="number" align="right" editable={editable}
              onCommit={v => persist(items, { tax_rate: v })} />
          </span>
        </div>
        <div className="flex justify-between text-ink-2">
          <span>Tax</span><span>{money(quote.tax)}</span>
        </div>
        <div className="flex justify-between font-semibold text-ink pt-1 border-t border-hairline">
          <span>Total</span><span>{money(quote.total)}</span>
        </div>
      </div>

      {staleForCustomer && (
        /* Dot + sentence, not a tinted banner (brightbase-design-language). */
        <div className="border-t border-hairline px-3 py-2">
          <p className="flex items-start gap-1.5 text-[12px] text-ink-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
            <span>
              Changed since you sent it — the customer still sees the old version
              until you resend.
            </span>
          </p>
        </div>
      )}
    </div>
  )
}
