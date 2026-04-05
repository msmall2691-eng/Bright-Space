import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, X, Calendar, CheckCircle, Send, Mail, MessageSquare, Eye, ChevronDown } from 'lucide-react'

const QUOTE_STATUS_COLORS = {
  draft:    'bg-gray-100 text-gray-600 border-gray-200',
  sent:     'bg-blue-50 text-blue-700 border-blue-200',
  accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  declined: 'bg-red-50 text-red-700 border-red-200',
}

const LEAD_STATUS_COLORS = {
  new:       'bg-amber-50 text-amber-700 border-amber-200',
  reviewed:  'bg-blue-50 text-blue-700 border-blue-200',
  quoted:    'bg-purple-50 text-purple-700 border-purple-200',
  converted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

const SERVICE_TYPES = ['residential', 'commercial', 'str']
const EMPTY_ITEM = { name: '', description: '', qty: 1, unit_price: 0 }

function Toast({ msg }) {
  return (
    <div className="fixed bottom-6 right-6 bg-white border border-gray-200 text-gray-900 text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50">
      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />{msg}
    </div>
  )
}

export default function Quoting() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('leads')
  const [quotes, setQuotes] = useState([])
  const [intakes, setIntakes] = useState([])
  const [clients, setClients] = useState([])
  const [panel, setPanel] = useState(null) // 'quote' | 'send' | null
  const [selected, setSelected] = useState(null)
  const [selectedIntake, setSelectedIntake] = useState(null)
  const [form, setForm] = useState({
    client_id: '', intake_id: null, address: '', service_type: 'residential',
    items: [{ ...EMPTY_ITEM }], tax_rate: 0, notes: '', valid_until: ''
  })
  const [sendForm, setSendForm] = useState({ channel: 'email', email: '', phone: '', custom_message: '' })
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [converting, setConverting] = useState(null)
  const [toast, setToast] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500) }

  const loadQuotes = () => fetch('/api/quotes').then(r => r.json()).then(d => setQuotes(Array.isArray(d) ? d : [])).catch(() => {})
  const loadIntakes = () => fetch('/api/intake').then(r => r.json()).then(d => setIntakes(Array.isArray(d) ? d : [])).catch(() => {})

  useEffect(() => {
    loadQuotes()
    loadIntakes()
    fetch('/api/clients').then(r => r.json()).then(d => setClients(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  const clientFor = (id) => clients.find(c => c.id === id)
  const clientName = (id) => clientFor(id)?.name || `Client #${id}`

  const subtotal = (items) => items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0), 0)
  const taxAmt = (items, rate) => subtotal(items) * (parseFloat(rate) || 0) / 100
  const total = (items, rate) => subtotal(items) + taxAmt(items, rate)

  const updateItem = (i, key, val) => setForm(f => {
    const items = [...f.items]
    items[i] = { ...items[i], [key]: val }
    return { ...f, items }
  })

  const openQuoteForm = (q = null, intake = null) => {
    setSelected(q)
    setSelectedIntake(intake)
    if (q) {
      setForm({ client_id: q.client_id, intake_id: q.intake_id, address: q.address || '',
        service_type: q.service_type || 'residential', items: q.items?.length ? q.items : [{ ...EMPTY_ITEM }],
        tax_rate: q.tax_rate, notes: q.notes || '', valid_until: q.valid_until || '' })
    } else if (intake) {
      setForm({
        client_id: intake.client_id || '', intake_id: intake.id,
        address: [intake.address, intake.city, intake.state].filter(Boolean).join(', '),
        service_type: intake.service_type || 'residential',
        items: [{ ...EMPTY_ITEM }], tax_rate: 0,
        notes: intake.message || '', valid_until: ''
      })
    } else {
      setForm({ client_id: '', intake_id: null, address: '', service_type: 'residential',
        items: [{ ...EMPTY_ITEM }], tax_rate: 0, notes: '', valid_until: '' })
    }
    setPanel('quote')
  }

  const openSendPanel = (q) => {
    const client = clientFor(q.client_id)
    setSendForm({
      channel: client?.email ? 'email' : 'sms',
      email: client?.email || '',
      phone: client?.phone || '',
      custom_message: ''
    })
    setSelected(q)
    setPanel('send')
  }

  const save = async () => {
    if (!form.client_id) return
    setSaving(true)
    try {
      const method = selected ? 'PATCH' : 'POST'
      const url = selected ? `/api/quotes/${selected.id}` : '/api/quotes'
      const body = { ...form, client_id: parseInt(form.client_id), tax_rate: parseFloat(form.tax_rate) || 0 }
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error()
      await loadQuotes(); await loadIntakes()
      setPanel(null)
      showToast(selected ? 'Quote updated' : 'Quote created')
    } catch { showToast('Error saving quote') }
    setSaving(false)
  }

  const sendQuote = async () => {
    if (!selected) return
    setSending(true)
    try {
      const r = await fetch(`/api/quotes/${selected.id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendForm)
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Send failed')
      const channels = Object.entries(data.results || {})
        .filter(([, v]) => v === 'sent').map(([k]) => k)
      showToast(`Quote sent via ${channels.join(' & ')} ✓`)
      await loadQuotes()
      setPanel(null)
    } catch (e) { showToast(e.message || 'Error sending quote') }
    setSending(false)
  }

  const updateStatus = async (id, status) => {
    await fetch(`/api/quotes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    loadQuotes()
  }

  const markIntakeReviewed = async (id) => {
    await fetch(`/api/intake/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }) })
    loadIntakes()
  }

  const convertToJob = async (quoteId) => {
    setConverting(quoteId)
    try {
      const r = await fetch(`/api/quotes/${quoteId}/convert-to-job`, { method: 'POST' })
      if (!r.ok) throw new Error()
      const job = await r.json()
      showToast('Job created — set the date in Scheduling')
      navigate(`/scheduling`)
    } catch { showToast('Error converting to job') }
    setConverting(null)
  }

  // Preview text for send panel
  const previewSMS = () => {
    if (!selected) return ''
    const q = selected
    const st = (q.service_type || 'residential').charAt(0).toUpperCase() + (q.service_type || 'residential').slice(1)
    return `Maine Cleaning Co — Quote ${q.quote_number || `QT-${q.id}`}\n${st} clean${q.address ? ` at ${q.address}` : ''}\nTotal: $${parseFloat(q.total || 0).toFixed(2)}${q.valid_until ? `\nValid until: ${q.valid_until}` : ''}\n\nReply YES to accept or ask any questions.`
  }

  const newLeads = intakes.filter(i => i.status === 'new').length

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col min-w-0 overflow-hidden">

        {/* Tabs + action */}
        <div className="flex justify-between items-center mb-5 shrink-0">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button onClick={() => setTab('leads')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${tab === 'leads' ? 'bg-gray-200 text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}>
              Leads
              {newLeads > 0 && <span className="bg-yellow-500 text-black text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{newLeads}</span>}
            </button>
            <button onClick={() => setTab('quotes')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'quotes' ? 'bg-gray-200 text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}>
              Quotes
            </button>
          </div>
          <button onClick={() => { openQuoteForm(); setTab('quotes') }}
            className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Quote
          </button>
        </div>

        {/* Leads tab */}
        {tab === 'leads' && (
          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
            {intakes.length === 0 && (
              <div className="text-center py-16 text-gray-500">
                <p className="text-sm">No leads yet</p>
                <p className="text-xs mt-1 text-gray-600">Submissions from maineclean.co will appear here</p>
              </div>
            )}
            {intakes.map(intake => (
              <div key={intake.id} className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-medium text-gray-900">{intake.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${LEAD_STATUS_COLORS[intake.status]}`}>{intake.status}</span>
                      <span className="text-xs text-gray-500 capitalize bg-gray-100 px-2 py-0.5 rounded-full">{intake.service_type}</span>
                    </div>
                    <div className="text-xs text-gray-400 space-y-0.5">
                      {(intake.phone || intake.email) && <div>{[intake.phone, intake.email].filter(Boolean).join(' · ')}</div>}
                      {intake.address && <div>{[intake.address, intake.city, intake.state].filter(Boolean).join(', ')}</div>}
                      {intake.preferred_date && <div>Preferred: {intake.preferred_date}</div>}
                      {intake.message && <div className="text-gray-500 italic mt-1 line-clamp-2">"{intake.message}"</div>}
                    </div>
                    <div className="text-xs text-gray-600 mt-1.5">
                      {new Date(intake.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    {intake.status === 'new' && (
                      <button onClick={() => markIntakeReviewed(intake.id)}
                        className="text-xs px-3 py-1.5 bg-gray-200 hover:bg-gray-600 text-gray-600 rounded-lg transition-colors">
                        Mark Reviewed
                      </button>
                    )}
                    {intake.status !== 'converted' && (
                      <button onClick={() => { openQuoteForm(null, intake); setTab('quotes') }}
                        className="text-xs px-3 py-1.5 bg-gray-900 hover:bg-gray-800 text-white text-gray-900 rounded-lg transition-colors flex items-center gap-1">
                        <Plus className="w-3 h-3" /> Create Quote
                      </button>
                    )}
                    {intake.client_id && (
                      <button onClick={() => navigate(`/clients/${intake.client_id}`)}
                        className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-400 rounded-lg transition-colors">
                        View Client
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Quotes tab */}
        {tab === 'quotes' && (
          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
            {quotes.length === 0 && <div className="text-center py-16 text-gray-500 text-sm">No quotes yet</div>}
            {quotes.map(q => (
              <div key={q.id} className="bg-white border border-gray-200 hover:border-gray-200 rounded-xl p-4 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openQuoteForm(q)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">{clientName(q.client_id)}</span>
                      <span className="text-xs text-gray-500">{q.quote_number}</span>
                      <span className={`text-xs px-2.5 py-0.5 rounded-full border capitalize ${QUOTE_STATUS_COLORS[q.status]}`}>{q.status}</span>
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), q.address, `${q.items?.length || 0} items`, new Date(q.created_at).toLocaleDateString()].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="font-semibold text-gray-900 shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
                  <div className="flex gap-1.5 shrink-0">
                    {(q.status === 'draft' || q.status === 'sent') && (
                      <button onClick={() => openSendPanel(q)}
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg transition-colors">
                        <Send className="w-3 h-3" /> Send
                      </button>
                    )}
                    {q.status === 'sent' && (
                      <button onClick={() => updateStatus(q.id, 'accepted')}
                        className="text-xs px-2.5 py-1.5 bg-green-50 text-green-400 hover:bg-green-600/30 rounded-lg transition-colors">
                        Accept
                      </button>
                    )}
                    {q.status === 'sent' && (
                      <button onClick={() => updateStatus(q.id, 'declined')}
                        className="text-xs px-2.5 py-1.5 bg-red-50 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors">
                        Decline
                      </button>
                    )}
                    {q.status === 'accepted' && (
                      <button onClick={() => convertToJob(q.id)} disabled={converting === q.id}
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-200 text-gray-900 rounded-lg transition-colors">
                        <Calendar className="w-3 h-3" />
                        {converting === q.id ? 'Converting…' : 'Schedule Job'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quote edit panel */}
      {panel === 'quote' && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[500px] sm:border-l sm:border-gray-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
            <div>
              <h2 className="font-semibold text-gray-900">{selected ? `Edit ${selected.quote_number}` : 'New Quote'}</h2>
              {selectedIntake && <p className="text-xs text-gray-400 mt-0.5">From: {selectedIntake.name}</p>}
            </div>
            <button onClick={() => setPanel(null)} className="text-gray-500 hover:text-gray-600"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

            {/* Client */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Client *</label>
              <select value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400">
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Service type */}
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Service Type</label>
              <div className="flex gap-2">
                {SERVICE_TYPES.map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, service_type: t }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${form.service_type === t ? 'bg-sky-600 text-gray-900' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>
                    {t === 'str' ? 'STR / Vacation' : t}
                  </button>
                ))}
              </div>
            </div>

            {/* Address */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Service Address</label>
              <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                placeholder="123 Main St, Portland, ME 04101"
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-400">Line Items</label>
                <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                  className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Add item
                </button>
              </div>
              <div className="space-y-2">
                {form.items.map((item, i) => (
                  <div key={i} className="bg-gray-100 rounded-lg p-3 space-y-2">
                    <div className="flex gap-2">
                      <input value={item.name} onChange={e => updateItem(i, 'name', e.target.value)}
                        placeholder="e.g. Standard Home Clean"
                        className="flex-1 bg-gray-200 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-gray-400" />
                      <button onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                        className="text-gray-500 hover:text-red-400 shrink-0"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <input value={item.description} onChange={e => updateItem(i, 'description', e.target.value)}
                      placeholder="Description (optional)"
                      className="w-full bg-gray-200 border border-gray-300 rounded px-2 py-1.5 text-xs text-gray-600 focus:outline-none" />
                    <div className="flex gap-2">
                      <div className="w-20">
                        <label className="text-xs text-gray-500">Qty</label>
                        <input type="number" min="0" step="0.5" value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)}
                          className="w-full bg-gray-200 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-gray-500">Unit Price ($)</label>
                        <input type="number" min="0" step="5" value={item.unit_price} onChange={e => updateItem(i, 'unit_price', e.target.value)}
                          className="w-full bg-gray-200 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1 flex flex-col justify-end">
                        <label className="text-xs text-gray-500">Line Total</label>
                        <div className="text-sm font-semibold text-gray-900 mt-1.5">${((parseFloat(item.qty) || 0) * (parseFloat(item.unit_price) || 0)).toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tax + valid until */}
            <div className="flex gap-3">
              <div className="w-28">
                <label className="block text-xs text-gray-400 mb-1">Tax (%)</label>
                <input type="number" min="0" max="100" value={form.tax_rate} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">Valid Until</label>
                <input type="date" value={form.valid_until} onChange={e => setForm(f => ({ ...f, valid_until: e.target.value }))}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>

            {/* Totals summary */}
            <div className="bg-gray-100 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="flex justify-between text-gray-400">
                <span>Subtotal</span><span>${subtotal(form.items).toFixed(2)}</span>
              </div>
              {parseFloat(form.tax_rate) > 0 && (
                <div className="flex justify-between text-gray-400">
                  <span>Tax ({form.tax_rate}%)</span><span>${taxAmt(form.items, form.tax_rate).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-gray-900 text-base border-t border-gray-200 pt-2">
                <span>Total</span><span>${total(form.items, form.tax_rate).toFixed(2)}</span>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Notes / Scope</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                placeholder="Special instructions, inclusions/exclusions, access details..."
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>
          </div>

          <div className="p-6 border-t border-gray-200 flex gap-3 shrink-0">
            <button onClick={save} disabled={saving || !form.client_id}
              className="flex-1 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving...' : selected ? 'Update Quote' : 'Create Quote'}
            </button>
            {selected && (
              <button onClick={() => openSendPanel(selected)}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
                <Send className="w-4 h-4" /> Send
              </button>
            )}
          </div>
        </div>
      )}

      {/* Send quote panel */}
      {panel === 'send' && selected && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[460px] sm:border-l sm:border-gray-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
            <div>
              <h2 className="font-semibold text-gray-900">Send Quote</h2>
              <p className="text-xs text-gray-400 mt-0.5">{selected.quote_number} · {clientName(selected.client_id)} · ${parseFloat(selected.total || 0).toFixed(2)}</p>
            </div>
            <button onClick={() => setPanel(null)} className="text-gray-500 hover:text-gray-600"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

            {/* Channel selector */}
            <div>
              <label className="block text-xs text-gray-400 mb-2">Send via</label>
              <div className="flex gap-2">
                {[
                  { id: 'email', label: 'Email', icon: Mail },
                  { id: 'sms', label: 'SMS', icon: MessageSquare },
                  { id: 'both', label: 'Both', icon: Send },
                ].map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => setSendForm(f => ({ ...f, channel: id }))}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${sendForm.channel === id ? 'bg-sky-600 text-gray-900' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>
                    <Icon className="w-3.5 h-3.5" />{label}
                  </button>
                ))}
              </div>
            </div>

            {/* Email address */}
            {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Email Address</label>
                <input type="email" value={sendForm.email} onChange={e => setSendForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@example.com"
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
              </div>
            )}

            {/* Phone */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Phone Number</label>
                <input type="tel" value={sendForm.phone} onChange={e => setSendForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+12075551234"
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
              </div>
            )}

            {/* SMS preview */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <button onClick={() => setPreviewOpen(p => !p)}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 mb-2">
                  <Eye className="w-3.5 h-3.5" /> Preview SMS <ChevronDown className={`w-3 h-3 transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
                </button>
                {previewOpen && (
                  <div className="bg-gray-100 rounded-lg p-3 text-xs text-gray-600 whitespace-pre-wrap font-mono border border-gray-200">
                    {previewSMS()}
                  </div>
                )}
              </div>
            )}

            {/* Email preview info */}
            {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
              <div className="bg-blue-900/20 border border-blue-800/40 rounded-lg p-3">
                <div className="text-xs text-blue-300 font-medium mb-1">Email includes:</div>
                <ul className="text-xs text-blue-400 space-y-0.5">
                  <li>• Branded quote with all line items and totals</li>
                  <li>• Service address and type</li>
                  <li>• Valid until date</li>
                  <li>• Reply-to-accept instructions</li>
                </ul>
              </div>
            )}

            {/* Custom intro message */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Personal note (optional)</label>
              <textarea value={sendForm.custom_message} onChange={e => setSendForm(f => ({ ...f, custom_message: e.target.value }))}
                rows={3} placeholder="Hi! Great talking with you — here's the quote we discussed..."
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
              <p className="text-xs text-gray-600 mt-1">Prepended to SMS. Not included in email (reply to the email thread instead).</p>
            </div>

            {/* Quote summary */}
            <div className="bg-gray-100 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="text-xs text-gray-500 mb-2">Quote summary</div>
              {(selected.items || []).map((item, i) => (
                <div key={i} className="flex justify-between text-gray-600">
                  <span>{item.name} {parseFloat(item.qty) !== 1 ? `×${item.qty}` : ''}</span>
                  <span>${(parseFloat(item.qty || 1) * parseFloat(item.unit_price || 0)).toFixed(2)}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold text-gray-900 border-t border-gray-200 pt-2 mt-1">
                <span>Total</span><span>${parseFloat(selected.total || 0).toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="p-6 border-t border-gray-200 shrink-0">
            <button onClick={sendQuote} disabled={sending || (!sendForm.email && !sendForm.phone)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              <Send className="w-4 h-4" />
              {sending ? 'Sending...' : `Send via ${sendForm.channel === 'both' ? 'Email & SMS' : sendForm.channel === 'email' ? 'Email' : 'SMS'}`}
            </button>
          </div>
        </div>
      )}

      {toast && <Toast msg={toast} />}
    </div>
  )
}
