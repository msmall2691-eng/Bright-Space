import { useState } from 'react'
import { X, Plus, Send, Eye, Trash2, ChevronRight } from 'lucide-react'
import AddressAutocomplete from '../AddressAutocomplete'
import { CustomFieldsForm } from '../CustomFields'
import QuotePreview from '../QuotePreview'
import { SERVICE_TYPES, EMPTY_ITEM, isPlaceholderName } from './constants'

/** Right-side (bottom-sheet on mobile) quote-editor panel.
 *
 *  Purposefully accepts a lot of parent-owned state (form, newClient,
 *  quoteTemplates, clients, company, and the mutation callbacks) — the
 *  parent's `openQuoteForm` already seeds `form`, `selectedIntake`, and
 *  `showQuoteAdvanced` in tandem, so pulling those bits inside the
 *  component would fragment the flow. UI-only toggles (`previewMode`,
 *  inline-new-client `addingClient` + `clientErr`) live locally. */

// Pure totals math — moved out of the parent since only this panel reads it.
const subtotal = (items) => items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)
const taxAmt = (items, rate) => subtotal(items) * (parseFloat(rate) || 0) / 100
const total = (items, rate) => subtotal(items) + taxAmt(items, rate)

export default function QuoteEditPanel({
  selected,
  selectedIntake,
  form,
  setForm,
  clients,
  quoteTemplates,
  canEdit,
  company,
  saving,
  creatingClient,
  newClient,
  setNewClient,
  showQuoteAdvanced,
  setShowQuoteAdvanced,
  selectClient,
  createInlineClient,
  updateItem,
  onSave,
  onClose,
  onSend,
  // Optional controlled pair — Quoting.jsx lifts this so openFromIntake
  // can force the "add client" form open when a request has no matched
  // client. Falls back to local state for other callers.
  addingClient: addingClientProp,
  setAddingClient: setAddingClientProp,
}) {
  const [previewMode, setPreviewMode] = useState(false)
  const [addingClientLocal, setAddingClientLocal] = useState(false)
  const addingClient = addingClientProp ?? addingClientLocal
  const setAddingClient = setAddingClientProp ?? setAddingClientLocal
  const [clientErr, setClientErr] = useState('')

  const handleCreateClient = async () => {
    setClientErr('')
    try {
      await createInlineClient()
      setAddingClient(false)
    } catch (e) {
      setClientErr(e?.message || 'Could not create client')
    }
  }

  return (
    <div className={`fixed inset-0 z-40 bg-panel flex flex-col pb-bottomnav sm:pb-0 sm:static sm:inset-auto sm:z-auto sm:border-l sm:border-hairline sm:shrink-0 ${previewMode ? 'sm:w-[500px] 2xl:w-[900px]' : 'sm:w-[500px]'}`}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
        <div>
          <h2 className="font-semibold text-ink">{selected ? `Edit ${selected.quote_number}` : 'New Quote'}</h2>
          {selectedIntake && <p className="text-xs text-ink-3 mt-0.5">From: {selectedIntake.name}</p>}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setPreviewMode(p => !p)}
            title="Toggle the customer's view"
            className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${
              previewMode ? 'bg-blue-600 text-white border-blue-600' : 'bg-bg-2 text-ink-2 border-hairline hover:bg-hairline'
            }`}>
            <Eye className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Preview</span>
          </button>
          <button onClick={onClose} className="text-ink-3 hover:text-ink p-1"><X className="w-5 h-5" /></button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Editor column */}
        <div className={`overflow-y-auto p-6 space-y-5 scrollbar-thin ${previewMode ? 'hidden 2xl:block 2xl:w-[460px] 2xl:shrink-0 2xl:border-r 2xl:border-hairline' : 'flex-1'}`}>

          {/* Lead's website instant-quote estimate */}
          {selectedIntake && (selectedIntake.estimate_min != null || selectedIntake.estimate_max != null) && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              <span className="font-semibold">Website instant quote:</span>{' '}
              {selectedIntake.estimate_min != null && selectedIntake.estimate_max != null
                ? `$${selectedIntake.estimate_min}–$${selectedIntake.estimate_max}`
                : `$${selectedIntake.estimate_max ?? selectedIntake.estimate_min}`}
              <span className="text-blue-700"> — pre-filled below; adjust as needed.</span>
            </div>
          )}

          {/* Delivery banner — the last send attempt failed */}
          {selected && selected.last_send_error && ['draft', 'sent', 'viewed'].includes(selected.status) && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
              <div className="font-semibold text-red-800 mb-1">Last send failed — the customer didn't get this quote</div>
              <div className="text-red-900">{selected.last_send_error}</div>
              {selected.last_send_attempt_at && <div className="text-[11px] text-red-700 mt-1">{new Date(selected.last_send_attempt_at).toLocaleString()}</div>}
            </div>
          )}

          {/* Customer response banners */}
          {selected && selected.requested_changes_message && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <div className="font-semibold text-amber-800 mb-1">Customer requested changes</div>
              <div className="text-amber-900 whitespace-pre-wrap">“{selected.requested_changes_message}”</div>
              {selected.requested_changes_at && <div className="text-[11px] text-amber-700 mt-1">{new Date(selected.requested_changes_at).toLocaleString()}</div>}
            </div>
          )}
          {selected && selected.status === 'accepted' && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
              <div className="font-semibold text-emerald-800">Accepted{selected.accepted_by_name ? ` by ${selected.accepted_by_name}` : ''} ✓</div>
              {selected.accepted_at && <div className="text-[11px] text-emerald-700 mt-0.5">{new Date(selected.accepted_at).toLocaleString()}</div>}
            </div>
          )}
          {selected && selected.status === 'declined' && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
              <div className="font-semibold text-red-800">Declined{selected.declined_by_name ? ` by ${selected.declined_by_name}` : ''}</div>
              {selected.declined_reason && <div className="text-red-900 mt-0.5">“{selected.declined_reason}”</div>}
              {selected.declined_at && <div className="text-[11px] text-red-700 mt-0.5">{new Date(selected.declined_at).toLocaleString()}</div>}
            </div>
          )}

          {/* Title — customer-facing. Renders as the header on the quote
              email and PDF, so staff need to know it's not a scratchpad. */}
          <div>
            <label className="block text-xs text-ink-3 mb-1">Quote Title</label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Biweekly cleaning — 12 Pier Rd"
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            <p className="mt-1 text-[11px] text-ink-3">
              Shown to the customer as the email + PDF header. Skip internal
              notes here — use the Notes field below for those.
            </p>
          </div>

          {/* Client */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-ink-3">Client *</label>
              <button type="button"
                onClick={() => { setAddingClient(a => !a); setClientErr('') }}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                {addingClient ? 'Cancel' : '+ New client'}
              </button>
            </div>
            {addingClient && (
              <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 space-y-2 mb-2">
                <input autoFocus value={newClient.name} onChange={e => setNewClient(n => ({ ...n, name: e.target.value }))}
                  placeholder="Client name *"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                <div className="grid grid-cols-2 gap-2">
                  <input value={newClient.phone} onChange={e => setNewClient(n => ({ ...n, phone: e.target.value }))}
                    placeholder="Phone"
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                  <input value={newClient.email} onChange={e => setNewClient(n => ({ ...n, email: e.target.value }))}
                    placeholder="Email"
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                </div>
                {clientErr && <div className="text-xs text-red-600">{clientErr}</div>}
                <button type="button" onClick={handleCreateClient} disabled={creatingClient || !newClient.name.trim()}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                  {creatingClient ? 'Creating…' : 'Create & select client'}
                </button>
              </div>
            )}
            <select value={form.client_id} onChange={e => selectClient(e.target.value)}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
              <option value="">Select client...</option>
              {(() => {
                // Dedupe + sort: real names first, placeholders last w/ marker.
                // Surfaces email/phone so two same-name clients are distinguishable.
                const seen = new Set()
                const sorted = [...clients].filter(c => {
                  if (seen.has(c.id)) return false
                  seen.add(c.id); return true
                }).sort((a, b) => {
                  const ap = isPlaceholderName(a.name) ? 1 : 0
                  const bp = isPlaceholderName(b.name) ? 1 : 0
                  if (ap !== bp) return ap - bp
                  return (a.name || '').localeCompare(b.name || '')
                })
                return sorted.map(c => {
                  const tag = isPlaceholderName(c.name) ? ' (placeholder)' : ''
                  const contact = [c.email, c.phone].filter(Boolean).join(' · ')
                  const label = `${c.name || '(no name)'}${tag}${contact ? ' — ' + contact : ''}`
                  return <option key={c.id} value={c.id}>{label}</option>
                })
              })()}
            </select>
          </div>

          {/* Service type */}
          <div>
            <label className="block text-xs text-ink-3 mb-1.5">Service Type</label>
            <div className="flex gap-2">
              {SERVICE_TYPES.map(t => (
                <button key={t} onClick={() => setForm(f => ({ ...f, service_type: t }))}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${form.service_type === t ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                  {t === 'str' ? 'STR / Vacation' : t}
                </button>
              ))}
            </div>
          </div>

          {/* Address */}
          <div>
            <label className="block text-xs text-ink-3 mb-1">Service Address</label>
            <AddressAutocomplete
              value={form.address}
              onChange={v => setForm(f => ({ ...f, address: v }))}
              onSelect={p => setForm(f => ({ ...f, address: p.address || f.address }))}
              selectOnFocus
              placeholder="123 Main St, Portland, ME 04101"
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          </div>

          {/* Templates */}
          <div>
            <label className="text-xs text-ink-3 block mb-1">Start from template</label>
            <select
              value=""
              onChange={e => {
                const tpl = quoteTemplates.find(t => t.id === e.target.value)
                if (!tpl) return
                setForm(f => ({
                  ...f,
                  service_type: tpl.service_type,
                  items: tpl.items.map(it => ({ ...it })),
                  title: f.title || tpl.title || '',
                  customer_message: f.customer_message || tpl.customer_message || '',
                }))
                e.target.value = ''
              }}
              className="w-full px-3 py-2 bg-bg-2 border border-hairline-2 rounded-md text-white text-sm"
            >
              <option value="">Custom (build from scratch)</option>
              {quoteTemplates.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-ink-3 mt-1">Pick a template to pre-fill the line items. You can still edit everything.</p>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-ink-3">Line Items</label>
              <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1">
                <Plus className="w-3 h-3" /> Add item
              </button>
            </div>
            <div className="space-y-2">
              {form.items.map((item, i) => (
                <div key={i} className="bg-bg-2 rounded-lg p-3 space-y-2">
                  <div className="flex gap-2">
                    <input value={item.name} onChange={e => updateItem(i, 'name', e.target.value)}
                      placeholder="e.g. Standard Home Clean"
                      className="flex-1 bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none focus:border-blue-400" />
                    <button onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                      className="text-ink-3 hover:text-red-400 shrink-0"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  <input value={item.description} onChange={e => updateItem(i, 'description', e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full bg-bg-2 border border-hairline rounded px-2 py-1.5 text-xs text-ink-3 focus:outline-none" />
                  <div className="flex gap-2">
                    <div className="w-20">
                      <label className="text-xs text-ink-3">Qty</label>
                      <input type="number" inputMode="decimal" min="0" step="0.5" value={item.qty}
                        onChange={e => updateItem(i, 'qty', e.target.value)}
                        onFocus={e => e.target.select()}
                        className="w-full bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none mt-0.5" />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-ink-3">Unit Price ($)</label>
                      {/* select-all on focus so typing replaces the pre-filled "0"
                          instead of appending — otherwise typing 150 gives 0150. */}
                      <input type="number" inputMode="decimal" min="0" step="5" value={item.unit_price}
                        onChange={e => updateItem(i, 'unit_price', e.target.value)}
                        onFocus={e => e.target.select()}
                        className="w-full bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none mt-0.5" />
                    </div>
                    <div className="flex-1 flex flex-col justify-end">
                      <label className="text-xs text-ink-3">Line Total</label>
                      <div className="text-sm font-semibold text-ink mt-1.5">${((parseFloat(item.qty) || 0) * (parseFloat(item.unit_price) || 0)).toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Tax + valid until */}
          <div className="flex gap-3">
            <div className="w-28">
              <label className="block text-xs text-ink-3 mb-1">Tax (%)</label>
              <input type="number" min="0" max="100" value={form.tax_rate} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-ink-3 mb-1">Valid Until <span className="text-ink-3/70">(30 days default)</span></label>
              <input type="date" value={form.valid_until} onChange={e => setForm(f => ({ ...f, valid_until: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
            </div>
          </div>

          {/* Totals summary */}
          <div className="bg-bg-2 rounded-xl p-4 space-y-1.5 text-sm">
            <div className="flex justify-between text-ink-3">
              <span>Subtotal</span><span>${subtotal(form.items).toFixed(2)}</span>
            </div>
            {parseFloat(form.tax_rate) > 0 && (
              <div className="flex justify-between text-ink-3">
                <span>Tax ({form.tax_rate}%)</span><span>${taxAmt(form.items, form.tax_rate).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-ink text-base border-t border-hairline pt-2">
              <span>Total</span><span>${total(form.items, form.tax_rate).toFixed(2)}</span>
            </div>
          </div>

          {/* Optional copy (scope, internal notes, customer message) — collapsible */}
          <button type="button" onClick={() => setShowQuoteAdvanced(v => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-2 hover:text-ink">
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showQuoteAdvanced ? 'rotate-90' : ''}`} />
            Scope, notes & customer message
            {!showQuoteAdvanced && (form.notes || form.internal_notes || form.customer_message) && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            )}
          </button>

          {showQuoteAdvanced && (
            <>
              <div>
                <label className="block text-xs text-ink-3 mb-1">Scope / Notes <span className="text-amber-600 font-medium">(customer sees this)</span></label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                  placeholder="What's included / excluded — shown on the quote the customer opens."
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1">Internal Notes <span className="text-ink-3">(never shown to the customer)</span></label>
                <textarea value={form.internal_notes} onChange={e => setForm(f => ({ ...f, internal_notes: e.target.value }))} rows={2}
                  placeholder="Lead context, access details, reminders — stays in the app."
                  className="w-full bg-bg-2 border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1">Message to Customer</label>
                <textarea value={form.customer_message} onChange={e => setForm(f => ({ ...f, customer_message: e.target.value }))} rows={3}
                  placeholder="Hi! Thanks for reaching out — here's the quote we discussed. Looking forward to working with you."
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
                <p className="text-[11px] text-ink-3 mt-1">Shown at the top of the emailed quote and the online quote page.</p>
              </div>
            </>
          )}

          {/* Admin-defined custom fields for quotes */}
          <CustomFieldsForm
            entityType="quote"
            values={form.custom_fields || {}}
            onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
          />
        </div>

        {/* Preview column */}
        {previewMode && (
          <div className="flex-1 overflow-y-auto p-6 bg-bg scrollbar-thin">
            <QuotePreview form={form} quoteNumber={selected?.quote_number} company={company} />
          </div>
        )}
      </div>

      {canEdit ? (
        <div className="p-6 border-t border-hairline flex gap-3 shrink-0">
          <button onClick={onSave} disabled={saving || (!form.client_id && !newClient.name.trim())}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
            {saving ? 'Saving...' : selected ? 'Update Quote' : 'Create Quote'}
          </button>
          {selected && (
            <button onClick={() => onSend(selected)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              <Send className="w-4 h-4" /> Send
            </button>
          )}
        </div>
      ) : (
        <div className="p-6 border-t border-hairline shrink-0 text-xs text-ink-3">Read-only — your role can't edit quotes.</div>
      )}
    </div>
  )
}
