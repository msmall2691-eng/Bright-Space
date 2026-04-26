import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, X, RefreshCw, CheckCircle, AlertCircle, Home, Building2, Wind, Clock, Link, Trash2, Users, Calendar, ChevronRight, AlertTriangle } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get, post, patch, del } from "../api"


const EMPTY = {
  client_id: '', property_type: 'residential', name: '', address: '', city: '', state: '',
  zip_code: '', ical_url: '', default_duration_hours: 3, default_crew_size: null,
  access_notes: '', parking_notes: '',
  check_in_time: '14:00', check_out_time: '10:00', house_code: '', timezone: '',
  business_name: '', hours_of_operation: '',
  notes: ''
}

const PROPERTY_TYPE_CONFIG = {
  residential: { label: 'Residential', badge: 'bg-blue-100 text-blue-700', icon: Home, color: 'text-blue-600' },
  commercial: { label: 'Commercial', badge: 'bg-purple-100 text-purple-700', icon: Building2, color: 'text-purple-600' },
  str: { label: 'STR', badge: 'bg-amber-100 text-amber-700', icon: Wind, color: 'text-amber-600' },
}

export default function Properties() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const currentType = searchParams.get('type') || 'all'

  const [properties, setProperties] = useState([])
  const [clients, setClients] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [showTypeModal, setShowTypeModal] = useState(false)
  const [newPropertyType, setNewPropertyType] = useState('residential')
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(null)
  const [syncResult, setSyncResult] = useState(null)
  const [expandedPropId, setExpandedPropId] = useState(null)
  const [icalForm, setIcalForm] = useState({
    url: '', source: '',
    checkout_time: '', duration_hours: '',
    house_code: '', access_links: '', instructions: ''
  })
  const [showIcalForm, setShowIcalForm] = useState(null)

  const load = () =>
    get('/api/properties').then(setProperties).catch(err => console.error("[Properties]", err))

  useEffect(() => {
    load()
    get('/api/clients?status=active').then(setClients).catch(err => console.error("[Properties]", err))
  }, [])

  const clientName = (id) => {
    const client = clients.find(c => c.id === id)
    return client?.name || `Client #${id}`
  }

  const filteredProperties = currentType === 'all'
    ? properties
    : properties.filter(p => p.property_type === currentType)

  const typeCounts = {
    all: properties.length,
    residential: properties.filter(p => p.property_type === 'residential').length,
    commercial: properties.filter(p => p.property_type === 'commercial').length,
    str: properties.filter(p => p.property_type === 'str').length,
  }

  const save = async () => {
    setSaving(true)
    try {
      const url = selected ? `/api/properties/${selected.id}` : '/api/properties'
      const body = {
        ...form,
        client_id: parseInt(form.client_id),
        default_duration_hours: parseFloat(form.default_duration_hours),
        default_crew_size: form.default_crew_size ? parseInt(form.default_crew_size) : null
      }
      selected ? await patch(url, body) : await post(url, body)
      await load()
      setShowForm(false)
      setShowTypeModal(false)
      setSelected(null)
      setForm(EMPTY)
    } catch (e) {
      alert('Error saving property: ' + e.message)
    }
    setSaving(false)
  }

  const addIcal = async (propId) => {
    if (!icalForm.url.trim()) return
    try {
      const data = {
        ...icalForm,
        duration_hours: icalForm.duration_hours ? parseFloat(icalForm.duration_hours) : null
      }
      await post(`/api/properties/${propId}/icals`, data)
      await load()
      setShowIcalForm(null)
      setIcalForm({ url: '', source: '', checkout_time: '', duration_hours: '', house_code: '', access_links: '', instructions: '' })
    } catch (e) {
      alert('Error adding iCal: ' + e.message)
    }
  }

  const removeIcal = async (propId, icalId) => {
    if (!confirm('Remove this iCal URL?')) return
    try {
      await del(`/api/properties/${propId}/icals/${icalId}`)
      await load()
    } catch (e) {
      alert('Error removing iCal: ' + e.message)
    }
  }

  const syncOne = async (id) => {
    setSyncing(id)
    setSyncResult(null)
    try {
      const data = await post(`/api/properties/${id}/sync`)
      setSyncResult({ id, ...data, ok: true })
      await load()
    } catch (e) {
      setSyncResult({ id, ok: false, error: String(e) })
    }
    setSyncing(null)
  }

  const syncAll = async () => {
    setSyncing('all')
    setSyncResult(null)
    try {
      const data = await post('/api/properties/sync-all')
      setSyncResult({ id: 'all', ...data, ok: true })
      await load()
    } catch (e) {
      setSyncResult({ id: 'all', ok: false, error: String(e) })
    }
    setSyncing(null)
  }

  const openEdit = (p) => {
    setSelected(p)
    setForm({
      ...p,
      client_id: p.client_id,
      property_type: p.property_type || 'residential',
      check_in_time: p.check_in_time || '14:00',
      check_out_time: p.check_out_time || '10:00',
      house_code: p.house_code || '',
    })
    setShowForm(true)
  }

  const openNew = () => {
    setShowTypeModal(true)
  }

  const confirmNewProperty = () => {
    setSelected(null)
    setForm({ ...EMPTY, property_type: newPropertyType })
    setShowTypeModal(false)
    setShowForm(true)
  }

  const pageTitle = {
    all: 'All Properties',
    residential: 'Residential Properties',
    commercial: 'Commercial Properties',
    str: 'STR Properties'
  }[currentType]

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-zinc-900">{pageTitle}</h2>
          <div className="flex items-center gap-2">
            {properties.length > 0 && (
              <button onClick={syncAll} disabled={syncing === 'all'}
                className="flex items-center gap-2 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-4 py-2 rounded-lg text-sm transition-colors">
                <RefreshCw className={`w-3.5 h-3.5 ${syncing === 'all' ? 'animate-spin' : ''}`} />
                Sync All
              </button>
            )}
            <button onClick={openNew}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> Add Property
            </button>
          </div>
        </div>

        {/* Type tabs */}
        <div className="flex gap-2 mb-5 border-b border-zinc-200">
          {['all', 'residential', 'commercial', 'str'].map(type => (
            <button
              key={type}
              onClick={() => setSearchParams({ type: type === 'all' ? '' : type })}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                currentType === type
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-zinc-600 hover:text-zinc-900'
              }`}
            >
              {type === 'all' ? `All (${typeCounts.all})` : `${PROPERTY_TYPE_CONFIG[type].label} (${typeCounts[type]})`}
            </button>
          ))}
        </div>

        {/* Sync result banner */}
        {syncResult && (
          <div className={`flex items-start gap-2 rounded-xl p-4 mb-4 text-sm border ${syncResult.ok ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
            {syncResult.ok
              ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
              : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <div>
              {syncResult.ok
                ? `Sync complete — ${syncResult.jobs_created ?? syncResult.results?.reduce((s, r) => s + (r.jobs_created || 0), 0) ?? 0} new turnover job(s) created`
                : `Sync failed: ${syncResult.error || syncResult.detail}`}
            </div>
            <button onClick={() => setSyncResult(null)} className="ml-auto opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        <div className="space-y-3 overflow-y-auto flex-1 scrollbar-thin">
          {filteredProperties.map(p => {
            const Config = PROPERTY_TYPE_CONFIG[p.property_type]
            const Icon = Config?.icon || Home

            return (
              <div key={p.id} className="bg-white border border-zinc-200 rounded-xl">
                {/* Property header */}
                <div className="p-5 cursor-pointer hover:bg-zinc-50 transition-colors" onClick={() => setExpandedPropId(expandedPropId === p.id ? null : p.id)}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4 flex-1">
                      <div className={`w-10 h-10 rounded-xl ${Config?.badge} flex items-center justify-center shrink-0 bg-opacity-20`}>
                        <Icon className={`w-5 h-5 ${Config?.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-zinc-900">{p.name}</div>
                          <span className={`text-xs px-2 py-0.5 rounded ${Config?.badge}`}>{Config?.label}</span>
                        </div>
                        <div className="text-sm text-zinc-600 flex items-center gap-2 mt-1">
                          {!clients.find(c => c.id === p.client_id) && (
                            <AlertTriangle className="w-3 h-3 text-red-400" title="Client not found" />
                          )}
                          {clientName(p.client_id)}
                        </div>
                        <div className="text-sm text-zinc-500 mt-0.5">{p.address}{p.city ? `, ${p.city}` : ''}</div>

                        {/* Type-specific metadata */}
                        <div className="flex items-center gap-4 mt-2 flex-wrap">
                          {p.property_type === 'str' && (
                            <>
                              <span className="flex items-center gap-1 text-xs text-zinc-500">
                                <Clock className="w-3 h-3" />{p.default_duration_hours}h turnover
                              </span>
                              {p.house_code && (
                                <span className="text-xs bg-blue-500/10 text-blue-600 px-2 py-0.5 rounded">
                                  Code: {p.house_code}
                                </span>
                              )}
                              {p.check_in_time && (
                                <span className="text-xs text-zinc-500">
                                  {p.check_in_time} → {p.check_out_time}
                                </span>
                              )}
                              {(p.icals?.length || 0) > 0 && (
                                <span className="flex items-center gap-1 text-xs text-green-600">
                                  <Link className="w-3 h-3" />{p.icals.length} feed{p.icals.length !== 1 ? 's' : ''}
                                </span>
                              )}
                            </>
                          )}
                          {(p.property_type === 'residential' || p.property_type === 'commercial') && (
                            <>
                              {p.default_duration_hours && (
                                <span className="flex items-center gap-1 text-xs text-zinc-500">
                                  <Clock className="w-3 h-3" />{p.default_duration_hours}h standard
                                </span>
                              )}
                              {p.default_crew_size && (
                                <span className="flex items-center gap-1 text-xs text-zinc-500">
                                  <Users className="w-3 h-3" />{p.default_crew_size} crew
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-2">
                      {p.property_type === 'str' && (p.icals?.length || 0) > 0 && (
                        <button onClick={(e) => { e.stopPropagation(); syncOne(p.id) }} disabled={syncing === p.id}
                          className="flex items-center gap-1.5 bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border border-orange-600/30 px-3 py-1.5 rounded-lg text-xs transition-colors">
                          <RefreshCw className={`w-3.5 h-3.5 ${syncing === p.id ? 'animate-spin' : ''}`} />
                          {syncing === p.id ? 'Syncing...' : 'Sync'}
                        </button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); navigate(`/properties/${p.id}`) }}
                        className="text-xs text-blue-600 hover:text-blue-900 bg-blue-100 hover:bg-blue-200 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5" />
                        Jobs
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); openEdit(p) }}
                        className="text-xs text-zinc-500 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 px-3 py-1.5 rounded-lg transition-colors">
                        Edit
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded details */}
                {expandedPropId === p.id && (
                  <div className="border-t border-zinc-200 p-5 space-y-4 bg-zinc-50">
                    {/* STR: iCal URLs */}
                    {p.property_type === 'str' && (
                      <div>
                        <div className="text-sm font-semibold text-zinc-700 mb-2">Calendar URLs</div>
                        {(p.icals || []).map(ical => (
                          <div key={ical.id} className="bg-white border border-zinc-200 rounded-lg p-2.5 mb-2">
                            <div className="flex items-start justify-between mb-1.5">
                              <div className="flex-1 min-w-0">
                                <div className="text-xs text-zinc-600 truncate font-mono">{ical.url}</div>
                                {ical.source && <div className="text-xs text-zinc-400">{ical.source}</div>}
                              </div>
                              <button onClick={() => removeIcal(p.id, ical.id)}
                                className="text-red-400 hover:text-red-600 p-1 ml-2 shrink-0">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            {(ical.checkout_time || ical.house_code || ical.instructions) && (
                              <div className="text-xs text-zinc-500 bg-zinc-50 rounded p-1.5 space-y-0.5">
                                {ical.checkout_time && <div>Checkout: {ical.checkout_time}</div>}
                                {ical.house_code && <div>Code: {ical.house_code}</div>}
                                {ical.instructions && <div className="text-zinc-600">{ical.instructions}</div>}
                              </div>
                            )}
                          </div>
                        ))}

                        {showIcalForm === p.id ? (
                          <div className="bg-white border border-zinc-200 rounded-lg p-3 space-y-2">
                            <input value={icalForm.url} onChange={e => setIcalForm(f => ({ ...f, url: e.target.value }))}
                              placeholder="https://www.airbnb.com/calendar/ical/..."
                              className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-xs focus:outline-none" />
                            <input value={icalForm.source} onChange={e => setIcalForm(f => ({ ...f, source: e.target.value }))}
                              placeholder="airbnb / vrbo / manual"
                              className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-xs focus:outline-none" />

                            <div className="border-t border-zinc-100 pt-2 mt-2">
                              <div className="text-xs font-semibold text-zinc-600 mb-2">Turnover Settings</div>
                              <div className="grid grid-cols-2 gap-2">
                                <input value={icalForm.checkout_time} onChange={e => setIcalForm(f => ({ ...f, checkout_time: e.target.value }))}
                                  placeholder="Checkout (e.g., 11:00)"
                                  type="time"
                                  className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-xs focus:outline-none" />
                                <input value={icalForm.duration_hours} onChange={e => setIcalForm(f => ({ ...f, duration_hours: e.target.value }))}
                                  placeholder="Duration (hrs)"
                                  type="number"
                                  step="0.5"
                                  className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-xs focus:outline-none" />
                              </div>
                              <input value={icalForm.house_code} onChange={e => setIcalForm(f => ({ ...f, house_code: e.target.value }))}
                                placeholder="Access code"
                                className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-xs focus:outline-none mt-2" />
                              <textarea value={icalForm.instructions} onChange={e => setIcalForm(f => ({ ...f, instructions: e.target.value }))}
                                placeholder="Special turnover instructions..."
                                rows="2"
                                className="w-full bg-white border border-zinc-200 rounded px-2 py-1.5 text-xs focus:outline-none mt-2" />
                            </div>

                            <div className="flex gap-2 pt-2">
                              <button onClick={() => addIcal(p.id)}
                                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-2 py-1.5 rounded text-xs font-medium">
                                Add Calendar
                              </button>
                              <button onClick={() => setShowIcalForm(null)}
                                className="flex-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 px-2 py-1.5 rounded text-xs">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => setShowIcalForm(p.id)}
                            className="w-full text-xs text-blue-600 hover:text-blue-700 border border-blue-600/20 bg-blue-50/50 hover:bg-blue-50 px-3 py-2 rounded-lg transition-colors">
                            + Add Calendar URL
                          </button>
                        )}
                      </div>
                    )}

                    {p.notes && (
                      <div>
                        <div className="text-xs text-zinc-500 font-semibold mb-1">Notes</div>
                        <div className="text-sm text-zinc-600 bg-white rounded p-2 border border-zinc-200">{p.notes}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {filteredProperties.length === 0 && (
            <div className="text-center py-16">
              <Home className="w-12 h-12 mx-auto mb-3 text-zinc-600" />
              <div className="text-zinc-400 font-medium mb-1">No {currentType === 'all' ? '' : PROPERTY_TYPE_CONFIG[currentType]?.label.toLowerCase()} properties yet</div>
              <div className="text-zinc-500 text-sm mb-4">
                {currentType === 'str'
                  ? 'Add an Airbnb or VRBO property to auto-create turnover jobs.'
                  : 'Create a property to organize jobs and services.'}
              </div>
              <button onClick={openNew} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                Add {currentType === 'all' ? 'Property' : PROPERTY_TYPE_CONFIG[currentType]?.label}
              </button>
            </div>
          )}
        </div>
      </div>

      <AgentWidget
        pageContext="properties"
        prompts={[
          'Which properties need an iCal sync?',
          'Show upcoming turnovers this week',
          'Help me set up a new Airbnb property',
        ]}
      />

      {/* Type selector modal for new property */}
      {showTypeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4">
            <div className="p-6">
              <h2 className="text-lg font-semibold text-zinc-900 mb-4">What kind of property?</h2>
              <div className="space-y-2">
                {['residential', 'commercial', 'str'].map(type => (
                  <button
                    key={type}
                    onClick={() => setNewPropertyType(type)}
                    className={`w-full p-3 rounded-lg border-2 text-left transition-all ${
                      newPropertyType === type
                        ? `border-blue-600 bg-blue-50`
                        : 'border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    <div className="font-medium text-zinc-900">{PROPERTY_TYPE_CONFIG[type].label}</div>
                    <div className="text-sm text-zinc-500 mt-1">
                      {type === 'residential' && 'Home or apartment'}
                      {type === 'commercial' && 'Business or office space'}
                      {type === 'str' && 'Airbnb, VRBO, or vacation rental'}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex gap-2 mt-6">
                <button onClick={() => setShowTypeModal(false)}
                  className="flex-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                  Cancel
                </button>
                <button onClick={confirmNewProperty}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit/Create Form */}
      {showForm && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-zinc-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 shrink-0">
            <h2 className="font-semibold text-zinc-900">{selected ? 'Edit Property' : 'Add Property'}</h2>
            <button onClick={() => setShowForm(false)} className="text-zinc-500 hover:text-zinc-500"><X className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">
            {/* Type selector (for new properties) */}
            {!selected && (
              <div>
                <label className="block text-xs text-zinc-400 mb-3 font-semibold">Property Type *</label>
                <div className="flex gap-2">
                  {['residential', 'commercial', 'str'].map(type => (
                    <button
                      key={type}
                      onClick={() => setForm(f => ({ ...f, property_type: type }))}
                      className={`flex-1 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                        form.property_type === type
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-zinc-200 text-zinc-600 hover:border-zinc-300'
                      }`}
                    >
                      {PROPERTY_TYPE_CONFIG[type].label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Client *</label>
              <select value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Basic fields */}
            {[
              { label: 'Property Name *', key: 'name', placeholder: 'e.g. 4 Red Barn Circle' },
              { label: 'Address *', key: 'address' },
              { label: 'City', key: 'city' },
              { label: 'State', key: 'state' },
              { label: 'ZIP', key: 'zip_code' },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="block text-xs text-zinc-400 mb-1">{label}</label>
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            ))}

            {/* Common fields */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Access Notes</label>
              <textarea value={form.access_notes || ''} onChange={e => setForm(f => ({ ...f, access_notes: e.target.value }))} rows={2}
                placeholder="e.g. Side door, lockbox 4251"
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Parking Notes</label>
              <input value={form.parking_notes || ''} onChange={e => setForm(f => ({ ...f, parking_notes: e.target.value }))}
                placeholder="Where to park"
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Default Duration (hrs)</label>
                <input type="number" step="0.5" value={form.default_duration_hours || 3}
                  onChange={e => setForm(f => ({ ...f, default_duration_hours: e.target.value }))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Crew Size</label>
                <input type="number" value={form.default_crew_size || ''}
                  onChange={e => setForm(f => ({ ...f, default_crew_size: e.target.value }))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>

            {/* STR-specific fields */}
            {form.property_type === 'str' && (
              <div className="border-t border-zinc-200 pt-4">
                <h3 className="text-xs font-semibold text-zinc-600 uppercase mb-3">STR Settings</h3>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Check-in Time</label>
                    <input type="time" value={form.check_in_time || '14:00'} onChange={e => setForm(f => ({ ...f, check_in_time: e.target.value }))}
                      className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Check-out Time</label>
                    <input type="time" value={form.check_out_time || '10:00'} onChange={e => setForm(f => ({ ...f, check_out_time: e.target.value }))}
                      className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">House Code</label>
                  <input value={form.house_code || ''} onChange={e => setForm(f => ({ ...f, house_code: e.target.value }))}
                    placeholder="e.g. 1234 or Front door code"
                    className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                </div>

                <div className="mt-3">
                  <label className="block text-xs text-zinc-400 mb-1">Timezone</label>
                  <input value={form.timezone || ''} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}
                    placeholder="e.g. America/New_York"
                    className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                </div>
              </div>
            )}

            {/* Commercial-specific fields */}
            {form.property_type === 'commercial' && (
              <div className="border-t border-zinc-200 pt-4">
                <h3 className="text-xs font-semibold text-zinc-600 uppercase mb-3">Commercial Details</h3>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Business Name</label>
                  <input value={form.business_name || ''} onChange={e => setForm(f => ({ ...f, business_name: e.target.value }))}
                    placeholder="If different from Client name"
                    className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                </div>

                <div className="mt-3">
                  <label className="block text-xs text-zinc-400 mb-1">Hours of Operation</label>
                  <input value={form.hours_of_operation || ''} onChange={e => setForm(f => ({ ...f, hours_of_operation: e.target.value }))}
                    placeholder="e.g. Mon-Fri 9am-5pm"
                    className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Notes</label>
              <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>
          </div>
          <div className="p-6 border-t border-zinc-200 shrink-0">
            <button onClick={save} disabled={saving || !form.client_id || !form.name || !form.address}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving...' : 'Save Property'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
