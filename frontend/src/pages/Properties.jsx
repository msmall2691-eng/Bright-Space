import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Home, Search, RefreshCw, ChevronRight, Plus } from 'lucide-react'
import { EmptyState, PageHeader, Button } from '../components/ui'
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

  const { filteredProperties, typeCounts } = usePropertyFilters({ properties, currentType, search })

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

  const toggleSelectAll = () => toggleAll(filteredProperties.map(p => p.id))
  const bulkDelete = async () => {
    const result = await mutateBulkDelete({ ids: Array.from(selectedIds), hardDelete })
    if (result?.ok) clearSelection()
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
