import { useState, useRef } from 'react'
import { X, Sparkles, Loader2 } from 'lucide-react'
import { get } from '../../api'
import { CustomFieldsForm } from '../CustomFields'
import { PROPERTY_TYPE_CONFIG } from './constants'

const BASIC_FIELDS = [
  { label: 'Property Name *', key: 'name', placeholder: 'e.g. 4 Red Barn Circle' },
  { label: 'Address *',       key: 'address' },
  { label: 'City',            key: 'city' },
  { label: 'State',           key: 'state' },
  { label: 'ZIP',             key: 'zip_code' },
]

/** Slide-in Edit/Create Property form (bottom-sheet on mobile, right rail
 *  on ≥sm). Owns nothing — every field is controlled by `form`/`setForm`
 *  in the parent, so save/clear/reset behavior stays coordinated with the
 *  list state (loading, selection, etc.). Client picker supports inline
 *  creation via the `+ New client` toggle. */
export function PropertyForm({
  selected,
  form, setForm,
  clients,
  addingClient, setAddingClient,
  newClient, setNewClient,
  creatingClient,
  clientErr, setClientErr,
  selectClient,
  createInlineClient,
  saving,
  onClose,
  onSave,
}) {
  // Transient state for the "look up specs" action only — the persisted fields
  // still live in the parent's form/setForm, so this component stays the single
  // owner of nothing durable (see the component doc above).
  const [looking, setLooking] = useState(false)
  const [lookupMsg, setLookupMsg] = useState(null)  // { tone: 'ok'|'info'|'err', text }

  // Identity of the property/address currently in the form. Captured when a
  // lookup starts and re-checked when it returns, so a slow RentCast response
  // never applies specs for an address the operator has since edited — or for a
  // different property they've since opened in this same drawer (Codex review
  // on #657).
  const lookupIdRef = useRef('')
  lookupIdRef.current = `${selected?.id ?? 'new'}|${(form.address || '').trim().toLowerCase()}`

  const runLookup = async () => {
    const addr = (form.address || '').trim()
    if (!addr) return
    const token = lookupIdRef.current
    setLooking(true); setLookupMsg(null)
    try {
      const params = new URLSearchParams({ address: addr })
      if ((form.city || '').trim()) params.set('city', form.city.trim())
      if ((form.state || '').trim()) params.set('state', form.state.trim())
      if ((form.zip_code || '').trim()) params.set('zip_code', form.zip_code.trim())
      const { enabled, specs } = await get(`/api/properties/lookup-specs?${params.toString()}`)
      // The form moved on while we were waiting (address edited, or a different
      // property opened) — discard this now-stale result rather than writing it
      // onto whatever is in the form now.
      if (lookupIdRef.current !== token) {
        setLookupMsg({ tone: 'info', text: 'Address changed — discarded that lookup. Tap “Look up specs” again to refresh.' })
        return
      }
      if (!enabled) {
        setLookupMsg({ tone: 'info', text: 'Turn on property data lookup in Settings → Property Photos & Data to use this.' })
        return
      }
      // Apply only the structured numeric specs. Never touch property_type —
      // the provider reports its own ("Single Family"), but residential /
      // commercial / str is a human classification the operator picked above.
      const patch = {}
      const applied = []
      if (specs?.square_footage != null) { patch.square_footage = specs.square_footage; applied.push('sq ft') }
      if (specs?.bedrooms != null)       { patch.bedrooms = specs.bedrooms;             applied.push('beds') }
      if (specs?.bathrooms != null)      { patch.bathrooms = specs.bathrooms;           applied.push('baths') }
      if (specs?.year_built != null)     { patch.year_built = specs.year_built;         applied.push('year built') }
      if (applied.length) {
        setForm(f => ({ ...f, ...patch }))
        setLookupMsg({ tone: 'ok', text: `Filled ${applied.join(', ')} from public records — double-check before saving.` })
      } else {
        setLookupMsg({ tone: 'info', text: 'No public record found for this address.' })
      }
    } catch {
      setLookupMsg({ tone: 'err', text: 'Lookup failed — you can still enter the details by hand.' })
    } finally {
      setLooking(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-hairline sm:shrink-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
        <h2 className="font-semibold text-ink">{selected ? 'Edit Property' : 'Add Property'}</h2>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-3"><X className="w-5 h-5" /></button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain p-6 space-y-4 scrollbar-thin">
        {/* Type selector — for new or existing properties */}
        <div>
          <label className="block text-xs text-ink-3 mb-3 font-semibold">Property Type *</label>
          <div className="flex gap-2">
            {['residential', 'commercial', 'str'].map(type => (
              <button
                key={type}
                onClick={() => setForm(f => ({ ...f, property_type: type }))}
                className={`flex-1 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                  form.property_type === type
                    ? 'border-indigo-600 bg-panel text-indigo-700 dark:text-indigo-300'
                    : 'border-hairline text-ink-2 hover:border-hairline'
                }`}
              >
                {PROPERTY_TYPE_CONFIG[type].label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-ink-3">Client *</label>
            <button type="button"
              onClick={() => { setAddingClient(a => !a); setClientErr('') }}
              className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
              {addingClient ? 'Cancel' : '+ New client'}
            </button>
          </div>
          {!addingClient ? (
            <select value={form.client_id} onChange={e => selectClient(e.target.value)}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none">
              <option value="">Select client...</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <div className="rounded-lg border border-hairline-2 bg-bg p-2.5 space-y-2">
              <input autoFocus value={newClient.name} onChange={e => setNewClient(n => ({ ...n, name: e.target.value }))}
                placeholder="Client name *"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400" />
              <div className="grid grid-cols-2 gap-2">
                <input value={newClient.phone} onChange={e => setNewClient(n => ({ ...n, phone: e.target.value }))}
                  placeholder="Phone"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400" />
                <input value={newClient.email} onChange={e => setNewClient(n => ({ ...n, email: e.target.value }))}
                  placeholder="Email"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400" />
              </div>
              {clientErr && <div className="text-xs text-red-600">{clientErr}</div>}
              <button type="button" onClick={createInlineClient} disabled={creatingClient || !newClient.name.trim()}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                {creatingClient ? 'Creating…' : 'Create & select client'}
              </button>
            </div>
          )}
        </div>

        {/* Basic fields */}
        {BASIC_FIELDS.map(({ label, key, placeholder }) => (
          <div key={key}>
            <label className="block text-xs text-ink-3 mb-1">{label}</label>
            <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
          </div>
        ))}

        {/* Common fields */}
        <div>
          <label className="block text-xs text-ink-3 mb-1">Access Notes</label>
          <textarea value={form.access_notes || ''} onChange={e => setForm(f => ({ ...f, access_notes: e.target.value }))} rows={2}
            placeholder="e.g. Side door, lockbox 4251"
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1">Parking Notes</label>
          <input value={form.parking_notes || ''} onChange={e => setForm(f => ({ ...f, parking_notes: e.target.value }))}
            placeholder="Where to park"
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-ink-3 mb-1">Default Duration (hrs)</label>
            <input type="number" step="0.5" value={form.default_duration_hours || 3}
              onChange={e => setForm(f => ({ ...f, default_duration_hours: e.target.value }))}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1">Crew Size</label>
            <input type="number" value={form.default_crew_size || ''}
              onChange={e => setForm(f => ({ ...f, default_crew_size: e.target.value }))}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
        </div>

        {/* Property details — sq ft / beds / baths / year. Pre-fill from public
            records with the lookup button (owner-gated in Settings), or type
            them in. Applies to every property type. */}
        <div className="border-t border-hairline pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-ink-2 uppercase">Property Details</h3>
            <button type="button" onClick={runLookup} disabled={looking || !(form.address || '').trim()}
              title={!(form.address || '').trim() ? 'Enter an address first' : 'Fill sq ft, beds, baths & year built from public records'}
              className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:text-ink-3 disabled:cursor-not-allowed">
              {looking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {looking ? 'Looking up…' : 'Look up specs'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-ink-3 mb-1">Bedrooms</label>
              <input type="number" min="0" value={form.bedrooms ?? ''}
                onChange={e => setForm(f => ({ ...f, bedrooms: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1">Bathrooms</label>
              <input type="number" min="0" step="0.5" value={form.bathrooms ?? ''}
                onChange={e => setForm(f => ({ ...f, bathrooms: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1">Square Footage</label>
              <input type="number" min="0" value={form.square_footage ?? ''}
                onChange={e => setForm(f => ({ ...f, square_footage: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1">Year Built</label>
              <input type="number" min="1800" max="2100" value={form.year_built ?? ''}
                onChange={e => setForm(f => ({ ...f, year_built: e.target.value }))}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
          </div>

          {lookupMsg && (
            <div className={`mt-2 text-xs ${lookupMsg.tone === 'ok' ? 'text-emerald-600' : lookupMsg.tone === 'err' ? 'text-red-600' : 'text-ink-3'}`}>
              {lookupMsg.text}
            </div>
          )}
        </div>

        {/* STR-specific fields */}
        {form.property_type === 'str' && (
          <div className="border-t border-hairline pt-4">
            <h3 className="text-xs font-semibold text-ink-2 uppercase mb-3">STR Settings</h3>

            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="block text-xs text-ink-3 mb-1">Check-in Time</label>
                <input type="time" value={form.check_in_time || '14:00'} onChange={e => setForm(f => ({ ...f, check_in_time: e.target.value }))}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-ink-3 mb-1">Check-out Time</label>
                <input type="time" value={form.check_out_time || '10:00'} onChange={e => setForm(f => ({ ...f, check_out_time: e.target.value }))}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>

            <div>
              <label className="block text-xs text-ink-3 mb-1">House Code</label>
              <input value={form.house_code || ''} onChange={e => setForm(f => ({ ...f, house_code: e.target.value }))}
                placeholder="e.g. 1234 or Front door code"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
          </div>
        )}

        {/* Commercial-specific fields */}
        {form.property_type === 'commercial' && (
          <div className="border-t border-hairline pt-4">
            <h3 className="text-xs font-semibold text-ink-2 uppercase mb-3">Commercial Details</h3>

            <div>
              <label className="block text-xs text-ink-3 mb-1">Business Name</label>
              <input value={form.business_name || ''} onChange={e => setForm(f => ({ ...f, business_name: e.target.value }))}
                placeholder="If different from Client name"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>

            <div className="mt-3">
              <label className="block text-xs text-ink-3 mb-1">Hours of Operation</label>
              <input value={form.hours_of_operation || ''} onChange={e => setForm(f => ({ ...f, hours_of_operation: e.target.value }))}
                placeholder="e.g. Mon-Fri 9am-5pm"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs text-ink-3 mb-1">Notes</label>
          <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
        </div>

        {/* Admin-defined custom fields (Settings → Custom Fields → Properties) */}
        <CustomFieldsForm
          entityType="property"
          values={form.custom_fields || {}}
          onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
        />
      </div>
      <div className="p-6 border-t border-hairline shrink-0">
        <button onClick={onSave} disabled={saving || !form.client_id || !form.name || !form.address}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
          {saving ? 'Saving...' : 'Save Property'}
        </button>
      </div>
    </div>
  )
}
