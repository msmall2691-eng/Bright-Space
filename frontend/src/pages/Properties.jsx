import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Home, Search, RefreshCw, ChevronRight, Plus } from 'lucide-react'
import { EmptyState, PageHero } from '../components/ui'
import SavedViewsBar from '../components/SavedViewsBar'
import { PROPERTY_TYPE_CONFIG } from '../components/properties/constants'
import { TypeSelectorModal } from '../components/properties/TypeSelectorModal'
import { PropertyForm } from '../components/properties/PropertyForm'
import { SyncToolsPanel, SweepResultsPanel } from '../components/properties/SyncToolsPanel'
import { PropertyRow } from '../components/properties/PropertyRow'
import { BulkActionBar, SyncResultBanner } from '../components/properties/PropertiesToolbar'
import { useProperties } from '../hooks/useProperties'
import { usePropertyMutations } from '../hooks/usePropertyMutations'
import { usePropertyForm } from '../hooks/usePropertyForm'
import { useSelectionSet } from '../hooks/useSelectionSet'
import { usePropertyFilters } from '../hooks/usePropertyFilters'

// Type tabs shown under the page header — mirrors PROPERTY_TYPE_CONFIG's
// keys plus the synthetic "all" bucket used by usePropertyFilters.
const TYPE_TABS = ['all', 'residential', 'commercial', 'str']

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
    selectClient,
    createInlineClient,
    openEdit,
    openNew,
    confirmNewProperty,
    resetAfterSave,
  } = usePropertyForm({ clients, setClients })

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
        <PageHero
          title="Properties"
          subtitle="Homes, rentals, and commercial sites you service"
          icon={Home}
          pods={[
            { label: 'All', value: typeCounts.all },
            { label: 'Residential', value: typeCounts.residential ?? 0, tone: 'text-blue-300' },
            { label: 'Commercial', value: typeCounts.commercial ?? 0, tone: 'text-amber-300' },
            { label: 'STR', value: typeCounts.str ?? 0, tone: 'text-emerald-300' },
          ]}
          actions={
            <>
              {typeCounts.str > 0 && (
                <button onClick={() => setShowAdvanced(v => !v)}
                  title="Sync tools and turnover health check"
                  className={`flex items-center gap-2 border border-hairline-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${showAdvanced ? 'bg-bg-2 text-ink' : 'bg-panel hover:bg-bg-2 text-ink-2'}`}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  Sync tools
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
                </button>
              )}
              <button onClick={openNew}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-md text-xs font-medium transition-colors">
                <Plus className="w-4 h-4" /> Add Property
              </button>
            </>
          }
        >
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search properties…"
                className="bg-bg-2 border border-hairline rounded-lg pl-8 pr-3 py-2 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 w-40 sm:w-52" />
            </div>
            <SavedViewsBar entityType="property" currentConfig={viewConfig} onApply={applyView} defaultLabel="All properties" />
          </div>

          {/* Type tabs — scroll horizontally on mobile so "All / Residential /
              Commercial / STR" (+ counts) never clip past the edge at 375px. */}
          <div className="flex gap-2 mt-4 border-b border-hairline overflow-x-auto scrollbar-thin">
            {TYPE_TABS.map(type => (
              <button
                key={type}
                onClick={() => setSearchParams({ type: type === 'all' ? '' : type })}
                className={`shrink-0 whitespace-nowrap px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  currentType === type
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-ink-2 hover:text-ink'
                }`}
              >
                {type === 'all' ? `All (${typeCounts.all})` : `${PROPERTY_TYPE_CONFIG[type].label} (${typeCounts[type]})`}
              </button>
            ))}
          </div>
        </PageHero>
        </div>

        <div className="flex-1 flex flex-col min-h-0 px-4 sm:px-8 pb-4 sm:pb-6">
          {(missingAccessCount > 0 || feedAttentionCount > 0) && (
            <div className="flex items-center gap-2 flex-wrap self-start mb-2">
              {feedAttentionCount > 0 && (
                /* Needs-attention-first nudge: STRs whose turnover feed is
                   missing or stale — the "guest walks into a dirty rental"
                   failure mode. One chip, work it down to zero. */
                <button onClick={() => setFeedAttentionOnly(v => !v)} aria-pressed={feedAttentionOnly}
                  className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                    feedAttentionOnly
                      ? 'bg-red-500 border-red-500 text-white'
                      : 'bg-red-50 border-red-300 text-red-800 hover:bg-red-100'}`}>
                  📅 Turnover feed needs attention ({feedAttentionCount})
                  {feedAttentionOnly && <span className="opacity-80">· showing only these</span>}
                </button>
              )}
              {missingAccessCount > 0 && (
                /* The batch-fill sweep: every property here shows crew "no access
                   info on file". One chip, then work the list down to zero. */
                <button onClick={() => setMissingAccessOnly(v => !v)} aria-pressed={missingAccessOnly}
                  className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                    missingAccessOnly
                      ? 'bg-amber-500 border-amber-500 text-white'
                      : 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'}`}>
                  🔑 Missing access info ({missingAccessCount})
                  {missingAccessOnly && <span className="opacity-80">· showing only these</span>}
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

          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
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
