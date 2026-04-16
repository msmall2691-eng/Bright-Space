import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, Phone, Mail, MapPin, ChevronRight, X, Upload, LayoutGrid, TableProperties } from 'lucide-react'
import { CustomFieldsForm } from '../components/CustomFields'
import { del, get, post, patch, upload } from "../api"

const STATUS_COLORS = {
  lead:     'bg-amber-500/15 text-amber-500 border-amber-500/20',
  active:   'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
  inactive: 'bg-zinc-100 text-zinc-400 border-zinc-200',
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
  const [viewMode, setViewMode] = useState('cards') // 'cards' | 'table'
  const fileInputRef = useRef(null)

  const load = () =>
    get(`/api/clients${statusFilter ? `?status=${statusFilter}` : ''}`).then(setClients).catch(err => console.error("[Clients]", err))

  useEffect(() => { load() }, [statusFilter])

  const filtered = clients.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.phone || '').includes(search) || (c.email || '').toLowerCase().includes(search.toLowerCase())
  )

  const save = async () => {
    setSaving(true); setSaveError('')
    try {
      const url = selected ? `/api/clients/${selected.id}` : '/api/clients'
      selected ? await patch(url, form) : await post(url, form)
      await load(); setShowForm(false); setSelected(null); setForm(EMPTY)
    } catch (e) { setSaveError(e.message || 'Failed to save') }
    setSaving(false)
  }

  const openNew = () => { setForm(EMPTY); setSelected(null); setShowForm(true) }
  const openEdit = (c) => { setForm({ ...c }); setSelected(c); setShowForm(true) }

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
    await del(`/api/clients/${id}`); await load(); setShowForm(false)
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
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients..."
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg pl-9 pr-4 py-2 text-[13px] text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 transition-colors" />
          </div>

          {/* Status pills */}
          <div className="flex items-center gap-1 bg-zinc-100 rounded-lg p-0.5">
            {[
              { key: '', label: 'All' },
              { key: 'lead', label: 'Leads' },
              { key: 'active', label: 'Active' },
              { key: 'inactive', label: 'Inactive' },
            ].map(s => (
              <button key={s.key} onClick={() => setStatusFilter(s.key)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                  statusFilter === s.key
                    ? 'bg-white text-zinc-900 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-700'
                }`}>
                {s.label}
                <span className="ml-1.5 text-[10px] text-zinc-400">{statusCounts[s.key]}</span>
              </button>
            ))}
          </div>

          <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleImport} />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing}
            className="flex items-center gap-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-600 disabled:opacity-50 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-zinc-200">
            <Upload className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{importing ? 'Importing...' : 'Import'}</span>
          </button>
          {/* View toggle (Twenty CRM-style) */}
          <div className="hidden sm:flex items-center bg-zinc-100 rounded-lg p-0.5">
            <button onClick={() => setViewMode('cards')}
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'cards' ? 'bg-white shadow-sm text-zinc-700' : 'text-zinc-400 hover:text-zinc-600'}`}
              title="Card view">
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'table' ? 'bg-white shadow-sm text-zinc-700' : 'text-zinc-400 hover:text-zinc-600'}`}
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

        <div className="text-[11px] text-zinc-400 mb-3 font-medium">{filtered.length} client{filtered.length !== 1 ? 's' : ''}</div>

        {/* Client rows â Card view */}
        {viewMode === 'cards' && (
          <div className="space-y-1.5 overflow-y-auto flex-1">
            {filtered.map(c => (
              <div key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
                className="flex items-center gap-4 bg-white border border-zinc-200 hover:border-zinc-300 rounded-xl p-3.5 cursor-pointer transition-all group">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
                  <span className="text-[12px] font-bold">{c.name[0]?.toUpperCase()}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-zinc-900">{c.name}</div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {c.phone && <span className="text-[11px] text-zinc-400 flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>}
                    {c.email && <span className="text-[11px] text-zinc-400 flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</span>}
                    {c.city && <span className="text-[11px] text-zinc-400 flex items-center gap-1"><MapPin className="w-3 h-3" />{c.city}</span>}
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
                <ChevronRight className="w-4 h-4 text-zinc-300 group-hover:text-zinc-400 transition-colors" />
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="text-center py-16 text-zinc-400 text-[13px]">No clients found</div>
            )}
          </div>
        )}

        {/* Client rows â Table view (Twenty CRM-inspired) */}
        {viewMode === 'table' && (
          <div className="overflow-auto flex-1 border border-zinc-200 rounded-xl bg-white">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-zinc-50 z-10">
                <tr className="border-b border-zinc-200">
                  <th className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-4 py-2.5">Name</th>
                  <th className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-4 py-2.5">Phone</th>
                  <th className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-4 py-2.5">Email</th>
                  <th className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-4 py-2.5">City</th>
                  <th className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-4 py-2.5">Source</th>
                  <th className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
                    className="border-b border-zinc-100 hover:bg-blue-50/30 cursor-pointer transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
                          <span className="text-[10px] font-bold">{c.name[0]?.toUpperCase()}</span>
                        </div>
                        <span className="text-[13px] font-medium text-zinc-900 truncate">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-zinc-500">{c.phone || 'â'}</td>
                    <td className="px-4 py-2.5 text-[12px] text-zinc-500 truncate max-w-[200px]">{c.email || 'â'}</td>
                    <td className="px-4 py-2.5 text-[12px] text-zinc-500">{c.city || 'â'}</td>
                    <td className="px-4 py-2.5 text-[12px] text-zinc-400">{c.source || 'â'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="text-center py-16 text-zinc-400 text-[13px]">No clients found</div>
            )}
          </div>
        )}
      </div>

      {/* Slide-over form */}
      {showForm && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-zinc-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200">
            <h2 className="text-[14px] font-semibold text-zinc-900">{selected ? 'Edit Client' : 'New Client'}</h2>
            <button onClick={() => setShowForm(false)} className="text-zinc-400 hover:text-zinc-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-[11px] text-zinc-400 mb-1 font-medium">First Name *</label>
                <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-[13px] text-zinc-900 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] text-zinc-400 mb-1 font-medium">Last Name</label>
                <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-[13px] text-zinc-900 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              </div>
            </div>
            {[
              { label: 'Phone', key: 'phone' },
              { label: 'Email', key: 'email' },
              { label: 'Source', key: 'source' },
            ].map(({ label, key }) => (
              <div key={key}>
                <label className="block text-[11px] text-zinc-400 mb-1 font-medium">{label}</label>
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-[13px] text-zinc-900 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
              </div>
            ))}
            <div className="pt-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-400 mb-3 flex items-center gap-2">
                <div className="h-px flex-1 bg-zinc-100" /><span>Service Address</span><div className="h-px flex-1 bg-zinc-100" />
              </div>
              {[
                { label: 'Street', key: 'address' },
                { label: 'City', key: 'city' },
                { label: 'State', key: 'state' },
                { label: 'ZIP', key: 'zip_code' },
              ].map(({ label, key }) => (
                <div key={key} className="mb-3">
                  <label className="block text-[11px] text-zinc-400 mb-1 font-medium">{label}</label>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-[13px] text-zinc-900 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
                </div>
              ))}
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-400 mb-3 flex items-center gap-2">
                <div className="h-px flex-1 bg-zinc-100" /><span>Billing Address</span><div className="h-px flex-1 bg-zinc-100" />
              </div>
              {[
                { label: 'Street', key: 'billing_address' },
                { label: 'City', key: 'billing_city' },
                { label: 'State', key: 'billing_state' },
                { label: 'ZIP', key: 'billing_zip' },
              ].map(({ label, key }) => (
                <div key={key} className="mb-3">
                  <label className="block text-[11px] text-zinc-400 mb-1 font-medium">{label}</label>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-[13px] text-zinc-900 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20" />
                </div>
              ))}
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1 font-medium">Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-[13px] text-zinc-900 focus:outline-none focus:border-blue-400">
                <option value="lead">Lead</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1 font-medium">Notes</label>
              <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-[13px] text-zinc-900 focus:outline-none focus:border-blue-400 resize-none" />
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
          <div className="p-6 border-t border-zinc-200 flex gap-3">
            {selected && (
              <button onClick={() => deleteClient(selected.id)}
                className="px-4 py-2 text-[13px] text-red-500 hover:text-red-600 border border-red-200 hover:border-red-300 rounded-lg transition-colors font-medium">
                Delete
              </button>
            )}
            <button onClick={save} disabled={saving || (!form.first_name && !form.last_name)}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-[13px] font-medium transition-colors">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
