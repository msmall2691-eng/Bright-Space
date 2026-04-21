import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, X, Calendar, CheckCircle, Send, Mail, MessageSquare, Eye, ChevronDown, Copy, Check } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get, post, patch } from "../api"


const QUOTE_STATUS_COLORS = {
  draft:    'bg-zinc-100 text-zinc-500 border-zinc-200',
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
    <div className="fixed bottom-6 right-6 bg-white border border-zinc-200 text-zinc-900 text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50">
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
  const [copiedQuoteId, setCopiedQuoteId] = useState(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500) }

  const loadQuotes = () => get('/api/quotes').then(d => setQuotes(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))
  const loadIntakes = () => get('/api/intake').then(d => setIntakes(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))

  useEffect(() => {
    loadQuotes()
    loadIntakes()
    get('/api/clients').then(d => setClients(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))
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
      const body = { ...form, client_id: parseInt(form.client_id), tax_rate: parseFloat(form.tax_rate) || 0 }
      if (selected) {
        await patch(`/api/quotes/${selected.id}`, body)
      } else {
        await post('/api/quotes', body)
      }
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
      await post(`/api/quotes/${selected.id}/generate-token`, {})
      const data = await post(`/api/quotes/${selected.id}/send`, sendForm)
      const channels = Object.entries(data.results || {})
        .filter(([, v]) => v === 'sent').map(([k]) => k)
      showToast(`Quote sent via ${channels.join(' & ')} ✓`)
      await loadQuotes()
      setPanel(null)
    } catch (e) { showToast(e.message || 'Error sending quote') }
    setSending(false)
  }

  const updateStatus = async (id, status) => {
    await patch(`/api/quotes/${id}`, { status })
    loadQuotes()
  }

  const markIntakeReviewed = async (id) => {
    await patch(`/api/intake/${id}`, { status: 'reviewed' })
    loadIntakes()
  }

  const convertToJob = async (quoteId) => {
    setConverting(quoteId)
    try {
      const job = await post(`/api/quotes/${quoteId}/convert-to-job`)
      showToast('Job created — set the date in Scheduling')
      navigate(`/scheduling`)
    } catch { showToast('Error converting to job') }
    setConverting(null)
  }

  const copyPublicLink = async (quote) => {
    if (!quote.public_token) {
      try {
        const token = await post(`/api/quotes/${quote.id}/generate-token`, {})
        quote = { ...quote, public_token: token.public_token }
      } catch (e) {
        showToast('Error generating link')
        return
      }
    }
    const appUrl = window.location.origin
    const link = `${appUrl}/quote/${quote.public_token}`
    await navigator.clipboard.writeText(link)
    setCopiedQuoteId(quote.id)
    showToast('Link copied!')
    setTimeout(() => setCopiedQuoteId(null), 2000)
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
          <div className="flex items-center gap-1 bg-zinc-100 rounded-lg p-1">
            <button onClick={() => setTab('leads')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${tab === 'leads' ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-400 hover:text-zinc-500'}`}>
              Leads
              {newLeads > 0 && <span className="bg-yellow-500 text-black text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{newLeads}</span>}
            </button>
            <button onClick={() => setTab('quotes')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'quotes' ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-400 hover:text-zinc-500'}`}>
              Quotes
            </button>
          </div>
          <button onClick={() => { openQuoteForm(); setTab('quotes') }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Quote
          </button>
        </div>

        {/* Leads tab */}
        {tab === 'leads' && (
          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-thin">
            {intakes.length === 0 && (
              <div className="text-center py-16 text-zinc-500">
                <p className="text-sm">No leads yet</p>
                <p className="text-xs mt-1 text-zinc-500">Submissions from maineclean.co will appear here</p>
              </div>
            )}
            {intakes.map(intake => (
              <div key={intake.id} className="bg-white border border-zinc-200 rounded-xl p-4">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-medium text-zinc-900">{intake.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${LEAD_STATUS_COLORS[intake.status]}`}>{intake.status}</span>
                      <span className="text-xs text-zinc-500 capitalize bg-zinc-100 px-2 py-0.5 rounded-full">{intake.service_type}</span>
                    </div>
                    <div className="text-xs text-zinc-400 space-y-0.5">
                      {(intake.phone || intake.email) && <div>{[intake.phone, intake.email].filter(Boolean).join(' · ')}</div>}
                      {intake.address && <div>{[intake.address, intake.city, intake.state].filter(Boolean).join(', ')}</div>}
                      {intake.preferred_date && <div>Preferred: {intake.preferred_date}</div>}
                      {intake.message && <div className="text-zinc-500 italic mt-1 line-clamp-2">"{intake.message}"</div>}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1.5">
                      {new Date(intake.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    {intake.status === 'new' && (
                      <button onClick={() => markIntakeReviewed(intake.id)}
                        className="text-xs px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-600 rounded-lg transition-colors border border-zinc-200">
                        Mark Reviewed
                      </button>
                    )}
                    {intake.status !== 'converted' && (
                      <button onClick={() => { openQuoteForm(null, intake); setTab('quotes') }}
                        className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-1">
                        <Plus className="w-3 h-3" /> Create Quote
                      </button>
                    )}
                    {intake.client_id && (
                      <button onClick={() => navigate(`/clients/${intake.client_id}`)}
                        className="text-xs px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-400 rounded-lg transition-colors">
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
            {quotes.length === 0 && <div className="text-center py-16 text-zinc-500 text-sm">No quotes yet</div>}
            {quotes.map(q => (
              <div key={q.id} className="bg-white border border-zinc-200 hover:border-zinc-300 rounded-xl p-4 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openQuoteForm(q)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-900">{clientName(q.client_id)}</span>
                      <span className="text-xs text-zinc-500">{q.quote_number}</span>
                      <span className={`text-xs px-2.5 py-0.5 rounded-full border capitalize ${QUOTE_STATUS_COLORS[q.status]}`}>{q.status}</span>
                    </div>
                    <div className="text-xs text-zinc-400 mt-0.5">
                      {[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), q.address, `${q.items?.length || 0} items`, new Date(q.created_at).toLocaleDateString()].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="font-semibold text-zinc-900 shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
                  <div className="flex gap-1.5 shrink-0">
                    {(q.status === 'draft' || q.status === 'sent') && (
                      <button onClick={() => openSendPanel(q)}
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg transition-colors">
                        <Send className="w-3 h-3" /> Send
                      </button>
                    )}
                    {q.status === 'sent' && (
                      <button onClick={() => copyPublicLink(q)}
                        className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors ${copiedQuoteId === q.id ? 'bg-green-600/30 text-green-400' : 'bg-purple-600/20 text-purple-400 hover:bg-purple-600/30'}`}>
                        {copiedQuoteId === q.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {copiedQuoteId === q.id ? 'Copied' : 'Copy Link'}
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
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-200 disabled:text-zinc-400 rounded-lg transition-colors">
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
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[500px] sm:border-l sm:border-zinc-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 shrink-0">
            <div>
              <h2 className="font-semibold text-zinc-900">{selected ? `Edit ${selected.quote_number}` : 'New Quote'}</h2>
              {selectedIntake && <p className="text-xs text-zinc-400 mt-0.5">From: {selectedIntake.name}</p>}
            </div>
            <button onClick={() => setPanel(null)} className="text-zinc-500 hover:text-zinc-500"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

            {/* Client */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Client *</label>
              <select value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Service type */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Service Type</label>
              <div className="flex gap-2">
                {SERVICE_TYPES.map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, service_type: t }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${form.service_type === t ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200'}`}>
                    {t === 'str' ? 'STR / Vacation' : t}
                  </button>
                ))}
              </div>
            </div>

            {/* Address */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Service Address</label>
              <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                placeholder="123 Main St, Portland, ME 04101"
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400">Line Items</label>
                <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                  className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Add item
                </button>
              </div>
              <div className="space-y-2">
                {form.items.map((item, i) => (
                  <div key={i} className="bg-zinc-100 rounded-lg p-3 space-y-2">
                    <div className="flex gap-2">
                      <input value={item.name} onChange={e => updateItem(i, 'name', e.target.value)}
                        placeholder="e.g. Standard Home Clean"
                        className="flex-1 bg-zinc-200 border border-zinc-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
                      <button onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                        className="text-zinc-500 hover:text-red-400 shrink-0"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <input value={item.description} onChange={e => updateItem(i, 'description', e.target.value)}
                      placeholder="Description (optional)"
                      className="w-full bg-zinc-200 border border-zinc-300 rounded px-2 py-1.5 text-xs text-zinc-500 focus:outline-none" />
                    <div className="flex gap-2">
                      <div className="w-20">
                        <label className="text-xs text-zinc-500">Qty</label>
                        <input type="number" min="0" step="0.5" value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)}
                          className="w-full bg-zinc-200 border border-zinc-300 rounded px-2 py-1.5 text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-zinc-500">Unit Price ($)</label>
                        <input type="number" min="0" step="5" value={item.unit_price} onChange={e => updateItem(i, 'unit_price', e.target.value)}
                          className="w-full bg-zinc-200 border border-zinc-300 rounded px-2 py-1.5 text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1 flex flex-col justify-end">
                        <label className="text-xs text-zinc-500">Line Total</label>
                        <div className="text-sm font-semibold text-zinc-900 mt-1.5">${((parseFloat(item.qty) || 0) * (parseFloat(item.unit_price) || 0)).toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tax + valid until */}
            <div className="flex gap-3">
              <div className="w-28">
                <label className="block text-xs text-zinc-400 mb-1">Tax (%)</label>
                <input type="number" min="0" max="100" value={form.tax_rate} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-zinc-400 mb-1">Valid Until</label>
                <input type="date" value={form.valid_until} onChange={e => setForm(f => ({ ...f, valid_until: e.target.value }))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>

            {/* Totals summary */}
            <div className="bg-zinc-100 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="flex justify-between text-zinc-400">
                <span>Subtotal</span><span>${subtotal(form.items).toFixed(2)}</span>
              </div>
              {parseFloat(form.tax_rate) > 0 && (
                <div className="flex justify-between text-zinc-400">
                  <span>Tax ({form.tax_rate}%)</span><span>${taxAmt(form.items, form.tax_rate).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-zinc-900 text-base border-t border-zinc-200 pt-2">
                <span>Total</span><span>${total(form.items, form.tax_rate).toFixed(2)}</span>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Notes / Scope</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                placeholder="Special instructions, inclusions/exclusions, access details..."
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>
          </div>

          <div className="p-6 border-t border-zinc-200 flex gap-3 shrink-0">
            <button onClick={save} disabled={saving || !form.client_id}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
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
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[460px] sm:border-l sm:border-zinc-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 shrink-0">
            <div>
              <h2 className="font-semibold text-zinc-900">Send Quote</h2>
              <p className="text-xs text-zinc-400 mt-0.5">{selected.quote_number} · {clientName(selected.client_id)} · ${parseFloat(selected.total || 0).toFixed(2)}</p>
            </div>
            <button onClick={() => setPanel(null)} className="text-zinc-500 hover:text-zinc-500"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

            {/* Channel selector */}
            <div>
              <label className="block text-xs text-zinc-400 mb-2">Send via</label>
              <div className="flex gap-2">
                {[
                  { id: 'email', label: 'Email', icon: Mail },
                  { id: 'sms', label: 'SMS', icon: MessageSquare },
                  { id: 'both', label: 'Both', icon: Send },
                ].map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => setSendForm(f => ({ ...f, channel: id }))}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${sendForm.channel === id ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200'}`}>
                    <Icon className="w-3.5 h-3.5" />{label}
                  </button>
                ))}
              </div>
            </div>

            {/* Email address */}
            {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Email Address</label>
                <input type="email" value={sendForm.email} onChange={e => setSendForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@example.com"
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            )}

            {/* Phone */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Phone Number</label>
                <input type="tel" value={sendForm.phone} onChange={e => setSendForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+12075551234"
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            )}

            {/* SMS preview */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <button onClick={() => setPreviewOpen(p => !p)}
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-500 mb-2">
                  <Eye className="w-3.5 h-3.5" /> Preview SMS <ChevronDown className={`w-3 h-3 transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
                </button>
                {previewOpen && (
                  <div className="bg-zinc-100 rounded-lg p-3 text-xs text-zinc-500 whitespace-pre-wrap font-mono border border-zinc-200">
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
              <label className="block text-xs text-zinc-400 mb-1">Personal note (optional)</label>
              <textarea value={sendForm.custom_message} onChange={e => setSendForm(f => ({ ...f, custom_message: e.target.value }))}
                rows={3} placeholder="Hi! Great talking with you — here's the quote we discussed..."
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
              <p className="text-xs text-zinc-500 mt-1">Prepended to SMS. Not included in email (reply to the email thread instead).</p>
            </div>

            {/* Quote summary */}
            <div className="bg-zinc-100 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="text-xs text-zinc-500 mb-2">Quote summary</div>
              {(selected.items || []).map((item, i) => (
                <div key={i} className="flex justify-between text-zinc-500">
                  <span>{item.name} {parseFloat(item.qty) !== 1 ? `×${item.qty}` : ''}</span>
                  <span>${(parseFloat(item.qty || 1) * parseFloat(item.unit_price || 0)).toFixed(2)}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold text-zinc-900 border-t border-zinc-200 pt-2 mt-1">
                <span>Total</span><span>${parseFloat(selected.total || 0).toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="p-6 border-t border-zinc-200 shrink-0">
            <button onClick={sendQuote} disabled={sending || (!sendForm.email && !sendForm.phone)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              <Send className="w-4 h-4" />
              {sending ? 'Sending...' : `Send via ${sendForm.channel === 'both' ? 'Email & SMS' : sendForm.channel === 'email' ? 'Email' : 'SMS'}`}
            </button>
          </div>
        </div>
      )}

      {toast && <Toast msg={toast} />}

      <AgentWidget
        pageContext="quoting"
        prompts={[
          'What should I charge for a deep clean?',
          'Help me price a recurring residential quote',
          'Which leads are ready for a quote?',
        ]}
      />
    </div>
  )
}
