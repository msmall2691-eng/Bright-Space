import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, Phone, Mail, MapPin, ChevronRight, X, Upload, LayoutGrid, TableProperties, Trash2, Users } from 'lucide-react'
import { CustomFieldsForm } from '../components/CustomFields'
import { EmptyState } from '../components/ui'
import { del, get, post, patch, upload } from "../api"
import { displayContactName } from '../utils/display'
import { useToast } from '../components/ui/Toast'

const STATUS_COLORS = {
  lead:     'bg-amber-500/15 text-amber-500 border-amber-500/20',
  active:   'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
  inactive: 'bg-bg-2 text-ink-3 border-hairline',
}

const AVATAR_COLORS = [
  'bg-blue-600/20 text-blue-400',
  'bg-emerald-600/20 text-emerald-400',
  'bg-violet-600/20 text-violet-400',
  'bg-amber-600/20 text-amber-400',
  'bg-rose-600/20 text-rose-400',
  'bg-cyan-600/20 text-cyan-400',
]
function avatarColor(name) {
  let h = 0; for (const c of (name || '')) h = ((h << 5) - h + c.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

const EMPTY = { first_name: '', last_name: '', email: '', phone: '', address: '', city: '', state: '', zip_code: '', billing_address: '', billing_city: '', billing_state: '', billing_zip: '', status: 'lead', source: '', notes: '', custom_fields: {} }

export default function Clients() {
  const navigate = useNavigate()
  const { toast, ToastContainer } = useToast()
  const [clients, setClients] = useState([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selected, setSelected] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('clients_view') || 'table') // 'cards' | 'table' — Twenty is table-first
  useEffect(() => { localStorage.setItem('clients_view', viewMode) }, [viewMode])
  const fileInputRef = useRef(null)
  const [phoneNumbers, setPhoneNumbers] = useState([])
  const [newPhoneNumber, setNewPhoneNumber] = useState('')
  const [newPhoneType, setNewPhoneType] = useState('mobile')
  const [loadingPhones, setLoadingPhones] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const load = () =>
    get(`/api/clients${statusFilter ? `?status=${statusFilter}` : ''}`).then(setClients).catch(err => console.error("[Clients]", err))

  useEffect(() => { load() }, [statusFilter])
  useEffect(() => { clearSelection() }, [statusFilter, search])

  const filtered = clients.filter(c =>
    !search || (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.phone || '').includes(search) || (c.email || '').toLowerCase().includes(search.toLowerCase())
  )

  const save = async () => {
    setSaving(true); setSaveError('')
    try {
      const url = selected ? `/api/clients/${selected.id}` : '/api/clients'
      selected ? await patch(url, form) : await post(url, form)
      await load(); setShowForm(false); setSelected(null); setForm(EMPTY); setPhoneNumbers([])
    } catch (e) { setSaveError(e.message || 'Failed to save') }
    setSaving(false)
  }

  const openNew = () => { setForm(EMPTY); setSelected(null); setPhoneNumbers([]); setShowForm(true) }
  const openEdit = (c) => {
    setForm({ ...c });
    setSelected(c);
    loadPhones(c.id)
    setShowForm(true)
  }

  const loadPhones = async (clientId) => {
    setLoadingPhones(true)
    try {
      const phones = await get(`/api/clients/${clientId}/phones`)
      setPhoneNumbers(Array.isArray(phones) ? phones : [])
    } catch (e) {
      console.error("Error loading phones:", e)
      setPhoneNumbers([])
    }
    setLoadingPhones(false)
  }

  const addPhoneNumber = async () => {
    if (!newPhoneNumber.trim() || !selected) return
    try {
      await post(`/api/clients/${selected.id}/phones`, {
        phone: newPhoneNumber,
        phone_type: newPhoneType,
        is_primary: phoneNumbers.length === 0,
      })
      setNewPhoneNumber('')
      setNewPhoneType('mobile')
      await loadPhones(selected.id)
    } catch (e) {
      console.error("Error adding phone:", e)
    }
  }

  const deletePhoneNumber = async (phoneId) => {
    if (!selected) return
    try {
      await del(`/api/clients/${selected.id}/phones/${phoneId}`)
      await loadPhones(selected.id)
    } catch (e) {
      console.error("Error deleting phone:", e)
    }
  }

  const setPhonePrimary = async (phoneId) => {
    if (!selected) return
    try {
      await patch(`/api/clients/${selected.id}/phones/${phoneId}`, { is_primary: true })
      await loadPhones(selected.id)
      await load()
    } catch (e) {
      console.error("Error setting primary phone:", e)
    }
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
    await del(`/api/clients/${id}`); await load(); setShowForm(false); setPhoneNumbers([])
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

  const statusCounts = {
    '': clients.length,
    lead: clients.filter(c => c.status === 'lead').length,
    active: clients.filter(c => c.status === 'active').length,
    inactive: clients.filter(c => c.status === 'inactive').length,
  }

  return (
    <div className="flex h-full">
      {/* Main list */}
      <div className="flex-1 flex flex-col p-4 sm:p-6 min-w-0">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients..."
              className="w-full bg-bg border border-hairline rounded-lg pl-9 pr-4 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 transition-colors" />
          </div>

          {/* Status pills */}
          <div className="flex items-center gap-1 bg-bg-2 rounded-lg p-0.5">
            {[
              { key: '', label: 'All' },
              { key: 'lead', label: 'Leads' },
              { key: 'active', label: 'Active' },
              { key: 'inactive', label: 'Inactive' },
            ].map(s => (
              <button key={s.key} onClick={() => setStatusFilter(s.key)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                  statusFilter === s.key
                    ? 'bg-panel text-ink shadow-sm'
                    : 'text-ink-3 hover:text-ink-2'
                }`}>
                {s.label}
                <span className="ml-1.5 text-[10px] text-ink-3">{statusCounts[s.key]}</span>
              </button>
            ))}
          </div>

          <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleImport} />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing}
            className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 disabled:opacity-50 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-hairline">
            <Upload className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{importing ? 'Importing...' : 'Import'}</span>
          </button>
          {/* View toggle (Twenty CRM-style) */}
          <div className="hidden sm:flex items-center bg-bg-2 rounded-lg p-0.5">
            <button onClick={() => setViewMode('cards')}
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'cards' ? 'bg-panel shadow-sm text-ink-2' : 'text-ink-3 hover:text-ink-2'}`}
              title="Card view">
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'table' ? 'bg-panel shadow-sm text-ink-2' : 'text-ink-3 hover:text-ink-2'}`}
              title="Table view">
              <TableProperties className="w-3.5 h-3.5" />
            </button>
          </div>

          <button onClick={openNew}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
            <Plus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">New Client</span>
          </button>
        </div>

        {importResult && (
          <div className={`mb-3 px-3 py-2 rounded-lg text-[12px] border flex items-center justify-between ${
            importResult.error
              ? 'bg-red-50 border-red-200 text-red-600'
              : 'bg-emerald-50 border-emerald-200 text-emerald-600'
          }`}>
            <span>
              {importResult.error
                ? `Import failed: ${importResult.error}`
                : `Imported ${importResult.added} clients${importResult.skipped ? `, skipped ${importResult.skipped} duplicates` : ''}`}
            </span>
            <button onClick={() => setImportResult(null)} className="ml-3 opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
          </div>
        )}

        {/* Selection / bulk-action bar */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3 text-[11px] text-ink-3 font-medium">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filtered.length > 0 && filtered.every(c => selectedIds.has(c.id))}
                onChange={toggleSelectAll}
                className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
                data-testid="clients-select-all"
              />
              <span>Select all</span>
            </label>
            <span>{filtered.length} client{filtered.length !== 1 ? 's' : ''}</span>
          </div>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2" data-testid="clients-bulk-actions">
              <span className="text-[11px] text-ink-2 font-medium">{selectedIds.size} selected</span>
              <button onClick={clearSelection}
                className="text-[11px] text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
                Clear
              </button>
              <button onClick={bulkDelete} disabled={bulkDeleting}
                data-testid="clients-bulk-delete"
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
                {bulkDeleting ? 'Deleting...' : `Delete ${selectedIds.size}`}
              </button>
            </div>
          )}
        </div>

        {/* Client rows â Card view */}
        {viewMode === 'cards' && (
          <div className="space-y-1.5 overflow-y-auto flex-1">
            {filtered.map(c => (
              <div key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
                className={`flex items-center gap-3 sm:gap-4 bg-panel border rounded-xl p-3 sm:p-3.5 cursor-pointer transition-all group ${selectedIds.has(c.id) ? 'border-blue-400 bg-blue-50/40' : 'border-hairline hover:border-hairline'}`}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={(e) => toggleSelect(c.id, e)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-4 h-4 rounded border-hairline cursor-pointer shrink-0"
                  data-testid="client-row-checkbox"
                  aria-label={`Select ${c.name}`}
                />
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
                  <span className="text-[12px] font-bold">{displayContactName(c)[0]?.toUpperCase()}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[13px] font-medium text-ink truncate">{displayContactName(c)}</div>
                    <span className={`sm:hidden text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium shrink-0 ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
                  </div>
                  <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap">
                    {c.phone && <span className="text-[11px] text-ink-3 flex items-center gap-1"><Phone className="w-3 h-3 shrink-0" />{c.phone}</span>}
                    {c.email && <span className="text-[11px] text-ink-3 flex items-center gap-1 min-w-0 max-w-full"><Mail className="w-3 h-3 shrink-0" /><span className="truncate">{c.email}</span></span>}
                    {c.city && <span className="text-[11px] text-ink-3 flex items-center gap-1"><MapPin className="w-3 h-3 shrink-0" />{c.city}</span>}
                  </div>
                </div>
                <span className={`hidden sm:inline-flex text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium shrink-0 ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
                <ChevronRight className="w-4 h-4 text-ink-3 group-hover:text-ink-3 transition-colors shrink-0" />
              </div>
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

        {/* Client rows â Table view (Twenty CRM-inspired) */}
        {viewMode === 'table' && (
          <div className="overflow-auto flex-1 border border-hairline rounded-xl bg-panel">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-bg z-10">
                <tr className="border-b border-hairline">
                  <th className="px-3 py-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every(c => selectedIds.has(c.id))}
                      onChange={toggleSelectAll}
                      className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
                      aria-label="Select all rows"
                    />
                  </th>
                  <th className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider px-4 py-2.5">Name</th>
                  <th className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider px-4 py-2.5">Phone</th>
                  <th className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider px-4 py-2.5">Email</th>
                  <th className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider px-4 py-2.5">City</th>
                  <th className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider px-4 py-2.5">Source</th>
                  <th className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
                    className={`border-b border-hairline cursor-pointer transition-colors ${selectedIds.has(c.id) ? 'bg-bg-2' : 'hover:bg-bg-2/60'}`}>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={(e) => toggleSelect(c.id, e)}
                        className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
                        aria-label={`Select ${c.name}`}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
                          <span className="text-[10px] font-bold">{displayContactName(c)[0]?.toUpperCase()}</span>
                        </div>
                        <span className="text-[13px] font-medium text-ink truncate">{displayContactName(c)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-3">{c.phone || 'â'}</td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-3 truncate max-w-[200px]">{c.email || 'â'}</td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-3">{c.city || 'â'}</td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-3">{c.source || 'â'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <EmptyState icon={Users} title={search || statusFilter ? 'No matching clients' : 'No clients yet'}
                description={search || statusFilter ? 'Try a different search or filter.' : undefined}
                action={!search && !statusFilter && (
                  <button onClick={openNew} className="text-xs font-semibold text-blue-600 hover:text-blue-700">Add your first client →</button>
                )} />
            )}
          </div>
        )}
      </div>

      {/* Slide-over form */}
      {showForm && (
        <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-hairline sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-hairline">
            <h2 className="text-[14px] font-semibold text-ink">{selected ? 'Edit Client' : 'New Client'}</h2>
            <button onClick={() => { setShowForm(false); setPhoneNumbers([]) }} className="text-ink-3 hover:text-ink-2 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-[11px] text-ink-3 mb-1 font-medium">First Name *</label>
                <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] text-ink-3 mb-1 font-medium">Last Name</label>
                <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              </div>
            </div>
            {[
              { label: 'Email', key: 'email' },
              { label: 'Phone', key: 'phone' },
              { label: 'Source', key: 'source' },
            ].map(({ label, key }) => (
              <div key={key}>
                <label className="block text-[11px] text-ink-3 mb-1 font-medium">{label}</label>
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              </div>
            ))}

            {/* Phone Numbers Management */}
            {selected && (
              <div className="pt-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3 mb-2 flex items-center gap-2">
                  <div className="h-px flex-1 bg-bg-2" /><span>Phone Numbers</span><div className="h-px flex-1 bg-bg-2" />
                </div>

                {/* Existing phone numbers */}
                <div className="space-y-1.5 mb-3">
                  {loadingPhones ? (
                    <div className="text-[11px] text-ink-3 py-2">Loading...</div>
                  ) : phoneNumbers.length === 0 ? (
                    <div className="text-[11px] text-ink-3 py-2">No phone numbers yet</div>
                  ) : (
                    phoneNumbers.map(p => (
                      <div key={p.id} className="flex items-center gap-2 bg-bg border border-hairline rounded-lg px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-medium text-ink">{p.phone}</div>
                          <div className="text-[10px] text-ink-3">{p.phone_type || 'mobile'}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          {p.is_primary ? (
                            <span className="text-[10px] font-semibold px-2 py-0.5 bg-blue-100 text-blue-600 rounded-full">Primary</span>
                          ) : (
                            <button onClick={() => setPhonePrimary(p.id)} className="text-[10px] px-2 py-0.5 text-ink-3 hover:text-ink-2 hover:bg-bg-2 rounded transition-colors">
                              Set Primary
                            </button>
                          )}
                          <button onClick={() => deletePhoneNumber(p.id)} className="text-ink-3 hover:text-red-500 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Add new phone */}
                <div className="space-y-2">
                  <input value={newPhoneNumber} onChange={e => setNewPhoneNumber(e.target.value)} placeholder="Add phone number"
                    className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
                  <select value={newPhoneType} onChange={e => setNewPhoneType(e.target.value)}
                    className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400">
                    <option value="mobile">Mobile</option>
                    <option value="office">Office</option>
                    <option value="home">Home</option>
                  </select>
                  <button onClick={addPhoneNumber} disabled={!newPhoneNumber.trim()}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-bg-2 disabled:text-ink-3 text-white px-3 py-2 rounded-lg text-[12px] font-medium transition-colors">
                    Add Phone Number
                  </button>
                </div>
              </div>
            )}
            <div className="pt-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3 mb-3 flex items-center gap-2">
                <div className="h-px flex-1 bg-bg-2" /><span>Service Address</span><div className="h-px flex-1 bg-bg-2" />
              </div>
              {[
                { label: 'Street', key: 'address' },
                { label: 'City', key: 'city' },
                { label: 'State', key: 'state' },
                { label: 'ZIP', key: 'zip_code' },
              ].map(({ label, key }) => (
                <div key={key} className="mb-3">
                  <label className="block text-[11px] text-ink-3 mb-1 font-medium">{label}</label>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
                </div>
              ))}
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3 mb-3 flex items-center gap-2">
                <div className="h-px flex-1 bg-bg-2" /><span>Billing Address</span><div className="h-px flex-1 bg-bg-2" />
              </div>
              {[
                { label: 'Street', key: 'billing_address' },
                { label: 'City', key: 'billing_city' },
                { label: 'State', key: 'billing_state' },
                { label: 'ZIP', key: 'billing_zip' },
              ].map(({ label, key }) => (
                <div key={key} className="mb-3">
                  <label className="block text-[11px] text-ink-3 mb-1 font-medium">{label}</label>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
                </div>
              ))}
            </div>
            <div>
              <label className="block text-[11px] text-ink-3 mb-1 font-medium">Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400">
                <option value="lead">Lead</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-ink-3 mb-1 font-medium">Notes</label>
              <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                className="w-full bg-bg border border-hairline rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 resize-none" />
            </div>
            <CustomFieldsForm
              entityType="client"
              values={form.custom_fields || {}}
              onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
            />
          </div>
          {saveError && (
            <div className="mx-6 mb-2 text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{saveError}</div>
          )}
          <div className="p-6 border-t border-hairline flex gap-3">
            {selected && (
              <button onClick={() => deleteClient(selected.id)}
                className="px-4 py-2 text-[13px] text-red-500 hover:text-red-600 border border-red-200 hover:border-red-300 rounded-lg transition-colors font-medium">
                Delete
              </button>
            )}
            <button onClick={save} disabled={saving || (!form.first_name && !form.last_name)}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-[13px] font-medium transition-colors">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
      <ToastContainer />
    </div>
  )
}
