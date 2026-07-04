import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Home } from 'lucide-react'
import { EmptyState } from '../components/ui'
import { get, post, patch, del } from "../api"
import { EMPTY, PROPERTY_TYPE_CONFIG } from '../components/properties/constants'
import { TypeSelectorModal } from '../components/properties/TypeSelectorModal'
import { PropertyForm } from '../components/properties/PropertyForm'
import { SyncToolsPanel, SweepResultsPanel } from '../components/properties/SyncToolsPanel'
import { PropertyRow } from '../components/properties/PropertyRow'
import { PropertiesToolbar, BulkActionBar, SyncResultBanner } from '../components/properties/PropertiesToolbar'


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

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col min-w-0">
        <PropertiesToolbar
          currentType={currentType}
          search={search} setSearch={setSearch}
          viewConfig={viewConfig} applyView={applyView}
          typeCounts={typeCounts}
          showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced}
          onAddNew={openNew}
          setSearchParams={setSearchParams}
        />

        <BulkActionBar
          filteredProperties={filteredProperties}
          selectedIds={selectedIds}
          toggleSelectAll={toggleSelectAll}
          clearSelection={clearSelection}
          hardDelete={hardDelete} setHardDelete={setHardDelete}
          bulkDelete={bulkDelete} bulkDeleting={bulkDeleting}
        />

        {syncResult && (
          <SyncResultBanner syncResult={syncResult} onDismiss={() => setSyncResult(null)} />
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
          {filteredProperties.map(p => (
            <PropertyRow
              key={p.id}
              p={p}
              clients={clients}
              clientName={clientName}
              selectedIds={selectedIds}
              toggleSelect={toggleSelect}
              expandedPropId={expandedPropId}
              setExpandedPropId={setExpandedPropId}
              syncing={syncing}
              syncOne={syncOne}
              navigate={navigate}
              openEdit={openEdit}
              icalForm={icalForm}
              setIcalForm={setIcalForm}
              showIcalForm={showIcalForm}
              setShowIcalForm={setShowIcalForm}
              addIcal={addIcal}
              removeIcal={removeIcal}
            />
          ))}

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
