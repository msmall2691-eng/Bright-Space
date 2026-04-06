import { useState, useEffect, useCallback } from 'react'
import { CustomFieldsForm } from '../components/CustomFields'
import { Plus, Trash2, X, CheckCircle, Send, Mail, MessageSquare, Search, AlertTriangle, ChevronRight, FileText } from 'lucide-react'

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS = {
  draft:   { dot: 'bg-gray-400',    text: 'text-gray-400',    label: 'Draft'   },
  sent:    { dot: 'bg-blue-400',    text: 'text-blue-400',    label: 'Sent'    },
  paid:    { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Paid'    },
  overdue: { dot: 'bg-red-400',     text: 'text-red-400',     label: 'Overdue' },
}

// ── Client avatar ─────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  'bg-violet-500/20 text-violet-300',
  'bg-sky-500/20 text-sky-300',
  'bg-emerald-500/20 text-emerald-300',
  'bg-orange-500/20 text-orange-300',
  'bg-pink-500/20 text-pink-300',
  'bg-yellow-500/20 text-yellow-300',
]
function avatar(name = '') {
  const i = name.charCodeAt(0) % AVATAR_COLORS.length
  return { color: AVATAR_COLORS[i], initials: name.slice(0, 2).toUpperCase() }
}

const EMPTY_ITEM = { name: '', description: '', qty: 1, unit_price: 0 }

// ── Shared input styles ───────────────────────────────────────────────────────
const inp = 'w-full bg-transparent border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-600 focus:outline-none focus:border-white/25 transition-colors'
const lbl = 'block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5'

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ toasts }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium shadow-2xl border pointer-events-auto
            ${t.type === 'success'
              ? 'bg-[#18261f] border-emerald-800/60 text-emerald-300'
              : t.type === 'error'
              ? 'bg-[#261818] border-red-800/60 text-red-300'
              : 'bg-[#1c1c1c] border-white/10 text-gray-200'}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0
            ${t.type === 'success' ? 'bg-emerald-400' : t.type === 'error' ? 'bg-red-400' : 'bg-gray-400'}`} />
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Invoicing() {
  const [invoices, setInvoices]   = useState([])
  const [clients, setClients]     = useState([])
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch]       = useState('')
  const [panel, setPanel]         = useState(null)   // null | 'edit' | 'send'
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState({ client_id: '', items: [{ ...EMPTY_ITEM }], tax_rate: 0, due_date: '', notes: '', custom_fields: {} })
  const [sendForm, setSendForm]   = useState({ channel: 'email', email: '', phone: '', custom_message: '' })
  const [saving, setSaving]       = useState(false)
  const [sending, setSending]     = useState(false)
  const [deleting, setDeleting]   = useState(false)
  const [toasts, setToasts]       = useState([])

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
  }, [])

  const load = useCallback(() =>
    fetch(`/api/invoices${statusFilter ? `?status=${statusFilter}` : ''}`)
      .then(r => r.json()).then(setInvoices).catch(() => {}),
    [statusFilter]
  )

  useEffect(() => { load() }, [load])
  useEffect(() => { fetch('/api/clients').then(r => r.json()).then(setClients).catch(() => {}) }, [])

  const clientName = (id) => clients.find(c => c.id === id)?.name || `Client #${id}`
  const clientOf   = (id) => clients.find(c => c.id === id)
  const sub        = (items) => items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)
  const totalAmt   = (items, tax) => sub(items) * (1 + (parseFloat(tax) || 0) / 100)

  const daysOverdue = (inv) => {
    if (!inv.due_date || inv.status === 'paid') return null
    const diff = Math.floor((Date.now() - new Date(inv.due_date)) / 86400000)
    return diff > 0 ? diff : null
  }

  const updateItem = (i, key, val) => setForm(f => {
    const items = [...f.items]; items[i] = { ...items[i], [key]: val }; return { ...f, items }
  })

  const save = async () => {
    setSaving(true)
    try {
      const method = selected ? 'PATCH' : 'POST'
      const url    = selected ? `/api/invoices/${selected.id}` : '/api/invoices'
      const body   = { ...form, client_id: parseInt(form.client_id), tax_rate: parseFloat(form.tax_rate) || 0 }
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error()
      await load(); toast(selected ? 'Invoice updated' : 'Invoice created'); setPanel(null)
    } catch { toast('Failed to save invoice', 'error') }
    setSaving(false)
  }

  const markPaid = async (id) => {
    await fetch(`/api/invoices/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid_at: new Date().toISOString() }) })
    await load(); toast('Marked as paid')
    if (selected?.id === id) setPanel(null)
  }

  const markOverdue = async (id) => {
    await fetch(`/api/invoices/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'overdue' }) })
    await load(); toast('Marked as overdue')
  }

  const deleteInvoice = async () => {
    if (!selected) return; setDeleting(true)
    try {
      const r = await fetch(`/api/invoices/${selected.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error()
      await load(); setPanel(null); toast('Invoice deleted')
    } catch { toast('Failed to delete invoice', 'error') }
    setDeleting(false)
  }

  const sendInvoice = async () => {
    if (!selected) return; setSending(true)
    try {
      const r = await fetch(`/api/invoices/${selected.id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sendForm) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Send failed')
      await load()
      const parts = Object.entries(data.results || {}).map(([ch, res]) => `${ch}: ${res}`).join(', ')
      toast(`Invoice sent — ${parts}`); setPanel(null)
    } catch (e) { toast(e.message || 'Failed to send invoice', 'error') }
    setSending(false)
  }

  const openEdit = (inv) => {
    setSelected(inv)
    setForm({ client_id: inv.client_id, items: inv.items, tax_rate: inv.tax_rate, due_date: inv.due_date || '', notes: inv.notes || '', custom_fields: inv.custom_fields || {} })
    setPanel('edit')
  }

  const openSend = (inv) => {
    setSelected(inv)
    const c = clientOf(inv.client_id)
    setSendForm({ channel: 'email', email: c?.email || '', phone: c?.phone || '', custom_message: '' })
    setPanel('send')
  }

  const openNew = () => {
    setSelected(null)
    setForm({ client_id: '', items: [{ ...EMPTY_ITEM }], tax_rate: 0, due_date: '', notes: '', custom_fields: {} })
    setPanel('edit')
  }

  const closePanel = () => { setPanel(null); setSelected(null) }

  const filtered = invoices.filter(inv => {
    if (!search) return true
    const name = clientName(inv.client_id).toLowerCase()
    return name.includes(search.toLowerCase()) || inv.invoice_number.toLowerCase().includes(search.toLowerCase())
  })

  const totalRevenue = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total || 0), 0)
  const outstanding  = invoices.filter(i => ['sent','overdue'].includes(i.status)).reduce((s, i) => s + (i.total || 0), 0)
  const overdueCount = invoices.filter(i => i.status === 'overdue').length

  return (
    <div className="flex h-full bg-gray-50">

      {/* ── Main column ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Page header */}
        <div className="flex items-center justify-between px-4 sm:px-8 pt-7 pb-5">
          <div>
            <h1 className="text-[15px] font-semibold text-gray-900 tracking-tight">Invoices</h1>
            <p className="text-xs text-gray-500 mt-0.5">{invoices.length} total</p>
          </div>
          <button onClick={openNew}
            className="flex items-center gap-2 bg-white text-gray-950 hover:bg-gray-100 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors">
            <Plus className="w-3.5 h-3.5" /> New invoice
          </button>
        </div>

        {/* Metrics bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 mx-4 sm:mx-8 mb-6 rounded-xl border border-white/[0.06] overflow-hidden bg-white">
          {[
            { label: 'Paid',        value: `$${totalRevenue.toFixed(2)}`, accent: 'text-emerald-400' },
            { label: 'Outstanding', value: `$${outstanding.toFixed(2)}`,  accent: 'text-amber-400'   },
            { label: 'Invoices',    value: invoices.length,               accent: 'text-gray-900'        },
            { label: 'Overdue',     value: overdueCount,                  accent: overdueCount > 0 ? 'text-red-400' : 'text-gray-600' },
          ].map((m, idx, arr) => (
            <div key={m.label}
              className={`flex-1 px-5 py-4 ${idx < arr.length - 1 ? 'border-r border-white/[0.06]' : ''}`}>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">{m.label}</div>
              <div className={`text-lg font-semibold ${m.accent}`}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 px-4 sm:px-8 mb-4">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              className="bg-white border border-white/[0.06] text-sm text-gray-900 placeholder-gray-600 rounded-lg pl-8 pr-3 py-1.5 focus:outline-none focus:border-white/20 w-44 transition-colors" />
          </div>

          <div className="flex items-center gap-1 bg-white border border-white/[0.06] rounded-lg p-1 overflow-x-auto">
            {['', 'draft', 'sent', 'paid', 'overdue'].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                  ${statusFilter === s ? 'bg-gray-100 text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 sm:px-8 pb-6">
          {/* Column headers */}
          <div className="hidden sm:grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-4 px-3 mb-2">
            {['Client', 'Amount', 'Due', 'Status', ''].map(h => (
              <div key={h} className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{h}</div>
            ))}
          </div>

          <div className="rounded-xl border border-white/[0.06] overflow-hidden bg-white">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center mb-3">
                  <FileText className="w-5 h-5 text-gray-600" />
                </div>
                <p className="text-sm text-gray-500">{search ? 'No matching invoices' : 'No invoices yet'}</p>
                {!search && <button onClick={openNew} className="mt-3 text-xs text-sky-400 hover:text-sky-300">Create one →</button>}
              </div>
            ) : filtered.map((inv, idx) => {
              const st = STATUS[inv.status] || STATUS.draft
              const av = avatar(clientName(inv.client_id))
              const days = daysOverdue(inv)

              return (
                <div key={inv.id}
                  className={`group flex flex-wrap sm:grid sm:grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 sm:gap-4 items-center px-4 py-3.5 cursor-pointer
                    hover:bg-white/[0.03] transition-colors
                    ${idx < filtered.length - 1 ? 'border-b border-white/[0.04]' : ''}
                    ${selected?.id === inv.id ? 'bg-white/[0.04]' : ''}`}
                  onClick={() => openEdit(inv)}>

                  {/* Client */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0 ${av.color}`}>
                      {av.initials}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm text-gray-900 truncate">{clientName(inv.client_id)}</div>
                      <div className="text-[11px] text-gray-600">{inv.invoice_number}</div>
                    </div>
                  </div>

                  {/* Amount */}
                  <div className="text-sm font-medium text-gray-900">${inv.total?.toFixed(2)}</div>

                  {/* Due date */}
                  <div>
                    {days ? (
                      <span className="flex items-center gap-1 text-[11px] text-red-400">
                        <AlertTriangle className="w-3 h-3" />{days}d overdue
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500">{inv.due_date || '—'}</span>
                    )}
                  </div>

                  {/* Status */}
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                    <span className={`text-xs ${st.text}`}>{st.label}</span>
                  </div>

                  {/* Row actions — visible on hover */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={e => e.stopPropagation()}>
                    {inv.status !== 'paid' && (
                      <button onClick={() => openSend(inv)}
                        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white/[0.06] text-gray-600 hover:bg-white/10 transition-colors">
                        <Send className="w-3 h-3" /> Send
                      </button>
                    )}
                    {inv.status !== 'paid' && inv.status !== 'overdue' && days && (
                      <button onClick={() => markOverdue(inv.id)}
                        className="text-[11px] px-2 py-1 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
                        Mark overdue
                      </button>
                    )}
                    {inv.status !== 'paid' && (
                      <button onClick={() => markPaid(inv.id)}
                        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
                        <CheckCircle className="w-3 h-3" /> Paid
                      </button>
                    )}
                    <ChevronRight className="w-3.5 h-3.5 text-gray-600 ml-1" />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Side panel — Edit ───────────────────────────────────── */}
      {panel === 'edit' && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[420px] sm:shrink-0 sm:border-l sm:border-white/[0.06]">

          {/* Panel header */}
          <div className="flex items-start justify-between px-6 py-5 border-b border-white/[0.06]">
            <div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-white/[0.06] flex items-center justify-center">
                  <FileText className="w-3.5 h-3.5 text-gray-400" />
                </div>
                <span className="text-sm font-semibold text-gray-900">
                  {selected ? selected.invoice_number : 'New invoice'}
                </span>
              </div>
              {selected && <p className="text-xs text-gray-500 mt-1 ml-8">{clientName(selected.client_id)}</p>}
            </div>
            <div className="flex items-center gap-1.5">
              {selected && selected.status !== 'paid' && (
                <button onClick={() => openSend(selected)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-white/[0.06] text-gray-600 hover:bg-white/10 transition-colors">
                  <Send className="w-3 h-3" /> Send
                </button>
              )}
              <button onClick={closePanel}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-600 hover:text-gray-600 hover:bg-white/[0.06] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Form body */}
          <div className="flex-1 overflow-y-auto scrollbar-thin p-6 space-y-6">

            {/* Client */}
            <div>
              <label className={lbl}>Client</label>
              <select value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}
                className={inp + ' bg-gray-50'}>
                <option value="">Select a client…</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className={lbl.replace('mb-1.5', '')}>Line Items</label>
                <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                  className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 transition-colors">
                  <Plus className="w-3 h-3" /> Add line
                </button>
              </div>
              <div className="space-y-2">
                {form.items.map((item, i) => (
                  <div key={i} className="rounded-lg border border-white/[0.06] bg-gray-50 p-3 space-y-2">
                    <div className="flex gap-2 items-center">
                      <input value={item.name} onChange={e => updateItem(i, 'name', e.target.value)}
                        placeholder="Description"
                        className="flex-1 bg-transparent border-none text-sm text-gray-900 placeholder-gray-600 focus:outline-none" />
                      <button onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                        className="text-gray-700 hover:text-red-400 transition-colors shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex gap-2 items-center border-t border-white/[0.04] pt-2">
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-600 w-6">Qty</span>
                        <input type="number" value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)}
                          className="w-14 bg-transparent text-xs text-gray-600 focus:outline-none text-center border border-white/[0.06] rounded px-1 py-0.5" />
                      </div>
                      <span className="text-gray-700">×</span>
                      <div className="flex items-center gap-1 flex-1">
                        <span className="text-[10px] text-gray-600">$</span>
                        <input type="number" value={item.unit_price} onChange={e => updateItem(i, 'unit_price', e.target.value)}
                          className="flex-1 bg-transparent text-xs text-gray-600 focus:outline-none border border-white/[0.06] rounded px-2 py-0.5" />
                      </div>
                      <span className="text-xs font-medium text-gray-900 w-16 text-right">
                        ${((parseFloat(item.qty) || 0) * (parseFloat(item.unit_price) || 0)).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tax + due date */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Tax %</label>
                <input type="number" value={form.tax_rate} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}
                  className={inp + ' bg-gray-50'} />
              </div>
              <div>
                <label className={lbl}>Due Date</label>
                <input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                  className={inp + ' bg-gray-50'} />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className={lbl}>Notes</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={3} placeholder="Payment instructions, bank details…"
                className={inp + ' bg-gray-50 resize-none'} />
            </div>


            <CustomFieldsForm
              entityType="invoice"
              values={form.custom_fields || {}}
              onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
            />

            {/* Totals */}
            <div className="rounded-xl border border-white/[0.06] bg-gray-50 overflow-hidden">
              <div className="flex justify-between px-4 py-2.5 border-b border-white/[0.04]">
                <span className="text-xs text-gray-500">Subtotal</span>
                <span className="text-xs text-gray-400">${sub(form.items).toFixed(2)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5 border-b border-white/[0.04]">
                <span className="text-xs text-gray-500">Tax ({form.tax_rate || 0}%)</span>
                <span className="text-xs text-gray-400">${(sub(form.items) * (parseFloat(form.tax_rate) || 0) / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between px-4 py-3">
                <span className="text-sm font-semibold text-gray-900">Total</span>
                <span className="text-sm font-semibold text-gray-900">${totalAmt(form.items, form.tax_rate).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Panel footer */}
          <div className="p-5 border-t border-white/[0.06] space-y-2">
            <button onClick={save} disabled={saving || !form.client_id}
              className="w-full bg-white text-gray-950 hover:bg-gray-100 disabled:bg-white/10 disabled:text-gray-600 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
              {saving ? 'Saving…' : (selected ? 'Update invoice' : 'Create invoice')}
            </button>
            {selected && (
              <button onClick={deleteInvoice} disabled={deleting}
                className="w-full flex items-center justify-center gap-2 text-red-500/70 hover:text-red-400 hover:bg-red-500/[0.08] px-4 py-2 rounded-lg text-xs transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
                {deleting ? 'Deleting…' : 'Delete invoice'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Side panel — Send ───────────────────────────────────── */}
      {panel === 'send' && selected && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[380px] sm:shrink-0 sm:border-l sm:border-white/[0.06]">

          <div className="flex items-start justify-between px-6 py-5 border-b border-white/[0.06]">
            <div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-white/[0.06] flex items-center justify-center">
                  <Send className="w-3 h-3 text-gray-400" />
                </div>
                <span className="text-sm font-semibold text-gray-900">Send invoice</span>
              </div>
              <p className="text-xs text-gray-500 mt-1 ml-8">
                {selected.invoice_number} · ${selected.total?.toFixed(2)}
              </p>
            </div>
            <button onClick={closePanel}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-600 hover:text-gray-600 hover:bg-white/[0.06] transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 p-6 space-y-6">

            {/* Channel selector */}
            <div>
              <label className={lbl}>Deliver via</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { val: 'email', icon: Mail,          label: 'Email' },
                  { val: 'sms',   icon: MessageSquare, label: 'SMS'   },
                  { val: 'both',  icon: Send,          label: 'Both'  },
                ].map(opt => (
                  <button key={opt.val} onClick={() => setSendForm(f => ({ ...f, channel: opt.val }))}
                    className={`flex flex-col items-center gap-2 py-3.5 rounded-xl border text-xs font-medium transition-colors
                      ${sendForm.channel === opt.val
                        ? 'bg-white/[0.08] border-white/20 text-gray-900'
                        : 'bg-gray-50 border-white/[0.06] text-gray-500 hover:border-white/10 hover:text-gray-400'}`}>
                    <opt.icon className="w-4 h-4" />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {sendForm.channel !== 'sms' && (
              <div>
                <label className={lbl}>Email address</label>
                <input value={sendForm.email} onChange={e => setSendForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@email.com"
                  className={inp + ' bg-gray-50'} />
              </div>
            )}

            {sendForm.channel !== 'email' && (
              <div>
                <label className={lbl}>Phone number</label>
                <input value={sendForm.phone} onChange={e => setSendForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+1 (207) 555-0100"
                  className={inp + ' bg-gray-50'} />
              </div>
            )}

            {sendForm.channel !== 'email' && (
              <div>
                <label className={lbl}>Custom message <span className="normal-case text-gray-600 font-normal">(optional)</span></label>
                <textarea value={sendForm.custom_message} onChange={e => setSendForm(f => ({ ...f, custom_message: e.target.value }))}
                  rows={3} placeholder="Prepended to the SMS…"
                  className={inp + ' bg-gray-50 resize-none'} />
              </div>
            )}

            {/* Preview card */}
            <div className="rounded-xl border border-white/[0.06] bg-gray-50 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-600 mb-3">Invoice</div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-900">{selected.invoice_number}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{clientName(selected.client_id)}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-gray-900">${selected.total?.toFixed(2)}</div>
                  {selected.due_date && <div className="text-[11px] text-gray-500 mt-0.5">Due {selected.due_date}</div>}
                </div>
              </div>
            </div>
          </div>

          <div className="p-5 border-t border-white/[0.06]">
            <button onClick={sendInvoice} disabled={sending}
              className="w-full flex items-center justify-center gap-2 bg-white text-gray-950 hover:bg-gray-100 disabled:bg-white/10 disabled:text-gray-600 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors">
              <Send className="w-3.5 h-3.5" />
              {sending ? 'Sending…' : `Send via ${sendForm.channel === 'both' ? 'Email & SMS' : sendForm.channel === 'email' ? 'Email' : 'SMS'}`}
            </button>
          </div>
        </div>
      )}

      <Toast toasts={toasts} />
    </div>
  )
}
