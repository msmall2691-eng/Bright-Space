import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Home } from 'lucide-react'
import { EmptyState, PageHero, SubNav } from '../components/ui'
import { PROPERTY_TYPE_CONFIG } from '../components/properties/constants'
import { TypeSelectorModal } from '../components/properties/TypeSelectorModal'
import { PropertyForm } from '../components/properties/PropertyForm'
import { SyncToolsPanel, SweepResultsPanel } from '../components/properties/SyncToolsPanel'
import { PropertyRow } from '../components/properties/PropertyRow'
import { BulkActionBar, SyncResultBanner, PropertiesToolbar } from '../components/properties/PropertiesToolbar'
import { useProperties } from '../hooks/useProperties'
import { usePropertyMutations } from '../hooks/usePropertyMutations'
import { usePropertyForm } from '../hooks/usePropertyForm'
import { useSelectionSet } from '../hooks/useSelectionSet'
import { usePropertyFilters } from '../hooks/usePropertyFilters'

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

  const { properties, clients, setClients, load } = useProperties()

  const {
    saving, syncing,
    syncResult, setSyncResult,
    sweep, setSweep,
    sweeping, rebuildingId, bulkDeleting,
    save: saveProperty,
    addIcal: mutateAddIcal,
    removeIcal: mutateRemoveIcal,
    syncOne, syncAll, runSweep, rebuildOne,
    deactivateOne,
    bulkDelete: mutateBulkDelete,
  } = usePropertyMutations({ load })

  const {
    showForm, setShowForm,
    showTypeModal, setShowTypeModal,
    newPropertyType, setNewPropertyType,
    selected,
    form, setForm,
    addingClient, setAddingClient,
    newClient, setNewClient,
    creatingClient,
    clientErr, setClientErr,
    clientDupes, setClientDupes,
    selectClient,
    createInlineClient,
    pickClient,
    openEdit,
    openNew,
    confirmNewProperty,
    resetAfterSave,
  } = usePropertyForm({ clients, setClients })

  // Deep-link entry point: PropertyDetail's "Edit Property" button lands
  // here with ?edit=<id>. Reuse the exact same openEdit() the row's own
  // Edit button calls, then drop the param so back/refresh doesn't
  // re-trigger the modal.
  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId) return
    const target = properties.find(p => String(p.id) === editId)
    if (!target) return
    openEdit(target)
    const next = new URLSearchParams(searchParams)
    next.delete('edit')
    setSearchParams(next, { replace: true })
  }, [searchParams, properties, openEdit, setSearchParams])

  const [expandedPropId, setExpandedPropId] = useState(null)
  const [icalForm, setIcalForm] = useState({ url: '', source: '' })
  const [showIcalForm, setShowIcalForm] = useState(null)
  // Sync/repair tooling (health check, sync-all, rebuild) is power-user stuff
  // that used to crowd the main screen — tucked behind this toggle now.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [hardDelete, setHardDelete] = useState(false)
  const { selectedIds, toggle: toggleSelect, toggleAll, clear: clearSelection } = useSelectionSet()

  const clientName = (id) => {
    const client = clients.find(c => c.id === id)
    return client?.name || `Client #${id}`
  }

  const [missingAccessOnly, setMissingAccessOnly] = useState(false)
  const { filteredProperties, typeCounts, missingAccessCount } = usePropertyFilters({ properties, currentType, search, missingAccessOnly })

  // STR turnover-pipeline health (same chip pattern as missing-access): a
  // rental with no feed or a stale feed is the one where a guest walks into
  // a dirty unit. Client-side narrow over the already-filtered list — the
  // ical_health rollup ships with every property row.
  const needsFeedAttention = (p) =>
    (p?.property_type || '').toLowerCase() === 'str' &&
    (p?.ical_health === 'no_feed' || p?.ical_health === 'stale')
  const [feedAttentionOnly, setFeedAttentionOnly] = useState(false)
  const feedAttentionCount = properties.filter(needsFeedAttention).length
  const visibleProperties = feedAttentionOnly
    ? filteredProperties.filter(needsFeedAttention)
    : filteredProperties

  const save = async () => {
    const result = await saveProperty({ selected, form })
    if (result.ok) resetAfterSave()
  }

  const addIcal = async (propId) => {
    const result = await mutateAddIcal(propId, icalForm)
    if (result?.ok) {
      setShowIcalForm(null)
      setIcalForm({ url: '', source: '' })
    }
  }

  const removeIcal = (propId, icalId) => mutateRemoveIcal(propId, icalId)

  const toggleSelectAll = () => toggleAll(visibleProperties.map(p => p.id))
  const bulkDelete = async () => {
    const result = await mutateBulkDelete({ ids: Array.from(selectedIds), hardDelete })
    if (result?.ok) clearSelection()
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 sm:px-8 pt-4">
          {/* No type pods in the hero — the type counts + filter live in one
              always-visible neutral segmented control in the toolbar below, so
              the count isn't shown twice and the active tab is never ambiguous
              (matches Clients #1041). */}
          <PageHero
            title="Properties"
            subtitle="Homes, rentals, and commercial sites you service"
            icon={Home}
          >
            <SubNav />
          </PageHero>
        </div>

        <div className="flex-1 flex flex-col min-h-0 px-4 sm:px-8 pb-4 sm:pb-6 pt-4">
          <PropertiesToolbar
            search={search} setSearch={setSearch}
            currentType={currentType}
            onTypeChange={(key) => setSearchParams({ type: key === 'all' ? '' : key })}
            typeCounts={typeCounts}
            hasStr={typeCounts.str > 0}
            showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced}
            viewConfig={viewConfig} applyView={applyView}
            openNew={openNew}
          />

          {(missingAccessCount > 0 || feedAttentionCount > 0) && (
            <div className="flex items-center gap-2 flex-wrap self-start mb-2">
              {feedAttentionCount > 0 && (
                /* Needs-attention-first nudge: STRs whose turnover feed is
                   missing or stale — the "guest walks into a dirty rental"
                   failure mode. One chip, work it down to zero. Quiet
                   dot+word filter chip — same shape as the icalPill in
                   client/PropertiesTab.jsx, no fill. */
                <button onClick={() => setFeedAttentionOnly(v => !v)} aria-pressed={feedAttentionOnly}
                  className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
                    feedAttentionOnly
                      ? 'bg-bg-2 border-hairline-2 text-ink'
                      : 'bg-panel border-hairline text-ink-2 hover:bg-bg-2'}`}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-red-500" aria-hidden="true" />
                  Turnover feed needs attention ({feedAttentionCount})
                  {feedAttentionOnly && <span className="text-ink-3">· showing only these</span>}
                </button>
              )}
              {missingAccessCount > 0 && (
                /* The batch-fill sweep: every property here shows crew "no access
                   info on file". One chip, then work the list down to zero. */
                <button onClick={() => setMissingAccessOnly(v => !v)} aria-pressed={missingAccessOnly}
                  className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
                    missingAccessOnly
                      ? 'bg-bg-2 border-hairline-2 text-ink'
                      : 'bg-panel border-hairline text-ink-2 hover:bg-bg-2'}`}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" aria-hidden="true" />
                  Missing access info ({missingAccessCount})
                  {missingAccessOnly && <span className="text-ink-3">· showing only these</span>}
                </button>
              )}
            </div>
          )}
          <BulkActionBar
            filteredProperties={visibleProperties}
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

          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin bb-board-in">
            {visibleProperties.map(p => (
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
                deactivateOne={deactivateOne}
                icalForm={icalForm}
                setIcalForm={setIcalForm}
                showIcalForm={showIcalForm}
                setShowIcalForm={setShowIcalForm}
                addIcal={addIcal}
                removeIcal={removeIcal}
              />
            ))}

            {visibleProperties.length === 0 && (
              <EmptyState
                icon={Home}
                title={currentType === 'all'
                  ? 'No properties yet'
                  : `No ${PROPERTY_TYPE_CONFIG[currentType]?.label.toLowerCase()} properties yet`}
                description={currentType === 'str'
                  ? 'Add an Airbnb or VRBO property to auto-create turnover jobs.'
                  : 'Create a property to organize jobs and services.'}
                action={
                  <button onClick={openNew} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                    Add {currentType === 'all' ? 'Property' : PROPERTY_TYPE_CONFIG[currentType]?.label}
                  </button>
                }
              />
            )}
          </div>
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
          clientDupes={clientDupes} setClientDupes={setClientDupes}
          selectClient={selectClient}
          createInlineClient={createInlineClient}
          pickClient={pickClient}
          saving={saving}
          onClose={() => setShowForm(false)}
          onSave={save}
        />
      )}
    </div>
  )
}
