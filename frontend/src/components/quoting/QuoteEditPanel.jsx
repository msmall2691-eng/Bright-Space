import { useState } from 'react'
import { X, Plus, Send, Eye, Trash2, ChevronRight, Home, Loader2, Search } from 'lucide-react'
import AddressAutocomplete from '../AddressAutocomplete'
import PropertyPhoto from '../PropertyPhoto'
import { CustomFieldsForm } from '../CustomFields'
import QuotePreview from '../QuotePreview'
import OriginalRequestCard from './OriginalRequestCard'
import AiInsight from '../AiInsight'
import { get } from '../../api'
import { EMPTY_ITEM, isPlaceholderName, serviceOptions, scopeForService } from './constants'

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
  serviceScopes,
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

  // Property spec lookup (RentCast) — pull beds/baths/sqft from the address so
  // the admin doesn't have to research each property by hand before quoting.
  const [specs, setSpecs] = useState(null)      // { square_footage, bedrooms, bathrooms, year_built, property_type }
  const [specsState, setSpecsState] = useState('idle') // idle | loading | none | disabled | done
  const lookupSpecs = async (addr) => {
    const a = (addr ?? form.address ?? '').trim()
    if (!a) return
    setSpecsState('loading'); setSpecs(null)
    try {
      const r = await get(`/api/quotes/property-lookup?address=${encodeURIComponent(a)}`)
      if (!r?.enabled) { setSpecsState('disabled'); return }
      if (r?.specs) { setSpecs(r.specs); setSpecsState('done') }
      else setSpecsState('none')
    } catch {
      setSpecsState('none')
    }
  }
  const specsSummary = (s) => [
    s.bedrooms != null && `${s.bedrooms} bd`,
    s.bathrooms != null && `${s.bathrooms} ba`,
    s.square_footage != null && `${Number(s.square_footage).toLocaleString()} sqft`,
    s.year_built && `built ${s.year_built}`,
  ].filter(Boolean).join(' · ')
  const addSpecsToScope = () => {
    if (!specs) return
    const line = specsSummary(specs)
    setForm(f => {
      const items = f.items.length ? [...f.items] : [{ ...EMPTY_ITEM }]
      const cur = items[0].description || ''
      if (!cur.includes(line)) items[0] = { ...items[0], description: cur ? `${cur} · ${line}` : line }
      return { ...f, items }
    })
  }

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
        <div className={`overflow-y-auto p-4 space-y-3.5 scrollbar-thin ${previewMode ? 'hidden 2xl:block 2xl:w-[460px] 2xl:shrink-0 2xl:border-r 2xl:border-hairline' : 'flex-1'}`}>

          {/* AI-enriched gist of an existing quote: where it stands + next step
              (only for a saved quote — a brand-new one has nothing to read). */}
          {selected?.id && <AiInsight type="quote" id={selected.id} />}

          {/* The original request this quote answers — shown while writing so
              staff can see exactly what the customer asked for (message, size,
              dates, website estimate). Open by default on create. */}
          {selectedIntake && (
            <OriginalRequestCard intake={selectedIntake} defaultOpen />
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

          {/* Title — customer-facing (email + PDF header). */}
          <div>
            <label className="block text-xs text-ink-3 mb-1">Quote title <span className="text-ink-3/70">· shown to the customer</span></label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Biweekly Cleaning — 12 Pier Rd"
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
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

          {/* Service type — options come from Settings → Service Scopes so
              operator-added services appear here. Switching service swaps in
              that service's scope UNLESS the operator has edited the scope
              (i.e. it no longer matches the current service's default). */}
          <div>
            <label className="block text-xs text-ink-3 mb-1.5">Service Type</label>
            <div className="flex flex-wrap gap-2">
              {serviceOptions(serviceScopes).map(opt => (
                <button key={opt.key}
                  onClick={() => setForm(f => {
                    if (f.service_type === opt.key) return f
                    const prevScope = scopeForService(serviceScopes, f.service_type)
                    const cur = (f.notes || '').trim()
                    const notes = (!cur || cur === prevScope.trim())
                      ? scopeForService(serviceScopes, opt.key)
                      : f.notes
                    return { ...f, service_type: opt.key, notes }
                  })}
                  className={`flex-1 min-w-[calc(50%-0.25rem)] py-2 px-2 rounded-lg text-xs font-medium transition-colors ${form.service_type === opt.key ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Address + property lookup */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-ink-3">Service Address</label>
              <button
                type="button"
                onClick={() => lookupSpecs()}
                disabled={!form.address?.trim() || specsState === 'loading'}
                className="flex items-center gap-1 text-[11px] font-medium text-blue-500 hover:text-blue-400 disabled:text-ink-3 disabled:cursor-not-allowed">
                {specsState === 'loading' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                Look up property
              </button>
            </div>
            <AddressAutocomplete
              value={form.address}
              onChange={v => setForm(f => ({ ...f, address: v }))}
              onSelect={p => { setForm(f => ({ ...f, address: p.address || f.address })); lookupSpecs(p.address) }}
              selectOnFocus
              placeholder="123 Main St, Portland, ME 04101"
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            {/* Street View of the property — the same photo the customer sees on
                the quote, so you can eyeball the home while pricing. */}
            <PropertyPhoto address={form.address}
              className="mt-2 w-full h-40 object-cover rounded-lg border border-hairline" />
            {/* Free property-record lookups — one click to eyeball beds/baths/
                sqft on public sites when RentCast auto-fetch isn't enabled. */}
            {form.address?.trim() && (
              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-ink-3">
                <span>Look up specs:</span>
                <a className="text-blue-500 hover:text-blue-400" target="_blank" rel="noopener noreferrer"
                  href={`https://www.google.com/search?q=${encodeURIComponent(form.address + ' property records bedrooms bathrooms square feet')}`}>Google records</a>
                <a className="text-blue-500 hover:text-blue-400" target="_blank" rel="noopener noreferrer"
                  href={`https://www.zillow.com/homes/${encodeURIComponent(form.address)}_rb/`}>Zillow</a>
                <a className="text-blue-500 hover:text-blue-400" target="_blank" rel="noopener noreferrer"
                  href={`https://www.google.com/maps/search/${encodeURIComponent(form.address)}`}>Maps</a>
              </div>
            )}
            {specsState === 'done' && specs && (
              <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5">
                <Home className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span className="text-[12px] text-blue-900 flex-1 truncate">{specsSummary(specs) || 'Property found'}</span>
                <button type="button" onClick={addSpecsToScope}
                  className="text-[11px] font-semibold text-blue-600 hover:text-blue-500 shrink-0">Add to scope</button>
              </div>
            )}
            {specsState === 'none' && (
              <p className="mt-1 text-[11px] text-ink-3">No public property record found for that address.</p>
            )}
            {specsState === 'disabled' && (
              <p className="mt-1 text-[11px] text-ink-3">Turn on property lookup in Settings → General (RentCast) to auto-fetch specs.</p>
            )}
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2 gap-2">
              <label className="text-xs text-ink-3">Line items</label>
              <div className="flex items-center gap-2">
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
                  className="px-2 py-1 bg-panel border border-hairline rounded-md text-ink-2 text-[11px] max-w-[140px]"
                >
                  <option value="">Use a template…</option>
                  {quoteTemplates.map(t => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
                <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                  className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Add
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {form.items.map((item, i) => (
                <div key={i} className="bg-bg-2 rounded-lg p-2.5 space-y-2">
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
