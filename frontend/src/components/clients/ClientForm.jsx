import { Trash2, X } from 'lucide-react'
import AddressAutocomplete from '../AddressAutocomplete'
import { CustomFieldsForm } from '../CustomFields'

const CONTACT_FIELDS = [
  { label: 'Email',  key: 'email' },
  { label: 'Phone',  key: 'phone' },
  { label: 'Source', key: 'source' },
]

const ADDRESS_FIELDS = [
  { label: 'Street', key: 'address' },
  { label: 'City',   key: 'city' },
  { label: 'State',  key: 'state' },
  { label: 'ZIP',    key: 'zip_code' },
]

const BILLING_FIELDS = [
  { label: 'Street', key: 'billing_address' },
  { label: 'City',   key: 'billing_city' },
  { label: 'State',  key: 'billing_state' },
  { label: 'ZIP',    key: 'billing_zip' },
]

/** Slide-in Edit/Create Client form (bottom-sheet on mobile, right rail
 *  on ≥sm). Fully controlled — every field goes through the parent's
 *  form/setForm so save/reset/close coordination with the list state
 *  stays in Clients.jsx. */
export function ClientForm({
  selected,
  form, setForm,
  onClose,
  phoneNumbers, loadingPhones,
  newPhoneNumber, setNewPhoneNumber,
  newPhoneType, setNewPhoneType,
  setPhonePrimary,
  deletePhoneNumber,
  addPhoneNumber,
  showBilling, setShowBilling,
  dupes,
  saveError,
  saving,
  save,
  deleteClient,
  navigate,
}) {
  return (
    <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-hairline sm:shrink-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-hairline">
        <h2 className="text-[14px] font-semibold text-ink">{selected ? 'Edit Client' : 'New Client'}</h2>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-2 transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-[11px] text-ink-3 mb-1 font-medium">First Name *</label>
            <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
              className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] text-ink-3 mb-1 font-medium">Last Name</label>
            <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
              className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
          </div>
        </div>
        {CONTACT_FIELDS.map(({ label, key }) => (
          <div key={key}>
            <label className="block text-[11px] text-ink-3 mb-1 font-medium">{label}</label>
            <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
          </div>
        ))}

        {/* Phone Numbers Management */}
        {selected && (
          <div className="pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3 mb-2 flex items-center gap-2">
              <div className="h-px flex-1 bg-bg-2" /><span>Phone Numbers</span><div className="h-px flex-1 bg-bg-2" />
            </div>

            {/* Existing phone numbers */}
            <div className="space-y-1.5 mb-3">
              {loadingPhones ? (
                <div className="text-[11px] text-ink-3 py-2">Loading...</div>
              ) : phoneNumbers.length === 0 ? (
                <div className="text-[11px] text-ink-3 py-2">No phone numbers yet</div>
              ) : (
                phoneNumbers.map(p => (
                  <div key={p.id} className="flex items-center gap-2 bg-bg border border-hairline rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-ink">{p.phone}</div>
                      <div className="text-[10px] text-ink-3">{p.phone_type || 'mobile'}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      {p.is_primary ? (
                        <span className="text-[10px] font-semibold px-2 py-0.5 bg-blue-100 text-blue-600 rounded-full">Primary</span>
                      ) : (
                        <button onClick={() => setPhonePrimary(p.id)} className="text-[10px] px-2 py-0.5 text-ink-3 hover:text-ink-2 hover:bg-bg-2 rounded transition-colors">
                          Set Primary
                        </button>
                      )}
                      <button onClick={() => deletePhoneNumber(p.id)} className="text-ink-3 hover:text-red-500 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Add new phone */}
            <div className="space-y-2">
              <input value={newPhoneNumber} onChange={e => setNewPhoneNumber(e.target.value)} placeholder="Add phone number"
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              <select value={newPhoneType} onChange={e => setNewPhoneType(e.target.value)}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400">
                <option value="mobile">Mobile</option>
                <option value="office">Office</option>
                <option value="home">Home</option>
              </select>
              <button onClick={addPhoneNumber} disabled={!newPhoneNumber.trim()}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-bg-2 disabled:text-ink-3 text-white px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                Add Phone Number
              </button>
            </div>
          </div>
        )}
        <div className="pt-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3 mb-3 flex items-center gap-2">
            <div className="h-px flex-1 bg-bg-2" /><span>Service Address</span><div className="h-px flex-1 bg-bg-2" />
          </div>
          {ADDRESS_FIELDS.map(({ label, key }) => (
            <div key={key} className="mb-3">
              <label className="block text-[11px] text-ink-3 mb-1 font-medium">{label}</label>
              {key === 'address' ? (
                <AddressAutocomplete
                  value={form.address || ''}
                  onChange={v => setForm(f => ({ ...f, address: v }))}
                  onSelect={p => setForm(f => ({ ...f, address: p.address || f.address, city: p.city || f.city, state: p.state || f.state, zip_code: p.zip_code || f.zip_code }))}
                  placeholder="Start typing an address…"
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
                />
              ) : (
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              )}
            </div>
          ))}
        </div>
        <div>
          {!showBilling ? (
            <button type="button" onClick={() => setShowBilling(true)}
              className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700">
              + Add separate billing address
            </button>
          ) : (<>
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3 mb-3 flex items-center gap-2">
              <div className="h-px flex-1 bg-bg-2" /><span>Billing Address</span><div className="h-px flex-1 bg-bg-2" />
            </div>
            {BILLING_FIELDS.map(({ label, key }) => (
              <div key={key} className="mb-3">
                <label className="block text-[11px] text-ink-3 mb-1 font-medium">{label}</label>
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              </div>
            ))}
          </>)}
        </div>
        <div>
          <label className="block text-[11px] text-ink-3 mb-1 font-medium">Status</label>
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
            className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400">
            <option value="lead">Lead</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-ink-3 mb-1 font-medium">Notes</label>
          <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
            className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 resize-none" />
        </div>
        <CustomFieldsForm
          entityType="client"
          values={form.custom_fields || {}}
          onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
        />
      </div>
      {dupes.length > 0 && (
        <div className="mx-6 mb-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <div className="font-semibold mb-1">Possible duplicate{dupes.length > 1 ? 's' : ''} found:</div>
          <ul className="space-y-0.5">
            {dupes.map(d => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{d.name}{d.phone ? ` · ${d.phone}` : ''}{d.email ? ` · ${d.email}` : ''}</span>
                <button type="button" onClick={() => navigate(`/clients/${d.id}`)}
                  className="shrink-0 text-indigo-600 hover:text-indigo-700 font-medium">Open</button>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-amber-600">Save again to create anyway.</div>
        </div>
      )}
      {saveError && (
        <div className="mx-6 mb-2 text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{saveError}</div>
      )}
      <div className="p-6 pb-bottomnav sm:pb-6 border-t border-hairline flex gap-3">
        {selected && (
          <button onClick={() => deleteClient(selected.id)}
            className="px-4 py-2 text-[13px] text-red-500 hover:text-red-600 border border-red-200 hover:border-red-300 rounded-lg transition-colors font-medium">
            Delete
          </button>
        )}
        <button onClick={save} disabled={saving || (!form.first_name && !form.last_name)}
          className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-[13px] font-medium transition-colors">
          {saving ? 'Saving...' : (dupes.length > 0 ? 'Create anyway' : 'Save')}
        </button>
      </div>
    </div>
  )
}
