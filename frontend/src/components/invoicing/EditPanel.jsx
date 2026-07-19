import { ChevronRight, FileText, Plus, Send, Trash2, X } from 'lucide-react'
import { CustomFieldsForm } from '../CustomFields'
import { EMPTY_ITEM, inp, lbl, sub, totalAmt } from './constants'

/** Slide-over Edit/Create invoice form: client picker, dynamic
 *  line items (add / remove / edit qty + unit price), tax + due
 *  date row, folded "Notes & more" advanced section (notes +
 *  CustomFieldsForm), running totals card, and footer save +
 *  optional delete button.
 *
 *  Fully controlled — parent owns every piece of form state, the
 *  selected invoice, the show-advanced flag, saving/deleting
 *  flags, and every handler. */
export function EditPanel({
  selected,
  form, setForm,
  updateItem,
  showInvAdvanced, setShowInvAdvanced,
  saving, save,
  deleting, deleteInvoice,
  closePanel,
  openSend,
  clients,
  clientName,
}) {
  return (
    <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[420px] sm:shrink-0 sm:border-l sm:border-hairline">

      {/* Panel header */}
      <div className="flex items-start justify-between px-6 py-5 border-b border-hairline">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-bg flex items-center justify-center">
              <FileText className="w-3.5 h-3.5 text-ink-3" />
            </div>
            <span className="text-sm font-semibold text-ink">
              {selected ? selected.invoice_number : 'New invoice'}
            </span>
          </div>
          {selected && <p className="text-xs text-ink-3 mt-1 ml-8">{clientName(selected.client_id)}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {selected && selected.status !== 'paid' && (
            <button onClick={() => openSend(selected)}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-bg text-ink-3 hover:bg-bg-2 transition-colors">
              <Send className="w-3 h-3" /> Send
            </button>
          )}
          <button onClick={closePanel}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-3 hover:text-ink-3 hover:bg-bg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Form body */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-6 space-y-6">

        {/* Client */}
        <div>
          <label className={lbl}>Client</label>
          <select value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}
            className={inp + ' bg-bg'}>
            <option value="">Select a client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className={lbl.replace('mb-1.5', '')}>Line Items</label>
            <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
              className="flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-400 transition-colors">
              <Plus className="w-3 h-3" /> Add line
            </button>
          </div>
          <div className="space-y-2">
            {form.items.map((item, i) => (
              <div key={i} className="rounded-lg border border-hairline bg-bg p-3 space-y-2">
                <div className="flex gap-2 items-center">
                  <input value={item.name} onChange={e => updateItem(i, 'name', e.target.value)}
                    placeholder="Description"
                    className="flex-1 bg-transparent border-none text-sm text-ink placeholder-ink-3 focus:outline-none" />
                  <button onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                    className="text-ink-2 hover:text-red-400 transition-colors shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex gap-2 items-center border-t border-hairline pt-2">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-ink-3 w-6">Qty</span>
                    <input type="number" value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)}
                      onFocus={e => e.target.select()}
                      className="w-14 bg-transparent text-xs text-ink-3 focus:outline-none text-center border border-hairline rounded px-1 py-0.5" />
                  </div>
                  <span className="text-ink-2">×</span>
                  <div className="flex items-center gap-1 flex-1">
                    <span className="text-[10px] text-ink-3">$</span>
                    <input type="number" value={item.unit_price} onChange={e => updateItem(i, 'unit_price', e.target.value)}
                      onFocus={e => e.target.select()}
                      className="flex-1 bg-transparent text-xs text-ink-3 focus:outline-none border border-hairline rounded px-2 py-0.5" />
                  </div>
                  <span className="text-xs font-medium text-ink w-16 text-right">
                    ${((parseFloat(item.qty) || 0) * (parseFloat(item.unit_price) || 0)).toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Tax + due date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Tax %</label>
            <input type="number" value={form.tax_rate} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}
              className={inp + ' bg-bg'} />
          </div>
          <div>
            <label className={lbl}>Due Date</label>
            <input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
              className={inp + ' bg-bg'} />
          </div>
        </div>

        {/* Notes + custom fields — folded away from the everyday path. */}
        <button type="button" onClick={() => setShowInvAdvanced(v => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-ink-2 hover:text-ink">
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showInvAdvanced ? 'rotate-90' : ''}`} />
          Notes &amp; more
          {!showInvAdvanced && form.notes && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
        </button>

        {showInvAdvanced && (<>
          <div>
            <label className={lbl}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3} placeholder="Payment instructions, bank details…"
              className={inp + ' bg-bg resize-none'} />
          </div>

          <CustomFieldsForm
            entityType="invoice"
            values={form.custom_fields || {}}
            onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
          />
        </>)}

        {/* Totals */}
        <div className="rounded-xl border border-hairline bg-bg overflow-hidden">
          <div className="flex justify-between px-4 py-2.5 border-b border-hairline">
            <span className="text-xs text-ink-3">Subtotal</span>
            <span className="text-xs text-ink-3">${sub(form.items).toFixed(2)}</span>
          </div>
          <div className="flex justify-between px-4 py-2.5 border-b border-hairline">
            <span className="text-xs text-ink-3">Tax ({form.tax_rate || 0}%)</span>
            <span className="text-xs text-ink-3">${(sub(form.items) * (parseFloat(form.tax_rate) || 0) / 100).toFixed(2)}</span>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-sm font-semibold text-ink">Total</span>
            <span className="text-sm font-semibold text-ink">${totalAmt(form.items, form.tax_rate).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Panel footer */}
      <div className="p-5 border-t border-hairline space-y-2">
        <button onClick={save} disabled={saving || !form.client_id}
          className="w-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
          {saving ? 'Saving…' : (selected ? 'Update invoice' : 'Create invoice')}
        </button>
        {selected && (
          <button onClick={deleteInvoice} disabled={deleting}
            className="w-full flex items-center justify-center gap-2 text-red-500/70 hover:text-red-400 hover:bg-red-500/[0.08] px-4 py-2 rounded-lg text-xs transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
            {deleting ? 'Deleting…' : 'Delete invoice'}
          </button>
        )}
      </div>
    </div>
  )
}
