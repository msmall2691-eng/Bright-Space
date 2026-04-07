import { useState, useEffect } from 'react'
import { Plus, X, RefreshCw, CheckCircle, AlertCircle, Home, Clock, Link } from 'lucide-react'
import { get, post, patch as patchApi } from "../api"


const EMPTY = {
  client_id: '', name: '', address: '', city: '', state: '',
  zip_code: '', ical_url: '', default_duration_hours: 3, notes: ''
}

export default function Properties() {
  const [properties, setProperties] = useState([])
  const [clients, setClients] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(null)
  const [syncResult, setSyncResult] = useState(null)

  const load = () =>
    get('/api/properties').then(setProperties).catch(err => console.error("[Properties]", err))

  useEffect(() => {
    load()
    get('/api/clients').then(data => setClients(Array.isArray(data) ? data : [])).catch(err => console.error("[Properties]", err))
  }, [])

  const clientName = (id) => clients.find(c => c.id === id)?.name || `Client #${id}`

  const save = async () => {
    setSaving(true)
    try {
      const url = selected ? `/api/properties/${selected.id}` : '/api/properties'
      const body = { ...form, client_id: parseInt(form.client_id), default_duration_hours: parseFloat(form.default_duration_hours) }
      selected ? await patchApi(url, body) : await post(url, body)
      await load()
      setShowForm(false)
      setSelected(null)
      setForm(EMPTY)
    } catch (e) {
      console.error("[Properties] Save failed:", e)
    }
    setSaving(false)
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
    setForm({ ...p, client_id: p.client_id })
    setShowForm(true)
  }

  const openNew = () => {
    setSelected(null)
    setForm(EMPTY)
    setShowForm(true)
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col min-w-0">
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-lg font-semibold text-gray-900 flex-1">STR Properties</h2>
          {properties.length > 0 && (
            <button onClick={syncAll} disabled={syncing === 'all'}
              className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 border border-gray-200 px-4 py-2 rounded-lg text-sm transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${syncing === 'all' ? 'animate-spin' : ''}`} />
              Sync All
            </button>
          )}
          <button onClick={openNew}
            className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> Add Property
          </button>
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
          {properties.map(p => (
            <div key={p.id} className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center shrink-0">
                    <Home className="w-5 h-5 text-orange-400" />
                  </div>
                  <div>
                    <div className="font-semibold text-gray-900">{p.name}</div>
                    <div className="text-sm text-gray-400">{clientName(p.client_id)}</div>
                    <div className="text-sm text-gray-500 mt-0.5">{p.address}{p.city ? `, ${p.city}` : ''}</div>

                    <div className="flex items-center gap-4 mt-2">
                      <span className="flex items-center gap-1 text-xs text-gray-500">
                        <Clock className="w-3 h-3" />{p.default_duration_hours}h turnover
                      </span>
                      {p.ical_url && (
                        <span className="flex items-center gap-1 text-xs text-green-400">
                          <Link className="w-3 h-3" />iCal connected
                        </span>
                      )}
                      {!p.ical_url && (
                        <span className="text-xs text-yellow-400">No iCal URL</span>
                      )}
                      {p.ical_last_synced_at && (
                        <span className="text-xs text-gray-600">
                          Synced {new Date(p.ical_last_synced_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {p.ical_url && (
                    <button onClick={() => syncOne(p.id)} disabled={syncing === p.id}
                      className="flex items-center gap-1.5 bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border border-orange-600/30 px-3 py-1.5 rounded-lg text-xs transition-colors">
                      <RefreshCw className={`w-3.5 h-3.5 ${syncing === p.id ? 'animate-spin' : ''}`} />
                      {syncing === p.id ? 'Syncing...' : 'Sync'}
                    </button>
                  )}
                  <button onClick={() => openEdit(p)}
                    className="text-xs text-gray-500 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors">
                    Edit
                  </button>
                </div>
              </div>
            </div>
          ))}

          {properties.length === 0 && (
            <div className="text-center py-16">
              <Home className="w-12 h-12 mx-auto mb-3 text-gray-700" />
              <div className="text-gray-400 font-medium mb-1">No STR properties yet</div>
              <div className="text-gray-600 text-sm mb-4">Add an Airbnb or VRBO property to auto-create turnover jobs from their iCal feed.</div>
              <button onClick={openNew} className="bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                Add First Property
              </button>
            </div>
          )}
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-gray-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h2 className="font-semibold text-gray-900">{selected ? 'Edit Property' : 'Add Property'}</h2>
            <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-600"><X className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Client *</label>
              <select value={form.client_id} onChange={e => {
                const cid = e.target.value
                const client = clients.find(c => c.id === parseInt(cid))
                setForm(f => ({
                  ...f,
                  client_id: cid,
                  // Auto-fill address from client if adding a new property and fields are empty
                  address: f.address || client?.address || '',
                  city: f.city || client?.city || '',
                  state: f.state || client?.state || '',
                  zip_code: f.zip_code || client?.zip_code || '',
                }))
              }}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {[
              { label: 'Property Name *', key: 'name', placeholder: 'e.g. Ocean View Condo' },
              { label: 'Address *', key: 'address' },
              { label: 'City', key: 'city' },
              { label: 'State', key: 'state' },
              { label: 'ZIP', key: 'zip_code' },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="block text-xs text-gray-400 mb-1">{label}</label>
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
              </div>
            ))}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Airbnb/VRBO iCal URL</label>
              <input value={form.ical_url || ''} onChange={e => setForm(f => ({ ...f, ical_url: e.target.value }))}
                placeholder="https://www.airbnb.com/calendar/ical/..."
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400 font-mono text-xs" />
              <p className="text-xs text-gray-600 mt-1">Airbnb → Manage listing → Availability → Export calendar</p>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Default Turnover Duration (hours)</label>
              <input type="number" step="0.5" value={form.default_duration_hours || 3}
                onChange={e => setForm(f => ({ ...f, default_duration_hours: e.target.value }))}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              <p className="text-xs text-gray-600 mt-1">Used to calculate end time of auto-created turnover jobs</p>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Notes</label>
              <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>
          </div>
          <div className="p-6 border-t border-gray-200">
            <button onClick={save} disabled={saving || !form.client_id || !form.name || !form.address}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving...' : 'Save Property'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
