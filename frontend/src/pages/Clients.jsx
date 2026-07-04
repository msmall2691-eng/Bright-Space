import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, Calendar } from 'lucide-react'
import JobCreateModal from '../components/JobCreateModal'
import { EmptyState } from '../components/ui'
import InlineSelect from "../components/InlineSelect"
import CRMHealthPanel from "../components/CRMHealthPanel"
import { displayContactName } from '../utils/display'
import { useToast } from '../components/ui/Toast'
import { useClients } from '../hooks/useClients'
import { useClientPhones } from '../hooks/useClientPhones'
import { useClientMutations } from '../hooks/useClientMutations'
import { useClientForm } from '../hooks/useClientForm'
import { useSelectionSet } from '../hooks/useSelectionSet'
import { STATUS_OPTIONS, DEFAULT_CLIENT_COLUMNS, avatarColor } from '../components/clients/constants'
import { ClientForm } from '../components/clients/ClientForm'
import { MergeModal } from '../components/clients/MergeModal'
import { BulkActionBar } from '../components/clients/BulkActionBar'
import { ImportResultBanner } from '../components/clients/ImportResultBanner'
import { ClientCardRow } from '../components/clients/ClientCardRow'
import { ClientTableView } from '../components/clients/ClientTableView'
import { ClientsToolbar } from '../components/clients/ClientsToolbar'

// Configurable table columns. `render(c, h)` gets the row plus page helpers
// (updateStatus, setJobClient). The leading selection checkbox is fixed and
// lives outside this registry. A saved view stores an ordered list of the
// visible column ids (see viewConfig.columns).
const CLIENT_COLUMNS = [
  { id: 'name', label: 'Name', render: (c) => (
    <div className="flex items-center gap-2.5">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
        <span className="text-[10px] font-bold">{displayContactName(c)[0]?.toUpperCase()}</span>
      </div>
      <span className="text-[13px] font-medium text-ink truncate">{displayContactName(c)}</span>
    </div>
  ) },
  { id: 'phone', label: 'Phone', render: (c) => <span className="text-[12px] text-ink-3">{c.phone || '—'}</span> },
  { id: 'email', label: 'Email', render: (c) => <span className="text-[12px] text-ink-3 truncate block max-w-[200px]">{c.email || '—'}</span> },
  { id: 'city', label: 'City', render: (c) => <span className="text-[12px] text-ink-3">{c.city || '—'}</span> },
  { id: 'state', label: 'State', render: (c) => <span className="text-[12px] text-ink-3">{c.state || '—'}</span> },
  { id: 'source', label: 'Source', render: (c) => <span className="text-[12px] text-ink-3">{c.source || '—'}</span> },
  { id: 'created', label: 'Added', render: (c) => <span className="text-[12px] text-ink-3">{c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}</span> },
  { id: 'status', label: 'Status', render: (c, h) => (
    <div className="flex items-center gap-2">
      <InlineSelect value={c.status} options={STATUS_OPTIONS} onSelect={(s) => h.updateStatus(c, s)} />
      <button onClick={(e) => { e.stopPropagation(); h.setJobClient(c) }}
        title={`Schedule a job for ${displayContactName(c)}`} aria-label={`Schedule ${c.name}`}
        className="inline-flex items-center justify-center w-6 h-6 rounded-md text-ink-3 hover:text-blue-600 hover:bg-blue-50 transition-colors">
        <Calendar className="w-3.5 h-3.5" />
      </button>
    </div>
  ) },
]
export default function Clients() {
  const navigate = useNavigate()
  const { toast, ToastContainer } = useToast()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const { clients, setClients, filtered, statusCounts, load } = useClients(statusFilter, search)
  const [selected, setSelected] = useState(null)
  // Quick "Schedule" from a client row → opens the job modal with that client.
  const [jobClient, setJobClient] = useState(null)
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('clients_view') || 'table') // 'cards' | 'table' — Twenty is table-first
  useEffect(() => { localStorage.setItem('clients_view', viewMode) }, [viewMode])
  // Visible/ordered table columns. Persisted to localStorage as the session
  // default and into each saved view's config. Filter against the registry so a
  // stale stored id (renamed/removed column) can't break rendering.
  const [columns, setColumns] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('clients_columns') || 'null')
      if (Array.isArray(saved)) return saved.filter(id => CLIENT_COLUMNS.some(c => c.id === id))
    } catch { /* fall through */ }
    return DEFAULT_CLIENT_COLUMNS
  })
  useEffect(() => { localStorage.setItem('clients_columns', JSON.stringify(columns)) }, [columns])
  const visibleColumns = columns.length
    ? columns.map(id => CLIENT_COLUMNS.find(c => c.id === id)).filter(Boolean)
    : CLIENT_COLUMNS.filter(c => DEFAULT_CLIENT_COLUMNS.includes(c.id))
  // Saved views (Twenty-style): a view persists the meaningful list state.
  const viewConfig = { statusFilter, viewMode, columns }
  const applyView = (cfg) => {
    setStatusFilter(cfg.statusFilter ?? '')
    if (cfg.viewMode) setViewMode(cfg.viewMode)
    if (Array.isArray(cfg.columns)) setColumns(cfg.columns.filter(id => CLIENT_COLUMNS.some(c => c.id === id)))
  }
  const fileInputRef = useRef(null)
  const {
    phoneNumbers,
    newPhoneNumber, setNewPhoneNumber,
    newPhoneType, setNewPhoneType,
    loadingPhones,
    loadPhones,
    addPhoneNumber,
    deletePhoneNumber,
    setPhonePrimary,
    resetPhones,
  } = useClientPhones({ selected, refreshList: load })
  const {
    showForm, setShowForm,
    form, setForm,
    showBilling, setShowBilling,
    dupes, setDupes,
    openNew, openEdit,
  } = useClientForm({ setSelected, loadPhones, resetPhones })
  const { selectedIds, toggle: toggleSelect, toggleAll, clear: clearSelection } = useSelectionSet()
  const toggleSelectAll = () => toggleAll(filtered.map(c => c.id))

  const {
    saving, saveError,
    importing, importResult, setImportResult,
    bulkDeleting,
    mergeModal, setMergeModal,
    mergeWinner, setMergeWinner,
    merging,
    updateStatus, save, handleImport, deleteClient, bulkDelete, openMerge, doMerge,
  } = useClientMutations({
    load, clients, setClients,
    selected, setSelected, form, setForm,
    dupes, setDupes,
    setShowForm, setShowBilling,
    resetPhones,
    selectedIds, clearSelection,
    toast,
  })

  useEffect(() => { clearSelection() }, [statusFilter, search])

  return (
    <div className="flex h-full">
      {/* Main list */}
      <div className="flex-1 flex flex-col p-4 sm:p-6 min-w-0">
        <ClientsToolbar
          search={search} setSearch={setSearch}
          viewConfig={viewConfig} applyView={applyView}
          clientColumns={CLIENT_COLUMNS} columns={columns} setColumns={setColumns}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter} statusCounts={statusCounts}
          fileInputRef={fileInputRef} importing={importing} handleImport={handleImport}
          viewMode={viewMode} setViewMode={setViewMode}
          openNew={openNew}
        />

        {/* Read-only CRM health snapshot — see the real/dup/spam breakdown before cleanup. */}
        <CRMHealthPanel />

        {importResult && (
          <ImportResultBanner importResult={importResult} onDismiss={() => setImportResult(null)} />
        )}

        <BulkActionBar
          filtered={filtered}
          selectedIds={selectedIds}
          toggleSelectAll={toggleSelectAll}
          clearSelection={clearSelection}
          openMerge={openMerge}
          bulkDelete={bulkDelete}
          bulkDeleting={bulkDeleting}
        />

        {/* Client rows — Card view */}
        {viewMode === 'cards' && (
          <div className="space-y-1.5 overflow-y-auto flex-1">
            {filtered.map(c => (
              <ClientCardRow
                key={c.id}
                c={c}
                selected={selectedIds.has(c.id)}
                toggleSelect={toggleSelect}
                setJobClient={setJobClient}
                navigate={navigate}
              />
            ))}
            {filtered.length === 0 && (
              <EmptyState icon={Users} title={search || statusFilter ? 'No matching clients' : 'No clients yet'}
                description={search || statusFilter ? 'Try a different search or filter.' : undefined}
                action={!search && !statusFilter && (
                  <button onClick={openNew} className="text-xs font-semibold text-blue-600 hover:text-blue-700">Add your first client →</button>
                )} />
            )}
          </div>
        )}

        {/* Client rows — Table view (Twenty CRM-inspired) */}
        {viewMode === 'table' && (
          <ClientTableView
            filtered={filtered}
            visibleColumns={visibleColumns}
            selectedIds={selectedIds}
            toggleSelect={toggleSelect}
            toggleSelectAll={toggleSelectAll}
            updateStatus={updateStatus}
            setJobClient={setJobClient}
            navigate={navigate}
            search={search}
            statusFilter={statusFilter}
            openNew={openNew}
          />
        )}
      </div>

      {showForm && (
        <ClientForm
          selected={selected}
          form={form} setForm={setForm}
          onClose={() => { setShowForm(false); resetPhones() }}
          phoneNumbers={phoneNumbers} loadingPhones={loadingPhones}
          newPhoneNumber={newPhoneNumber} setNewPhoneNumber={setNewPhoneNumber}
          newPhoneType={newPhoneType} setNewPhoneType={setNewPhoneType}
          setPhonePrimary={setPhonePrimary}
          deletePhoneNumber={deletePhoneNumber}
          addPhoneNumber={addPhoneNumber}
          showBilling={showBilling} setShowBilling={setShowBilling}
          dupes={dupes}
          saveError={saveError}
          saving={saving}
          save={save}
          deleteClient={deleteClient}
          navigate={navigate}
        />
      )}
      {mergeModal && (
        <MergeModal
          mergeModal={mergeModal}
          mergeWinner={mergeWinner}
          setMergeWinner={setMergeWinner}
          merging={merging}
          setMergeModal={setMergeModal}
          doMerge={doMerge}
        />
      )}
      {jobClient && (
        <JobCreateModal
          clientId={jobClient.id}
          clientName={jobClient.name}
          onClose={() => setJobClient(null)}
          onCreated={() => { setJobClient(null); toast.success('Job scheduled ✓') }}
        />
      )}
      <ToastContainer />
    </div>
  )
}
