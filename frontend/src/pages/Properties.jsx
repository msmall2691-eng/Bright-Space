import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, X, RefreshCw, CheckCircle, AlertCircle, Home, Building2, Wind, Clock, Link, Trash2, Users, Calendar, ChevronRight, AlertTriangle } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { EmptyState } from '../components/ui'
import { CustomFieldsForm } from '../components/CustomFields'
import { get, post, patch, del } from "../api"


// Source dropdown values + their display labels. Keep aligned with the
// backend's iCal source labels (used as "ical_source" on Visit rows for
// turnover idempotency).
const ICAL_SOURCES = [
  { value: 'airbnb',     label: 'Airbnb' },
  { value: 'vrbo',       label: 'VRBO' },
  { value: 'booking_com', label: 'Booking.com' },
  { value: 'manual',     label: 'Manual / Custom' },
]


function relTimeAgo(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}


// One row per iCal feed on a STR property. Shows the URL (truncated),
// source label, and a sync-status pill so the operator can see at a
// glance "is this feed actually working?" without checking server logs.
// The per-feed Sync Now button currently triggers a property-level sync
// (the backend syncs all feeds on a property together, by design).
function IcalFeedRow({ ical, onRemove, onSync, syncing }) {
  const sourceLabel = ICAL_SOURCES.find(s => s.value === (ical.source || '').toLowerCase())?.label
    || ical.source
    || 'Custom'
  const status = ical.last_sync_status
  const lastAt = relTimeAgo(ical.last_synced_at)

  // Status precedence: failed > ok-on-timestamp > never synced.
  // Treat any feed with last_synced_at set as "Synced" even when
  // last_sync_status is null — historic rows from before #93's
  // sync_property update lacked a status string, and rendering them
  // as "Never synced" would defeat the whole observability feature
  // (Codex P1).
  let statusPill
  if (status === 'failed' || status === 'retrying') {
    statusPill = (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700" title={ical.last_sync_error || ''}>
        <AlertTriangle className="w-3 h-3" /> Failed {lastAt || ''}
      </span>
    )
  } else if (status === 'ok' || ical.last_synced_at) {
    statusPill = (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
        <CheckCircle className="w-3 h-3" /> Synced {lastAt || ''}
      </span>
    )
  } else {
    statusPill = (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-bg-2 text-ink-2">
        <Clock className="w-3 h-3" /> Never synced
      </span>
    )
  }

  return (
    <div className="bg-panel border border-hairline rounded-lg p-2.5 mb-2">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-semibold text-ink-2 uppercase tracking-wide">{sourceLabel}</span>
            {!ical.active && (
              <span className="text-[10px] font-semibold text-ink-3 bg-bg-2 px-1.5 py-0.5 rounded">paused</span>
            )}
            {statusPill}
          </div>
          <div className="text-xs text-ink-3 truncate font-mono" title={ical.url}>{ical.url}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onSync}
            disabled={syncing}
            className="text-blue-600 hover:text-blue-700 disabled:opacity-50 p-1"
            title="Sync this property now"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onRemove}
            className="text-red-400 hover:text-red-600 p-1"
            title="Remove feed"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {status === 'failed' && ical.last_sync_error && (
        <div className="text-[11px] text-red-700 bg-red-50 rounded p-1.5 mb-1.5 font-mono break-all">
          {ical.last_sync_error.slice(0, 200)}
        </div>
      )}
      {(ical.checkout_time || ical.house_code || ical.instructions) && (
        <div className="text-xs text-ink-3 bg-bg rounded p-1.5 space-y-0.5">
          {ical.checkout_time && <div>Checkout: {ical.checkout_time}</div>}
          {ical.house_code && <div>Code: {ical.house_code}</div>}
          {ical.instructions && <div className="text-ink-2">{ical.instructions}</div>}
        </div>
      )}
    </div>
  )
}


const EMPTY = {
  client_id: '', property_type: 'residential', name: '', address: '', city: '', state: '',
  zip_code: '', ical_url: '', default_duration_hours: 3, default_crew_size: null,
  access_notes: '', parking_notes: '',
  check_in_time: '14:00', check_out_time: '10:00', house_code: '', timezone: '',
  business_name: '', hours_of_operation: '',
  notes: '', custom_fields: {}
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
  // Inline "new client" quick-add from the property form (no trip to Clients).
  const [addingClient, setAddingClient] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '' })
  const [creatingClient, setCreatingClient] = useState(false)
  const [clientErr, setClientErr] = useState('')
  const [syncing, setSyncing] = useState(null)
  const [syncResult, setSyncResult] = useState(null)
  const [sweep, setSweep] = useState(null)
  const [sweeping, setSweeping] = useState(false)
  const runSweep = async () => {
    setSweeping(true); setSweep(null); setSyncResult(null)
    try {
      const data = await post('/api/properties/turnover-sweep')
      setSweep(data)
    } catch (e) {
      setSweep({ error: String(e?.message || e) })
    }
    setSweeping(false)
  }
  const [expandedPropId, setExpandedPropId] = useState(null)
  const [icalForm, setIcalForm] = useState({
    url: '', source: '',
    checkout_time: '', duration_hours: '',
    house_code: '', access_links: '', instructions: ''
  })
  const [showIcalForm, setShowIcalForm] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [hardDelete, setHardDelete] = useState(false)

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

  // Selecting a client pre-fills the property's address from the client's own
  // address when those fields are still empty (smart default; never clobbers
  // anything you've already typed).
  const selectClient = (idStr) => {
    const c = clients.find(c => String(c.id) === String(idStr))
    setForm(f => {
      const next = { ...f, client_id: idStr }
      if (c) {
        if (!f.address && c.address) next.address = c.address
        if (!f.city && c.city) next.city = c.city
        if (!f.state && c.state) next.state = c.state
        if (!f.zip_code && c.zip_code) next.zip_code = c.zip_code
      }
      return next
    })
  }

  // Create a client without leaving the property form: POST, add to the list,
  // and select it (with the same address smart-default).
  const createInlineClient = async () => {
    if (!newClient.name.trim()) { setClientErr('Name is required'); return }
    setCreatingClient(true); setClientErr('')
    try {
      const created = await post('/api/clients', {
        name: newClient.name.trim(),
        phone: newClient.phone.trim() || null,
        email: newClient.email.trim() || null,
        status: 'active',
      })
      setClients(cs => [created, ...cs])
      selectClient(String(created.id))
      setAddingClient(false)
      setNewClient({ name: '', phone: '', email: '' })
    } catch (e) {
      setClientErr(e.message || 'Failed to create client')
    }
    setCreatingClient(false)
  }

  const propType = (p) => (p?.property_type || '').toLowerCase()

  const filteredProperties = currentType === 'all'
    ? properties
    : properties.filter(p => propType(p) === currentType)

  const typeCounts = {
    all: properties.length,
    residential: properties.filter(p => propType(p) === 'residential').length,
    commercial: properties.filter(p => propType(p) === 'commercial').length,
    str: properties.filter(p => propType(p) === 'str').length,
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
    setAddingClient(false); setNewClient({ name: '', phone: '', email: '' }); setClientErr('')
    setShowForm(true)
  }

  const openNew = () => {
    setShowTypeModal(true)
  }

  const toggleSelect = (id, e) => {
    e?.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      const visibleIds = filteredProperties.map(p => p.id)
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id))
      return allSelected ? new Set() : new Set(visibleIds)
    })
  }
  const clearSelection = () => setSelectedIds(new Set())
  const bulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const verb = hardDelete ? 'permanently delete' : 'archive'
    if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}? ${hardDelete ? 'This removes them from the database entirely.' : 'They will be soft-archived (active=false).'} `)) return
    setBulkDeleting(true)
    try {
      if (hardDelete) {
        await post('/api/admin/properties/hard-delete', { ids })
      } else {
        const results = await Promise.allSettled(ids.map(id => del(`/api/properties/${id}`)))
        const failed = results.filter(r => r.status === 'rejected').length
        if (failed > 0) alert(`Archived ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      }
      clearSelection()
      await load()
    } catch (e) {
      alert('Bulk delete failed: ' + (e?.message || 'unknown'))
    } finally {
      setBulkDeleting(false)
    }
  }

  const confirmNewProperty = () => {
    setSelected(null)
    setForm({ ...EMPTY, property_type: newPropertyType })
    setAddingClient(false); setNewClient({ name: '', phone: '', email: '' }); setClientErr('')
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
          <h2 className="text-xl font-bold text-ink tracking-tight">{pageTitle}</h2>
          <div className="flex items-center gap-2">
            {properties.length > 0 && (
              <button onClick={runSweep} disabled={sweeping}
                title="Re-sync every feed and report which turnovers are missing or not on Google"
                className="flex items-center gap-2 bg-bg-2 hover:bg-bg-2 border border-hairline px-4 py-2 rounded-lg text-sm transition-colors">
                <CheckCircle className={`w-3.5 h-3.5 ${sweeping ? 'animate-spin' : ''}`} />
                {sweeping ? 'Checking…' : 'Check all turnovers'}
              </button>
            )}
            <button onClick={openNew}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> Add Property
            </button>
          </div>
        </div>

        {/* Type tabs */}
        <div className="flex gap-2 mb-5 border-b border-hairline">
          {['all', 'residential', 'commercial', 'str'].map(type => (
            <button
              key={type}
              onClick={() => setSearchParams({ type: type === 'all' ? '' : type })}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                currentType === type
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-ink-2 hover:text-ink'
              }`}
            >
              {type === 'all' ? `All (${typeCounts.all})` : `${PROPERTY_TYPE_CONFIG[type].label} (${typeCounts[type]})`}
            </button>
          ))}
        </div>

        {/* Selection / bulk-action bar */}
        <div className="flex items-center justify-between mb-3">
          <label className="flex items-center gap-2 text-xs text-ink-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filteredProperties.length > 0 && filteredProperties.every(p => selectedIds.has(p.id))}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-hairline cursor-pointer"
              data-testid="properties-select-all"
            />
            <span>Select all ({filteredProperties.length})</span>
          </label>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2" data-testid="properties-bulk-actions">
              <span className="text-xs text-ink-2 font-medium">{selectedIds.size} selected</span>
              <label className="flex items-center gap-1 text-[11px] text-ink-2 cursor-pointer select-none" title="Permanently remove from database (vs. soft-archive)">
                <input type="checkbox" checked={hardDelete}
                  onChange={e => setHardDelete(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-hairline cursor-pointer" />
                Hard delete
              </label>
              <button onClick={clearSelection}
                className="text-xs text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
                Clear
              </button>
              <button onClick={bulkDelete} disabled={bulkDeleting}
                data-testid="properties-bulk-delete"
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
                {bulkDeleting
                  ? 'Deleting...'
                  : `${hardDelete ? 'Hard delete' : 'Archive'} ${selectedIds.size}`}
              </button>
            </div>
          )}
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

        {sweep && (
          <div className="rounded-xl border border-hairline bg-panel p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-ink">Turnover health</h3>
              <button onClick={() => setSweep(null)} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
            </div>
            {sweep.error && <div className="text-sm text-red-600">{sweep.error}</div>}
            {sweep.totals && (
              <div className="text-xs text-ink-3 mb-3">
                {sweep.totals.properties} propert{sweep.totals.properties === 1 ? 'y' : 'ies'} ·
                &nbsp;{sweep.totals.scheduled} turnovers scheduled ·
                &nbsp;{sweep.totals.on_google} on Google
                {(sweep.totals.missing > 0 || sweep.totals.not_on_google > 0)
                  ? <span className="text-amber-600 font-medium">&nbsp;· {sweep.totals.missing} missing, {sweep.totals.not_on_google} not on Google</span>
                  : <span className="text-emerald-600 font-medium">&nbsp;· all good ✓</span>}
              </div>
            )}
            <div className="space-y-1.5">
              {(sweep.properties || []).map(p => (
                <div key={p.property_id} className="flex items-start justify-between gap-3 text-xs border-b border-hairline/60 last:border-0 py-1.5">
                  <div className="min-w-0">
                    <span className={`mr-1.5 ${p.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{p.ok ? '✓' : '⚠'}</span>
                    <span className="text-ink font-medium">{p.property}</span>
                    <span className="text-ink-3"> — {p.scheduled} scheduled, {p.on_google} on Google</span>
                    {p.sync_error && <span className="text-red-600"> · {p.sync_error}</span>}
                    {p.missing_dates?.length > 0 && (
                      <div className="text-amber-600 mt-0.5">Missing turnover: {p.missing_dates.join(', ')}</div>
                    )}
                    {p.not_on_google > 0 && (
                      <div className="text-amber-600 mt-0.5">{p.not_on_google} turnover(s) not on Google — check the connection/calendar.</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3 overflow-y-auto flex-1 scrollbar-thin">
          {filteredProperties.map(p => {
            const pType = propType(p)
            const Config = PROPERTY_TYPE_CONFIG[pType]
            const Icon = Config?.icon || Home

            return (
              <div key={p.id} className={`bg-panel border rounded-xl ${selectedIds.has(p.id) ? 'border-blue-400' : 'border-hairline'}`}>
                {/* Property header */}
                <div className="p-5 cursor-pointer hover:bg-bg transition-colors" onClick={() => setExpandedPropId(expandedPropId === p.id ? null : p.id)}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4 flex-1">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(p.id)}
                        onChange={(e) => toggleSelect(p.id, e)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 rounded border-hairline cursor-pointer mt-3 shrink-0"
                        data-testid="property-row-checkbox"
                        aria-label={`Select ${p.name}`}
                      />
                      <div className={`w-10 h-10 rounded-xl ${Config?.badge} flex items-center justify-center shrink-0 bg-opacity-20`}>
                        <Icon className={`w-5 h-5 ${Config?.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-ink">{p.name}</div>
                          <span className={`text-xs px-2 py-0.5 rounded ${Config?.badge}`}>{Config?.label}</span>
                        </div>
                        <div className="text-sm text-ink-2 flex items-center gap-2 mt-1">
                          {!clients.find(c => c.id === p.client_id) && (
                            <AlertTriangle className="w-3 h-3 text-red-400" title="Client not found" />
                          )}
                          {clientName(p.client_id)}
                        </div>
                        <div className="text-sm text-ink-3 mt-0.5">{p.address}{p.city ? `, ${p.city}` : ''}</div>

                        {/* Type-specific metadata */}
                        <div className="flex items-center gap-4 mt-2 flex-wrap">
                          {pType === 'str' && (
                            <>
                              <span className="flex items-center gap-1 text-xs text-ink-3">
                                <Clock className="w-3 h-3" />{p.default_duration_hours}h turnover
                              </span>
                              {p.house_code && (
                                <span className="text-xs bg-blue-500/10 text-blue-600 px-2 py-0.5 rounded">
                                  Code: {p.house_code}
                                </span>
                              )}
                              {p.check_in_time && (
                                <span className="text-xs text-ink-3">
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
                          {(pType === 'residential' || pType === 'commercial') && (
                            <>
                              {p.default_duration_hours && (
                                <span className="flex items-center gap-1 text-xs text-ink-3">
                                  <Clock className="w-3 h-3" />{p.default_duration_hours}h standard
                                </span>
                              )}
                              {p.default_crew_size && (
                                <span className="flex items-center gap-1 text-xs text-ink-3">
                                  <Users className="w-3 h-3" />{p.default_crew_size} crew
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-2">
                      {pType === 'str' && (p.icals?.length || 0) > 0 && (
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
                        className="text-xs text-ink-3 hover:text-ink bg-bg-2 hover:bg-bg-2 px-3 py-1.5 rounded-lg transition-colors">
                        Edit
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded details */}
                {expandedPropId === p.id && (
                  <div className="border-t border-hairline p-5 space-y-4 bg-bg">
                    {/* STR: iCal URLs */}
                    {pType === 'str' && (
                      <div data-testid="ical-feeds-section">
                        <div className="text-sm font-semibold text-ink-2 mb-2">Calendar Feeds</div>
                        {(p.icals || []).map(ical => (
                          <IcalFeedRow
                            key={ical.id}
                            ical={ical}
                            onRemove={() => removeIcal(p.id, ical.id)}
                            onSync={() => syncOne(p.id)}
                            syncing={syncing === p.id}
                          />
                        ))}

                        {showIcalForm === p.id ? (
                          <div className="bg-panel border border-hairline rounded-lg p-3 space-y-2">
                            <input value={icalForm.url} onChange={e => setIcalForm(f => ({ ...f, url: e.target.value }))}
                              placeholder="https://www.airbnb.com/calendar/ical/..."
                              className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none" />
                            <select value={icalForm.source} onChange={e => setIcalForm(f => ({ ...f, source: e.target.value }))}
                              className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none">
                              <option value="">Source (Airbnb / VRBO / …)</option>
                              {ICAL_SOURCES.map(s => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                              ))}
                            </select>

                            <div className="border-t border-hairline pt-2 mt-2">
                              <div className="text-xs font-semibold text-ink-2 mb-2">Turnover Settings</div>
                              <div className="grid grid-cols-2 gap-2">
                                <input value={icalForm.checkout_time} onChange={e => setIcalForm(f => ({ ...f, checkout_time: e.target.value }))}
                                  placeholder="Checkout (e.g., 11:00)"
                                  type="time"
                                  className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none" />
                                <input value={icalForm.duration_hours} onChange={e => setIcalForm(f => ({ ...f, duration_hours: e.target.value }))}
                                  placeholder="Duration (hrs)"
                                  type="number"
                                  step="0.5"
                                  className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none" />
                              </div>
                              <input value={icalForm.house_code} onChange={e => setIcalForm(f => ({ ...f, house_code: e.target.value }))}
                                placeholder="Access code"
                                className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none mt-2" />
                              <textarea value={icalForm.instructions} onChange={e => setIcalForm(f => ({ ...f, instructions: e.target.value }))}
                                placeholder="Special turnover instructions..."
                                rows="2"
                                className="w-full bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none mt-2" />
                            </div>

                            <div className="flex gap-2 pt-2">
                              <button onClick={() => addIcal(p.id)}
                                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-2 py-1.5 rounded text-xs font-medium">
                                Add Calendar
                              </button>
                              <button onClick={() => setShowIcalForm(null)}
                                className="flex-1 bg-bg-2 hover:bg-bg-2 text-ink-2 px-2 py-1.5 rounded text-xs">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <button onClick={() => setShowIcalForm(p.id)}
                              className="w-full text-xs text-blue-600 hover:text-blue-700 border border-blue-600/20 bg-blue-50/50 hover:bg-blue-50 px-3 py-2 rounded-lg transition-colors">
                              + Add Calendar URL
                            </button>
                            <button onClick={() => navigate(`/properties/${p.id}/icals`)}
                              className="w-full text-[11px] text-ink-3 hover:text-ink-2 mt-1.5">
                              Or paste multiple URLs at once →
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {p.notes && (
                      <div>
                        <div className="text-xs text-ink-3 font-semibold mb-1">Notes</div>
                        <div className="text-sm text-ink-2 bg-panel rounded p-2 border border-hairline">{p.notes}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {filteredProperties.length === 0 && (
            <EmptyState
              icon={Home}
              title={currentType === 'all'
                ? 'No properties yet'
                : `No ${PROPERTY_TYPE_CONFIG[currentType]?.label.toLowerCase()} properties yet`}
              description={currentType === 'str'
                ? 'Add an Airbnb or VRBO property to auto-create turnover jobs.'
                : 'Create a property to organize jobs and services.'}
              action={
                <button onClick={openNew} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                  Add {currentType === 'all' ? 'Property' : PROPERTY_TYPE_CONFIG[currentType]?.label}
                </button>
              }
            />
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
          <div className="bg-panel rounded-xl shadow-xl max-w-sm w-full mx-4">
            <div className="p-6">
              <h2 className="text-lg font-semibold text-ink mb-4">What kind of property?</h2>
              <div className="space-y-2">
                {['residential', 'commercial', 'str'].map(type => (
                  <button
                    key={type}
                    onClick={() => setNewPropertyType(type)}
                    className={`w-full p-3 rounded-lg border-2 text-left transition-all ${
                      newPropertyType === type
                        ? `border-blue-600 bg-blue-50`
                        : 'border-hairline hover:border-hairline'
                    }`}
                  >
                    <div className="font-medium text-ink">{PROPERTY_TYPE_CONFIG[type].label}</div>
                    <div className="text-sm text-ink-3 mt-1">
                      {type === 'residential' && 'Home or apartment'}
                      {type === 'commercial' && 'Business or office space'}
                      {type === 'str' && 'Airbnb, VRBO, or vacation rental'}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex gap-2 mt-6">
                <button onClick={() => setShowTypeModal(false)}
                  className="flex-1 bg-bg-2 hover:bg-bg-2 text-ink px-4 py-2 rounded-lg text-sm font-medium transition-colors">
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
        <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-hairline sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
            <h2 className="font-semibold text-ink">{selected ? 'Edit Property' : 'Add Property'}</h2>
            <button onClick={() => setShowForm(false)} className="text-ink-3 hover:text-ink-3"><X className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">
            {/* Type selector — for new or existing properties */}
            {(
              <div>
                <label className="block text-xs text-ink-3 mb-3 font-semibold">Property Type *</label>
                <div className="flex gap-2">
                  {['residential', 'commercial', 'str'].map(type => (
                    <button
                      key={type}
                      onClick={() => setForm(f => ({ ...f, property_type: type }))}
                      className={`flex-1 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                        form.property_type === type
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-hairline text-ink-2 hover:border-hairline'
                      }`}
                    >
                      {PROPERTY_TYPE_CONFIG[type].label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-ink-3">Client *</label>
                <button type="button"
                  onClick={() => { setAddingClient(a => !a); setClientErr('') }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium">
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
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 space-y-2">
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
                  <button type="button" onClick={createInlineClient} disabled={creatingClient || !newClient.name.trim()}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                    {creatingClient ? 'Creating…' : 'Create & select client'}
                  </button>
                </div>
              )}
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

                <div className="mt-3">
                  <label className="block text-xs text-ink-3 mb-1">Timezone</label>
                  <input value={form.timezone || ''} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}
                    placeholder="e.g. America/New_York"
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
            <button onClick={save} disabled={saving || !form.client_id || !form.name || !form.address}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving...' : 'Save Property'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
