import { useState } from 'react'
import { Trash2, X } from 'lucide-react'
import AddressAutocomplete from '../AddressAutocomplete'
import { CustomFieldsForm } from '../CustomFields'
import { STATUS_DOT } from '../../theme/statusDots'

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

const INPUT_CLS = 'w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-hidden focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20'
const LABEL_CLS = 'block text-[11px] text-ink-3 mb-1 font-medium'
const SECTION_CLS = 'text-[10px] font-semibold uppercase tracking-widest text-ink-3'

/** Slide-in Edit/Create Client form (bottom-sheet on mobile, right rail
 *  on ≥sm). Fully controlled — every field goes through the parent's
 *  form/setForm so save/reset/close coordination with the list state
 *  stays in Clients.jsx.
 *
 *  Create is streamlined: only the essentials (name, phone, service address)
 *  show up front, with a first-property block and a "More details" section so
 *  a whole customer — phones, property, even a short-term-rental calendar feed
 *  — is added in one pass instead of client → open → property → feed. Edit keeps
 *  everything expanded (the server-backed phone manager, all fields). The
 *  create-only extras live on `form` under underscore keys that
 *  useClientMutations consumes and strips before the client POST. */
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
  const isCreate = !selected
  // Edit shows everything; create hides the secondary fields behind "More".
  const [expanded, setExpanded] = useState(!isCreate)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  // Create-only: buffered extra phone numbers (created after the client saves).
  const extraPhones = form._extraPhones || []
  const addExtraPhone = () =>
    setForm(f => ({ ...f, _extraPhones: [...(f._extraPhones || []), { phone: '', phone_type: 'mobile' }] }))
  const patchExtraPhone = (i, patch) =>
    setForm(f => ({ ...f, _extraPhones: (f._extraPhones || []).map((p, idx) => (idx === i ? { ...p, ...patch } : p)) }))
  const removeExtraPhone = (i) =>
    setForm(f => ({ ...f, _extraPhones: (f._extraPhones || []).filter((_, idx) => idx !== i) }))

  return (
    <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-hairline sm:shrink-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-hairline">
        <h2 className="text-[14px] font-semibold text-ink">{selected ? 'Edit Client' : 'New Client'}</h2>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-2 transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain p-6 space-y-4">
        {/* ── Essentials ─────────────────────────────────────────── */}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className={LABEL_CLS}>First Name *</label>
            <input value={form.first_name || ''} onChange={e => set('first_name', e.target.value)} className={INPUT_CLS} />
          </div>
          <div className="flex-1">
            <label className={LABEL_CLS}>Last Name</label>
            <input value={form.last_name || ''} onChange={e => set('last_name', e.target.value)} className={INPUT_CLS} />
          </div>
        </div>

        <div>
          <label className={LABEL_CLS}>Phone</label>
          <input value={form.phone || ''} onChange={e => set('phone', e.target.value)} className={INPUT_CLS} />
        </div>

        {/* Extra phone numbers on CREATE (edit uses the server-backed manager
            below). Buffered here, POSTed after the client is created. */}
        {isCreate && (
          <div className="space-y-2">
            {extraPhones.map((p, i) => (
              <div key={i} className="flex gap-2">
                <input value={p.phone} onChange={e => patchExtraPhone(i, { phone: e.target.value })}
                  placeholder="Another phone number" className={`${INPUT_CLS} flex-1`} />
                <select value={p.phone_type || 'mobile'} onChange={e => patchExtraPhone(i, { phone_type: e.target.value })}
                  className="bg-bg border border-hairline rounded-lg px-2 py-2 text-[12px] text-ink focus:outline-hidden focus:border-blue-400">
                  <option value="mobile">Mobile</option>
                  <option value="office">Office</option>
                  <option value="home">Home</option>
                </select>
                <button type="button" onClick={() => removeExtraPhone(i)}
                  className="text-ink-3 hover:text-red-500 transition-colors px-1" aria-label="Remove phone">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button type="button" onClick={addExtraPhone}
              className="text-[11px] font-medium text-link hover:text-link">
              + Add another number
            </button>
          </div>
        )}

        {/* Phone Numbers Management — EDIT only (server-backed ContactPhones) */}
        {selected && (
          <div className="pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-2">Phone numbers</div>
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
                        <span className="text-[10px] font-medium text-ink-3">Primary</span>
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
            <div className="space-y-2">
              <input value={newPhoneNumber} onChange={e => setNewPhoneNumber(e.target.value)} placeholder="Add phone number"
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-hidden focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              <select value={newPhoneType} onChange={e => setNewPhoneType(e.target.value)}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-hidden focus:border-blue-400">
                <option value="mobile">Mobile</option>
                <option value="office">Office</option>
                <option value="home">Home</option>
              </select>
              <button onClick={addPhoneNumber} disabled={!newPhoneNumber.trim()}
                className="w-full bg-bg-2 hover:bg-bg-2 border border-hairline-2 text-ink-2 hover:text-ink disabled:opacity-50 disabled:text-ink-3 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                Add phone number
              </button>
            </div>
          </div>
        )}

        {/* Service address */}
        <div className="pt-1">
          <div className={`${SECTION_CLS} mb-3`}>Service address</div>
          {ADDRESS_FIELDS.map(({ label, key }) => (
            <div key={key} className="mb-3">
              <label className={LABEL_CLS}>{label}</label>
              {key === 'address' ? (
                <AddressAutocomplete
                  value={form.address || ''}
                  onChange={v => set('address', v)}
                  onSelect={p => setForm(f => ({ ...f, address: p.address || f.address, city: p.city || f.city, state: p.state || f.state, zip_code: p.zip_code || f.zip_code }))}
                  placeholder="Start typing an address…"
                  className={INPUT_CLS}
                />
              ) : (
                <input value={form[key] || ''} onChange={e => set(key, e.target.value)} className={INPUT_CLS} />
              )}
            </div>
          ))}
        </div>

        {/* First property — CREATE only. Turns client → property → feed into one
            pass. Only creates a property on save when an address is present. */}
        {isCreate && (
          <div className="rounded-lg border border-hairline bg-bg p-3 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!form._addProperty}
                onChange={e => set('_addProperty', e.target.checked)}
                className="h-4 w-4 rounded border-hairline-2 accent-indigo-600" />
              <span className="text-[12px] font-medium text-ink">Add a property at this address</span>
            </label>
            {form._addProperty && (
              <div className="space-y-3">
                <p className="text-[11px] text-ink-3 -mt-1">
                  Uses the service address above. {(form.address || '').trim() ? 'You can fine-tune it later on the property.' : 'Enter a service address to create the property.'}
                </p>
                <div>
                  <label className={LABEL_CLS}>Property type</label>
                  <select value={form._propertyType || 'residential'} onChange={e => set('_propertyType', e.target.value)} className={INPUT_CLS}>
                    <option value="residential">Residential</option>
                    <option value="commercial">Commercial</option>
                    <option value="str">Short-term rental</option>
                  </select>
                </div>
                {form._propertyType === 'str' && (
                  <div className="space-y-2">
                    <label className={LABEL_CLS}>Calendar feed (iCal URL) — optional</label>
                    <input value={form._icalUrl || ''} onChange={e => set('_icalUrl', e.target.value)}
                      placeholder="https://www.airbnb.com/calendar/ical/…" className={INPUT_CLS} />
                    <select value={form._icalSource || 'airbnb'} onChange={e => set('_icalSource', e.target.value)} className={INPUT_CLS}>
                      <option value="airbnb">Airbnb</option>
                      <option value="vrbo">VRBO</option>
                      <option value="manual">Other</option>
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── More details ───────────────────────────────────────── */}
        {!expanded ? (
          <button type="button" onClick={() => setExpanded(true)}
            className="text-[12px] font-medium text-link hover:text-link">
            + More details (email, source, billing, status, notes)
          </button>
        ) : (
          <div className="space-y-4">
            <div>
              <label className={LABEL_CLS}>Email</label>
              <input value={form.email || ''} onChange={e => set('email', e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Source</label>
              <input value={form.source || ''} onChange={e => set('source', e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              {!showBilling ? (
                <button type="button" onClick={() => setShowBilling(true)}
                  className="text-[11px] font-medium text-link hover:text-link">
                  + Add separate billing address
                </button>
              ) : (<>
                <div className={`${SECTION_CLS} mb-3`}>Billing address</div>
                {BILLING_FIELDS.map(({ label, key }) => (
                  <div key={key} className="mb-3">
                    <label className={LABEL_CLS}>{label}</label>
                    <input value={form[key] || ''} onChange={e => set(key, e.target.value)} className={INPUT_CLS} />
                  </div>
                ))}
              </>)}
            </div>
            <div>
              <label className={LABEL_CLS}>Status</label>
              <select value={form.status} onChange={e => set('status', e.target.value)}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-hidden focus:border-blue-400">
                <option value="lead">Lead</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Notes</label>
              <textarea value={form.notes || ''} onChange={e => set('notes', e.target.value)} rows={3}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-hidden focus:border-blue-400 resize-none" />
            </div>
            <CustomFieldsForm
              entityType="client"
              values={form.custom_fields || {}}
              onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
            />
          </div>
        )}
      </div>
      {dupes.length > 0 && (
        <div className="mx-6 mb-2 text-[12px] text-ink bg-panel border border-hairline rounded-lg px-3 py-2">
          <div className="font-semibold mb-1 flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT.attention}`} aria-hidden="true" />
            Possible duplicate{dupes.length > 1 ? 's' : ''} found:
          </div>
          <ul className="space-y-0.5">
            {dupes.map(d => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{d.name}{d.phone ? ` · ${d.phone}` : ''}{d.email ? ` · ${d.email}` : ''}</span>
                <button type="button" onClick={() => navigate(`/clients/${d.id}`)}
                  className="shrink-0 text-link hover:text-link font-medium">Open</button>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-ink-3">Save again to create anyway.</div>
        </div>
      )}
      {saveError && (
        <div className="mx-6 mb-2 text-[12px] text-ink bg-panel border border-hairline rounded-lg px-3 py-2 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT.problem}`} aria-hidden="true" />
          {saveError}
        </div>
      )}
      <div className="p-6 pb-bottomnav sm:pb-6 border-t border-hairline flex gap-3">
        {selected && (
          <button onClick={() => deleteClient(selected.id)}
            className="px-4 py-2 text-[13px] text-red-500 hover:text-red-600 border border-hairline hover:border-red-300 rounded-lg transition-colors font-medium">
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
