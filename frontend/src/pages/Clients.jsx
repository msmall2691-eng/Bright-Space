import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, Phone, Mail, MapPin, ChevronRight, X, Upload } from 'lucide-react'
import { CustomFieldsForm } from '../components/CustomFields'
import { del, get } from "../api"


const STATUS_COLORS = {
  lead:     'bg-amber-50 text-amber-700 border-amber-200',
  active:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  inactive: 'bg-gray-100 text-gray-600 border-gray-200',
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
  const fileInputRef = useRef(null)

  const load = () =>
    get(`/api/clients${statusFilter ? `?status=${statusFilter}` : ''}`).then(setClients).catch(err => console.error("[Clients]", err))

  useEffect(() => { load() }, [statusFilter])

  const filtered = clients.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.phone || '').includes(search) || (c.email || '').toLowerCase().includes(search.toLowerCase())
  )

  const save = async () => {
    setSaving(true)
    setSaveError('')
    try {
      const method = selected ? 'PATCH' : 'POST'
      const url = selected ? `/api/clients/${selected.id}` : '/api/clients'
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error(err.detail || `Server error ${r.status}`)
      }
      await load()
      setShowForm(false)
      setSelected(null)
      setForm(EMPTY)
    } catch (e) {
      setSaveError(e.message || 'Failed to save. Is the backend running?')
    }
    setSaving(false)
  }

  const openNew = () => { setForm(EMPTY); setSelected(null); setShowForm(true) }
  const openEdit = (c) => { setForm({ ...c }); setSelected(c); setShowForm(true) }

  const handleImport = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setImporting(true)
    setImportResult(null)
    const fd = new FormData()
    fd.append('file', f)
    try {
      const r = await fetch('/api/clients/import-xlsx', { method: 'POST', body: fd })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Import failed')
      setImportResult(data)
      await load()
    } catch (err) {
      setImportResult({ error: err.message })
    }
    setImporting(false)
    e.target.value = ''
  }

  const deleteClient = async (id) => {
    if (!confirm('Delete this client?')) return
    await del(`/api/clients/${id}`)
    await load()
    setShowForm(false)
  }

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="flex-1 flex flex-col p-4 sm:p-6 min-w-0">
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients..."
              className="w-full bg-white border border-gray-200 rounded-lg pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-gray-400" />
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
            <option value="">All</option>
            <option value="lead">Leads</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleImport} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            title="Import clients from Excel (.xlsx)"
            className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50 px-3 py-2 rounded-lg text-sm font-medium transition-colors border border-gray-200"
          >
            <Upload className="w-4 h-4" /> <span className="hidden sm:inline">{importing ? 'Importing…' : 'Import'}</span>
          </button>
          <button onClick={openNew} className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> <span className="hidden sm:inline">New Client</span>
          </button>
        </div>

        {importResult && (
          <div className={`mb-3 px-3 py-2 rounded-lg text-xs border flex items-center justify-between ${
            importResult.error
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : 'bg-green-500/10 border-green-500/30 text-green-400'
          }`}>
            <span>
              {importResult.error
                ? `Import failed: ${importResult.error}`
                : `Imported ${importResult.added} clients${importResult.skipped ? `, skipped ${importResult.skipped} duplicates` : ''}`
              }
            </span>
            <button onClick={() => setImportResult(null)} className="ml-3 opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
          </div>
        )}
        <div className="text-xs text-gray-500 mb-3">{filtered.length} client{filtered.length !== 1 ? 's' : ''}</div>

        <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
          {filtered.map(c => (
            <div key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
              className="flex items-center gap-4 bg-white border border-gray-200 hover:border-gray-300 hover:shadow-sm rounded-xl p-4 cursor-pointer transition-all">
              <div className="w-10 h-10 rounded-full bg-sky-50 flex items-center justify-center shrink-0">
                <span className="text-sky-400 font-semibold text-sm">{c.name[0]?.toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900">{c.name}</div>
                <div className="flex items-center gap-3 mt-0.5">
                  {c.phone && <span className="text-xs text-gray-400 flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>}
                  {c.email && <span className="text-xs text-gray-400 flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</span>}
                  {c.city && <span className="text-xs text-gray-400 flex items-center gap-1"><MapPin className="w-3 h-3" />{c.city}</span>}
                </div>
              </div>
              <span className={`text-xs px-2.5 py-1 rounded-full border capitalize ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
              <ChevronRight className="w-4 h-4 text-gray-600" />
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-16 text-gray-500">No clients found</div>
          )}
        </div>
      </div>

      {/* Form panel */}
      {showForm && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-gray-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h2 className="font-semibold text-gray-900">{selected ? 'Edit Client' : 'New Client'}</h2>
            <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 scrollbar-thin space-y-4">
            {/* Name */}
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">First Name *</label>
                <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">Last Name</label>
                <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
              </div>
            </div>
            {[
              { label: 'Phone', key: 'phone' },
              { label: 'Email', key: 'email' },
              { label: 'Source', key: 'source' },
            ].map(({ label, key }) => (
              <div key={key}>
                <label className="block text-xs text-gray-400 mb-1">{label}</label>
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
              </div>
            ))}
            {/* Service address */}
            <div className="pt-1">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2">
                <div className="h-px flex-1 bg-gray-100" /><span>Service Address</span><div className="h-px flex-1 bg-gray-100" />
              </div>
              {[
                { label: 'Street', key: 'address' },
                { label: 'City', key: 'city' },
                { label: 'State', key: 'state' },
                { label: 'ZIP', key: 'zip_code' },
              ].map(({ label, key }) => (
                <div key={key} className="mb-3">
                  <label className="block text-xs text-gray-400 mb-1">{label}</label>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
                </div>
              ))}
            </div>
            {/* Billing address */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2">
                <div className="h-px flex-1 bg-gray-100" /><span>Billing Address</span><div className="h-px flex-1 bg-gray-100" />
              </div>
              {[
                { label: 'Street', key: 'billing_address' },
                { label: 'City', key: 'billing_city' },
                { label: 'State', key: 'billing_state' },
                { label: 'ZIP', key: 'billing_zip' },
              ].map(({ label, key }) => (
                <div key={key} className="mb-3">
                  <label className="block text-xs text-gray-400 mb-1">{label}</label>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
                </div>
              ))}
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
                <option value="lead">Lead</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Notes</label>
              <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400 resize-none" />
            </div>
            <CustomFieldsForm
              entityType="client"
              values={form.custom_fields || {}}
              onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
            />
          </div>
          {saveError && (
            <div className="mx-6 mb-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {saveError}
            </div>
          )}
          <div className="p-6 border-t border-gray-200 flex gap-3">
            {selected && (
              <button onClick={() => deleteClient(selected.id)}
                className="px-4 py-2 text-sm text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 rounded-lg transition-colors">
                Delete
              </button>
            )}
            <button onClick={save} disabled={saving || (!form.first_name && !form.last_name)}
              className="flex-1 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
