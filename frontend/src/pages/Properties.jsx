import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, X, RefreshCw, CheckCircle, AlertCircle, Clock, Link, Trash2, Users, Calendar, ChevronRight, AlertTriangle, Search } from 'lucide-react'
import SavedViewsBar from '../components/SavedViewsBar'
import { EmptyState } from '../components/ui'
import { get, post, patch, del } from "../api"
import { ICAL_SOURCES, EMPTY, PROPERTY_TYPE_CONFIG } from '../components/properties/constants'
import { IcalFeedRow } from '../components/properties/IcalFeedRow'
import { TypeSelectorModal } from '../components/properties/TypeSelectorModal'
import { PropertyForm } from '../components/properties/PropertyForm'
import { SyncToolsPanel, SweepResultsPanel } from '../components/properties/SyncToolsPanel'


export default function Properties() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const currentType = searchParams.get('type') || 'all'
  const [search, setSearch] = useState('')

  // Saved-views snapshot/restore (property type lives in the URL).
  const viewConfig = { propertyType: currentType, search }
  const applyView = (cfg) => {
    setSearchParams({ type: (cfg.propertyType && cfg.propertyType !== 'all') ? cfg.propertyType : '' })
    setSearch(cfg.search ?? '')
  }

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
  const [rebuildingId, setRebuildingId] = useState(null)
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

  // Fix one flagged property right from the health report: force-rebuild its
  // turnovers from the feed, then re-run the sweep so the row re-verifies.
  const rebuildOne = async (propertyId) => {
    setRebuildingId(propertyId)
    try {
      await post(`/api/properties/${propertyId}/rebuild-turnovers`)
      const data = await post('/api/properties/turnover-sweep')
      setSweep(data)
    } catch (e) {
      setSweep(s => ({ ...(s || {}), error: String(e?.message || e) }))
    }
    setRebuildingId(null)
  }
  const [expandedPropId, setExpandedPropId] = useState(null)
  const [icalForm, setIcalForm] = useState({ url: '', source: '' })
  const [showIcalForm, setShowIcalForm] = useState(null)
  // Sync/repair tooling (health check, sync-all, rebuild) is power-user stuff
  // that used to crowd the main screen — tucked behind this toggle now.
  const [showAdvanced, setShowAdvanced] = useState(false)
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

  // Memoized: re-filter only when the data, type tab, or search changes — not
  // on every render of this state-heavy page (~30 useState).
  const filteredProperties = useMemo(() => {
    const base = currentType === 'all'
      ? properties
      : properties.filter(p => propType(p) === currentType)
    const q = search.trim().toLowerCase()
    if (!q) return base
    return base.filter(p =>
      [p.name, p.address, p.client_name].some(v => (v || '').toLowerCase().includes(q))
    )
  }, [properties, currentType, search])

  // One pass over properties (was three scans), recomputed only on data change.
  const typeCounts = useMemo(() => {
    const counts = { all: properties.length, residential: 0, commercial: 0, str: 0 }
    for (const p of properties) {
      const t = propType(p)
      if (t in counts) counts[t] += 1
    }
    return counts
  }, [properties])

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
      // Timing/access (checkout time, duration, house code) come from the
      // property's own STR settings — no need to re-enter them per feed.
      await post(`/api/properties/${propId}/icals`, { url: icalForm.url.trim(), source: icalForm.source })
      await load()
      setShowIcalForm(null)
      setIcalForm({ url: '', source: '' })
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
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search properties…"
                className="bg-bg-2 border border-hairline rounded-lg pl-8 pr-3 py-2 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 w-40 sm:w-52" />
            </div>
            <SavedViewsBar entityType="property" currentConfig={viewConfig} onApply={applyView} defaultLabel="All properties" />
            {typeCounts.str > 0 && (
              <button onClick={() => setShowAdvanced(v => !v)}
                title="Sync tools and turnover health check"
                className={`flex items-center gap-2 border border-hairline px-4 py-2 rounded-lg text-sm transition-colors ${showAdvanced ? 'bg-bg-2 text-ink' : 'bg-panel hover:bg-bg-2 text-ink-2'}`}>
                <RefreshCw className="w-3.5 h-3.5" />
                Sync tools
                <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
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

        {showAdvanced && (
          <SyncToolsPanel
            syncAll={syncAll} syncing={syncing}
            runSweep={runSweep} sweeping={sweeping}
          />
        )}

        {showAdvanced && sweep && (
          <SweepResultsPanel
            sweep={sweep}
            onDismiss={() => setSweep(null)}
            rebuildOne={rebuildOne}
            rebuildingId={rebuildingId}
          />
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
                            <p className="text-[11px] text-ink-3">
                              Checkout time, duration, and access code come from this property's STR settings.
                            </p>

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


      {showTypeModal && (
        <TypeSelectorModal
          selected={newPropertyType}
          onSelect={setNewPropertyType}
          onCancel={() => setShowTypeModal(false)}
          onConfirm={confirmNewProperty}
        />
      )}

      {showForm && (
        <PropertyForm
          selected={selected}
          form={form} setForm={setForm}
          clients={clients}
          addingClient={addingClient} setAddingClient={setAddingClient}
          newClient={newClient} setNewClient={setNewClient}
          creatingClient={creatingClient}
          clientErr={clientErr} setClientErr={setClientErr}
          selectClient={selectClient}
          createInlineClient={createInlineClient}
          saving={saving}
          onClose={() => setShowForm(false)}
          onSave={save}
        />
      )}
    </div>
  )
}
