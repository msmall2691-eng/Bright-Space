import {
  Plus, CheckCircle, AlertCircle, X, RefreshCw, Trash2,
  Home, MapPin, Calendar,
} from 'lucide-react'
import {
  INPUT_CLASS, PROPERTY_TYPE_COLORS, PROPERTY_TYPE_LABELS, EMPTY_ICAL,
} from './constants'
import PropertyPhoto from '../PropertyPhoto'

export default function PropertiesTab({
  properties, navigate, setJobModal,
  propForm, setPropForm,
  showPropForm, setShowPropForm,
  editingProp,
  savingProp, saveProp, deleteProp,
  openNewProp, openEditProp,
  icalForm, setIcalForm,
  showIcalForm, setShowIcalForm,
  addIcal, removeIcal,
  syncingPropId, syncProperty,
  syncBanner, setSyncBanner,
}) {
  return (
    <div className="max-w-2xl" data-testid="client-properties-tab">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-ink-3">{properties.length} propert{properties.length !== 1 ? 'ies' : 'y'}</p>
        <button onClick={openNewProp}
          data-testid="client-add-property"
          className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add Property
        </button>
      </div>

      {syncBanner && (
        <div className={`flex items-start gap-2 rounded-lg p-3 mb-3 text-xs border ${syncBanner.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          {syncBanner.ok ? <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span className="flex-1">{syncBanner.message}</span>
          <button onClick={() => setSyncBanner(null)} className="opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* Property form */}
      {showPropForm && (
        <div className="bg-panel border border-hairline rounded-xl p-5 mb-4 space-y-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-ink">{editingProp ? 'Edit Property' : 'New Property'}</span>
            <button onClick={() => setShowPropForm(false)} className="text-ink-3 hover:text-ink-3"><X className="w-4 h-4" /></button>
          </div>

          <div>
            <label className="block text-xs text-ink-3 mb-1">Property Name *</label>
            <input value={propForm.name || ''} onChange={e => setPropForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Main Home, Lake House"
              className={INPUT_CLASS} />
          </div>

          <div>
            <label className="block text-xs text-ink-3 mb-1">Type</label>
            <div className="flex gap-2">
              {[['residential','Residential'],['commercial','Commercial'],['str','STR / Airbnb']].map(([val, label]) => (
                <button key={val} onClick={() => setPropForm(f => ({ ...f, property_type: val }))}
                  className={`flex-1 py-1.5 rounded-lg text-xs transition-colors ${propForm.property_type === val ? 'bg-indigo-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-ink-3 mb-1">Address</label>
            <input value={propForm.address || ''} onChange={e => setPropForm(f => ({ ...f, address: e.target.value }))}
              className={INPUT_CLASS} />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-ink-3 mb-1">City</label>
              <input value={propForm.city || ''} onChange={e => setPropForm(f => ({ ...f, city: e.target.value }))}
                className={INPUT_CLASS} />
            </div>
            <div className="w-16">
              <label className="block text-xs text-ink-3 mb-1">State</label>
              <input value={propForm.state || ''} onChange={e => setPropForm(f => ({ ...f, state: e.target.value }))}
                className={INPUT_CLASS} />
            </div>
            <div className="w-24">
              <label className="block text-xs text-ink-3 mb-1">ZIP</label>
              <input value={propForm.zip_code || ''} onChange={e => setPropForm(f => ({ ...f, zip_code: e.target.value }))}
                className={INPUT_CLASS} />
            </div>
          </div>

          {propForm.property_type === 'str' && (
            <>
              <div className="border-t border-hairline pt-4">
                <h3 className="text-xs font-semibold text-ink-2 uppercase mb-3">STR / Turnover Settings</h3>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <label className="block text-xs text-ink-3 mb-1">Check-in Time</label>
                    <input type="time" value={propForm.check_in_time || '14:00'}
                      onChange={e => setPropForm(f => ({ ...f, check_in_time: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                  <div>
                    <label className="block text-xs text-ink-3 mb-1">Check-out Time</label>
                    <input type="time" value={propForm.check_out_time || '10:00'}
                      onChange={e => setPropForm(f => ({ ...f, check_out_time: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                </div>

                <div className="mb-3">
                  <label className="block text-xs text-ink-3 mb-1">House Code/Key Code</label>
                  <input value={propForm.house_code || ''}
                    onChange={e => setPropForm(f => ({ ...f, house_code: e.target.value }))}
                    placeholder="e.g. 1234 or Front door code"
                    className={INPUT_CLASS} />
                </div>

                <div>
                  <label className="block text-xs text-ink-3 mb-1">Default Turnover Duration (hours)</label>
                  <input type="number" step="0.5" min="0.5" value={propForm.default_duration_hours || 3}
                    onChange={e => setPropForm(f => ({ ...f, default_duration_hours: parseFloat(e.target.value) }))}
                    className={INPUT_CLASS} />
                </div>
              </div>

              {/* Multi-iCal feed management (Airbnb / VRBO / etc.) */}
              <div className="border-t border-hairline pt-4" data-testid="client-property-ical-section">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-ink-2 uppercase">Calendar Feeds</h3>
                  {editingProp && (editingProp.icals?.length || 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => syncProperty(editingProp.id)}
                      disabled={syncingPropId === editingProp.id}
                      className="flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-700 disabled:opacity-50">
                      <RefreshCw className={`w-3 h-3 ${syncingPropId === editingProp.id ? 'animate-spin' : ''}`} />
                      {syncingPropId === editingProp.id ? 'Syncing…' : 'Sync now'}
                    </button>
                  )}
                </div>
                <p className="text-xs text-ink-3 mb-2">Paste an iCal URL from Airbnb, VRBO, or any booking platform. Turnover jobs are auto-created on each checkout.</p>
                {editingProp && (
                  <button
                    type="button"
                    onClick={() => navigate(`/properties/${editingProp.id}/icals`)}
                    data-testid="open-bulk-icals"
                    className="text-[11px] text-indigo-600 hover:text-indigo-700 mb-3">
                    Paste multiple URLs at once →
                  </button>
                )}

                {!editingProp ? (
                  <p className="text-xs text-ink-3 bg-bg border border-hairline rounded-lg px-3 py-2">
                    Save the property first, then add calendar feeds here.
                  </p>
                ) : (
                  <>
                    <div className="space-y-2 mb-2">
                      {(editingProp.icals || []).map(ical => (
                        <div key={ical.id} className="bg-bg border border-hairline rounded-lg p-2.5" data-testid="client-property-ical-row">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] font-mono text-ink-2 truncate">{ical.url}</div>
                              {ical.source && <div className="text-[10px] text-ink-3 mt-0.5">{ical.source}</div>}
                              {(ical.last_synced_at || ical.last_sync_status) && (
                                <div className="flex items-center gap-1.5 text-[10px] mt-1">
                                  {ical.last_sync_status === 'failed' ? (
                                    <>
                                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
                                      <span className="text-red-600 font-medium">Sync failed</span>
                                      {ical.last_sync_error && <span className="text-ink-3 truncate">{ical.last_sync_error}</span>}
                                    </>
                                  ) : ical.last_synced_at ? (
                                    <>
                                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                      <span className="text-ink-2">Synced {new Date(ical.last_synced_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-bg-2" />
                                      <span className="text-ink-3">Never synced</span>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => removeIcal(editingProp.id, ical.id)}
                              className="text-ink-3 hover:text-red-500 shrink-0"
                              aria-label="Remove calendar feed">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                      {(editingProp.icals?.length || 0) === 0 && !showIcalForm && (
                        <p className="text-xs text-ink-3 italic py-1">No calendar feeds yet.</p>
                      )}
                    </div>

                    {showIcalForm ? (
                      <div className="bg-panel border border-hairline rounded-lg p-3 space-y-2">
                        <input value={icalForm.url}
                          onChange={e => setIcalForm(f => ({ ...f, url: e.target.value }))}
                          placeholder="https://www.airbnb.com/calendar/ical/…"
                          className={INPUT_CLASS} />
                        <input value={icalForm.source}
                          onChange={e => setIcalForm(f => ({ ...f, source: e.target.value }))}
                          placeholder="Source (airbnb, vrbo, …)"
                          className={INPUT_CLASS} />
                        <div className="grid grid-cols-2 gap-2">
                          <input type="time" value={icalForm.checkout_time}
                            onChange={e => setIcalForm(f => ({ ...f, checkout_time: e.target.value }))}
                            placeholder="Checkout"
                            className={INPUT_CLASS} />
                          <input type="number" step="0.5" min="0.5" value={icalForm.duration_hours}
                            onChange={e => setIcalForm(f => ({ ...f, duration_hours: e.target.value }))}
                            placeholder="Duration (hrs)"
                            className={INPUT_CLASS} />
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button type="button" onClick={() => addIcal(editingProp.id)}
                            disabled={!icalForm.url.trim()}
                            data-testid="client-property-ical-save"
                            className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-bg-2 disabled:text-ink-3 text-white px-3 py-2 rounded-lg text-xs font-medium">
                            Add Feed
                          </button>
                          <button type="button" onClick={() => { setShowIcalForm(false); setIcalForm(EMPTY_ICAL) }}
                            className="flex-1 bg-bg-2 hover:bg-bg-2 text-ink-2 px-3 py-2 rounded-lg text-xs">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setShowIcalForm(true)}
                        data-testid="client-property-ical-add"
                        className="w-full text-xs text-blue-600 hover:text-blue-700 border border-blue-200 bg-blue-50/50 hover:bg-blue-50 px-3 py-2 rounded-lg transition-colors">
                        + Add Calendar Feed
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          <div>
            <label className="block text-xs text-ink-3 mb-1">Notes</label>
            <textarea value={propForm.notes || ''} onChange={e => setPropForm(f => ({ ...f, notes: e.target.value }))} rows={2}
              className={INPUT_CLASS + " resize-none"} />
          </div>

          <div className="flex gap-2 pt-1">
            {editingProp && (
              <button onClick={() => deleteProp(editingProp.id)}
                className="px-3 py-2 text-sm text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 rounded-lg transition-colors">
                Delete
              </button>
            )}
            <button onClick={saveProp} disabled={savingProp || !propForm.name}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              {savingProp ? 'Saving...' : 'Save Property'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {properties.length === 0 && !showPropForm && (
          <p className="text-ink-3 text-sm text-center py-10">No properties yet</p>
        )}
        {properties.map(p => {
          const pType = (p.property_type || '').toLowerCase()
          const isStr = pType === 'str'
          const feedCount = p.icals?.length || 0
          const icalPill = isStr
            ? feedCount > 0
              ? { label: `${feedCount} iCal feed${feedCount !== 1 ? 's' : ''}`, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
              : { label: 'No iCal feeds', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
            : null
          return (
            <div key={p.id}
              data-testid="client-property-row"
              className="bg-panel border border-hairline hover:border-hairline rounded-xl p-4 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="w-9 h-9 rounded-lg bg-bg-2 flex items-center justify-center shrink-0 mt-0.5">
                    <Home className="w-4 h-4 text-ink-3" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-ink text-sm">{p.name}</div>
                    {p.address && (
                      <div className="text-xs text-ink-3 flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3 h-3 shrink-0" />
                        {[p.address, p.city, p.state].filter(Boolean).join(', ')}
                        {p.zip_code ? ` ${p.zip_code}` : ''}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${PROPERTY_TYPE_COLORS[pType] || PROPERTY_TYPE_COLORS.residential}`}>
                        {PROPERTY_TYPE_LABELS[pType] || p.property_type}
                      </span>
                      {icalPill && (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${icalPill.cls}`}>
                          {icalPill.label}
                        </span>
                      )}
                      {isStr && p.default_duration_hours && (
                        <span className="text-[10px] text-ink-3">{p.default_duration_hours}h turnover</span>
                      )}
                      {isStr && p.house_code && (
                        <span className="text-[10px] bg-blue-500/10 text-blue-600 px-1.5 py-0.5 rounded">Code: {p.house_code}</span>
                      )}
                    </div>
                  </div>
                </div>
                {/* Street View of the property — lazy (loads when scrolled into
                    view) and collapses when Google has no imagery. */}
                <PropertyPhoto
                  lazy
                  address={[p.address, p.city, p.state, p.zip_code].filter(Boolean).join(', ')}
                  className="hidden sm:block w-24 h-16 object-cover rounded-md border border-hairline bg-bg-2 shrink-0"
                />
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                  {isStr && feedCount > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); syncProperty(p.id) }}
                      disabled={syncingPropId === p.id}
                      data-testid="client-property-sync"
                      className="flex items-center gap-1 text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      title="Sync iCal feeds and auto-create turnover jobs"
                    >
                      <RefreshCw className={`w-3 h-3 ${syncingPropId === p.id ? 'animate-spin' : ''}`} />
                      {syncingPropId === p.id ? '…' : 'Sync'}
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); navigate(`/properties/${p.id}`) }}
                    data-testid="client-property-view-jobs"
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-2.5 py-1.5 rounded-lg transition-colors"
                    title="View jobs and visits for this property"
                  >
                    <Calendar className="w-3 h-3" /> Jobs
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setJobModal({ propertyId: p.id }) }}
                    data-testid="client-property-add-job"
                    className="flex items-center gap-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                    title="Schedule a job at this property"
                  >
                    <Plus className="w-3 h-3" /> Job
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); openEditProp(p) }}
                    className="text-xs text-ink-2 hover:text-ink bg-bg-2 hover:bg-bg-2 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    Edit
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
