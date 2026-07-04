import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, Calendar } from 'lucide-react'
import JobCreateModal from '../components/JobCreateModal'
import { EmptyState } from '../components/ui'
import { del, post, patch, upload } from "../api"
import InlineSelect from "../components/InlineSelect"
import CRMHealthPanel from "../components/CRMHealthPanel"
import { displayContactName } from '../utils/display'
import { useToast } from '../components/ui/Toast'
import { useClients } from '../hooks/useClients'
import { useClientPhones } from '../hooks/useClientPhones'
import { STATUS_OPTIONS, EMPTY, DEFAULT_CLIENT_COLUMNS, avatarColor } from '../components/clients/constants'
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
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  // Billing address is usually the same as the service address; hide it behind
  // a toggle unless the client actually has separate billing details.
  const [showBilling, setShowBilling] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  // Quick "Schedule" from a client row → opens the job modal with that client.
  const [jobClient, setJobClient] = useState(null)
  const [dupes, setDupes] = useState([]) // possible duplicates surfaced on create (non-blocking)
  // Invalidate the duplicate warning whenever a match-relevant field changes, so
  // editing the name/phone/email after a warning re-runs the check on next save
  // instead of "Create anyway" slipping through with the new values (Codex review).
  useEffect(() => { setDupes([]) }, [form.first_name, form.last_name, form.phone, form.email])
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
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
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [mergeModal, setMergeModal] = useState(null) // { a, b } the two clients being merged
  const [mergeWinner, setMergeWinner] = useState(null) // id of the surviving record
  const [merging, setMerging] = useState(false)

  // Inline-edit: change a client's status straight from the table (optimistic;
  // reverts on failure). Mirrors Twenty's click-a-cell-to-edit pattern.
  async function updateStatus(c, status) {
    const prev = c.status
    setClients(cs => cs.map(x => (x.id === c.id ? { ...x, status } : x)))
    try {
      await patch(`/api/clients/${c.id}`, { status })
    } catch (err) {
      console.error("[Clients] status update failed", err)
      setClients(cs => cs.map(x => (x.id === c.id ? { ...x, status: prev } : x)))
    }
  }

  useEffect(() => { clearSelection() }, [statusFilter, search])

  const save = async () => {
    setSaving(true); setSaveError('')
    try {
      // Dupe check on create — non-blocking. First save surfaces any matches;
      // saving again (dupes already shown) creates anyway.
      if (!selected && dupes.length === 0) {
        const q = new URLSearchParams()
        const nm = `${form.first_name || ''} ${form.last_name || ''}`.trim()
        if (nm) q.set('name', nm)
        if (form.phone) q.set('phone', form.phone)
        if (form.email) q.set('email', form.email)
        if ([...q.keys()].length) {
          const res = await get(`/api/clients/check-duplicate?${q.toString()}`).catch(() => null)
          if (res?.duplicates?.length) { setDupes(res.duplicates); setSaving(false); return }
        }
      }
      const url = selected ? `/api/clients/${selected.id}` : '/api/clients'
      selected ? await patch(url, form) : await post(url, form)
      await load(); setShowForm(false); setSelected(null); setForm(EMPTY); resetPhones(); setDupes([])
    } catch (e) { setSaveError(e.message || 'Failed to save') }
    setSaving(false)
  }

  const openNew = () => { setForm(EMPTY); setSelected(null); resetPhones(); setDupes([]); setShowBilling(false); setShowForm(true) }
  const openEdit = (c) => {
    setForm({ ...c });
    setSelected(c);
    setDupes([])
    setShowBilling(Boolean(c.billing_address || c.billing_city || c.billing_state || c.billing_zip))
    loadPhones(c.id)
    setShowForm(true)
  }

  const handleImport = async (e) => {
    const f = e.target.files?.[0]; if (!f) return
    setImporting(true); setImportResult(null)
    const fd = new FormData(); fd.append('file', f)
    try {
      const data = await upload('/api/clients/import-xlsx', fd)
      setImportResult(data); await load()
    } catch (err) { setImportResult({ error: err.message }) }
    setImporting(false); e.target.value = ''
  }

  const deleteClient = async (id) => {
    if (!confirm('Delete this client?')) return
    await del(`/api/clients/${id}`); await load(); setShowForm(false); resetPhones()
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
      const visibleIds = filtered.map(c => c.id)
      const allSelected = visibleIds.every(id => prev.has(id))
      return allSelected ? new Set() : new Set(visibleIds)
    })
  }
  const clearSelection = () => setSelectedIds(new Set())
  const bulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} client${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(ids.map(id => del(`/api/clients/${id}`)))
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) toast.error(`Deleted ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      clearSelection()
      await load()
    } finally {
      setBulkDeleting(false)
    }
  }

  const openMerge = () => {
    const [a, b] = Array.from(selectedIds).map(id => clients.find(c => c.id === id)).filter(Boolean)
    if (!a || !b) return
    setMergeModal({ a, b })
    // Default the survivor to the more-complete / active record.
    const score = c => (c.status === 'active' ? 2 : 0) + (c.email ? 1 : 0) + (c.phone ? 1 : 0)
    setMergeWinner(score(b) > score(a) ? b.id : a.id)
  }
  const doMerge = async () => {
    if (!mergeModal || !mergeWinner) return
    const winner = mergeWinner
    const loser = mergeModal.a.id === winner ? mergeModal.b.id : mergeModal.a.id
    setMerging(true)
    try {
      await post(`/api/clients/${winner}/merge`, { loser_id: loser })
      toast.success('Clients merged')
      setMergeModal(null); clearSelection(); await load()
    } catch (e) {
      toast.error('Could not merge: ' + (e?.message || 'unknown error'))
    }
    setMerging(false)
  }

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
