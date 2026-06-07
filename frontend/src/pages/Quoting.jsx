import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Plus, Trash2, X, Calendar, CheckCircle, Send, Mail, MessageSquare, Eye, ChevronDown, Copy, Check } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get, post, patch } from "../api"


const QUOTE_STATUS_COLORS = {
  draft:    'bg-bg-2 text-ink-3 border-hairline',
  sent:     'bg-blue-50 text-blue-700 border-blue-200',
  viewed:   'bg-indigo-50 text-indigo-700 border-indigo-200',
  changes_requested: 'bg-amber-50 text-amber-700 border-amber-200',
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

// Hardcoded defaults — used as fallback when the admin hasn't customized
// templates yet. Once they edit via the template manager, these are
// replaced by the API-stored version from /api/settings/quote-templates.
const DEFAULT_QUOTE_TEMPLATES = [
  { id: 'biweekly_residential', label: 'Biweekly Residential', service_type: 'residential',
    items: [{ name: 'Biweekly home clean', description: 'Recurring biweekly residential cleaning', qty: 1, unit_price: 185 }] },
  { id: 'weekly_residential', label: 'Weekly Residential', service_type: 'residential',
    items: [{ name: 'Weekly home clean', description: 'Recurring weekly residential cleaning', qty: 1, unit_price: 165 }] },
  { id: 'str_turnover', label: 'STR Turnover', service_type: 'str',
    items: [{ name: 'Airbnb / VRBO turnover', description: 'Strip beds, clean kitchen + baths, restock linens between guests', qty: 1, unit_price: 145 }] },
  { id: 'one_time_deep', label: 'One-Time Deep Clean', service_type: 'residential',
    items: [{ name: 'Deep clean (one-time)', description: 'Full top-to-bottom deep clean of the home', qty: 1, unit_price: 425 }] },
  { id: 'move_in_out', label: 'Move-In / Move-Out', service_type: 'residential',
    items: [
      { name: 'Move-in / move-out clean', description: 'Empty-home top-to-bottom clean, inside cabinets, appliances, baseboards', qty: 1, unit_price: 525 },
    ] },
  { id: 'office_clean', label: 'Commercial / Office', service_type: 'commercial',
    items: [{ name: 'Office clean', description: 'Recurring office cleaning - trash, restrooms, vacuum, kitchen', qty: 1, unit_price: 295 }] },
]

function Toast({ msg }) {
  return (
    <div className="fixed bottom-6 right-6 bg-panel border border-hairline text-ink text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50">
      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />{msg}
    </div>
  )
}

export default function Quoting() {
  const navigate = useNavigate()
  const location = useLocation()
  const [tab, setTab] = useState('leads')
  const [quotes, setQuotes] = useState([])
  const [intakes, setIntakes] = useState([])
  const [clients, setClients] = useState([])
  const [quoteTemplates, setQuoteTemplates] = useState(DEFAULT_QUOTE_TEMPLATES)
  const [companyName, setCompanyName] = useState('Maine Cleaning Co')
  const [panel, setPanel] = useState(null) // 'quote' | 'send' | 'templates' | null
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
  // Inline "new client" quick-add from the quote form.
  const [addingClient, setAddingClient] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '' })
  const [creatingClient, setCreatingClient] = useState(false)
  const [clientErr, setClientErr] = useState('')

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500) }

  // Selecting a client fills the quote address from the client's address when
  // it's still blank (smart default; never clobbers typed input).
  const selectClient = (idStr) => {
    const c = clients.find(c => String(c.id) === String(idStr))
    setForm(f => {
      const next = { ...f, client_id: idStr }
      if (c && !f.address) {
        // "123 Main St, Portland, ME 04101" — keep the ZIP so the quote (and any
        // job converted from it) has the complete service address.
        const cityStateZip = [[c.city, c.state].filter(Boolean).join(', '), c.zip_code]
          .filter(Boolean).join(' ')
        next.address = [c.address, cityStateZip].filter(Boolean).join(', ')
      }
      return next
    })
  }

  // Create a client without leaving the quote form, then select it.
  const createInlineClient = async () => {
    if (!newClient.name.trim()) { setClientErr('Name is required'); return }
    setCreatingClient(true); setClientErr('')
    try {
      const created = await post('/api/clients', {
        name: newClient.name.trim(),
        phone: newClient.phone.trim() || null,
        email: newClient.email.trim() || null,
        status: 'active',
      })
      setClients(cs => [created, ...cs])
      selectClient(String(created.id))
      setAddingClient(false)
      setNewClient({ name: '', phone: '', email: '' })
    } catch (e) {
      setClientErr(e.message || 'Failed to create client')
    }
    setCreatingClient(false)
  }

  const loadQuotes = () => get('/api/quotes').then(d => setQuotes(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))
  const loadIntakes = () => get('/api/intake').then(d => setIntakes(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))

  useEffect(() => {
    loadQuotes()
    loadIntakes()
    get('/api/clients').then(d => setClients(Array.isArray(d) ? d : [])).catch(err => console.error("[Quoting]", err))
    get('/api/settings/quote-templates').then(d => {
      if (d?.templates?.length) setQuoteTemplates(d.templates)
    }).catch(() => {})
    // Use the configured company name in the customer-facing SMS instead of a
    // hardcoded brand. Falls back to the default if unset/unavailable.
    get('/api/settings').then(d => { if (d?.company_name) setCompanyName(d.company_name) }).catch(() => {})
  }, [])

  useEffect(() => {
    if (location.state?.quoteId) {
      get(`/api/quotes/${location.state.quoteId}`).then(q => {
        openQuoteForm(q)
        setTab('quotes')
      }).catch(err => console.error("[Quoting]", err))
    }
  }, [location.state?.quoteId])

  // Open the new-quote form pre-filled with a client (used by ClientProfile's "New Quote" button)
  useEffect(() => {
    if (location.state?.openNew && location.state?.clientId) {
      setSelected(null)
      setSelectedIntake(null)
      setForm(f => ({
        ...f,
        client_id: location.state.clientId,
        intake_id: null,
        items: [{ ...EMPTY_ITEM }],
      }))
      setPanel('quote')
      setTab('quotes')
    }
  }, [location.state?.openNew, location.state?.clientId])

  // Open the new-quote form pre-filled from a LeadIntake (Requests page → "Create Quote")
  useEffect(() => {
    const intake = location.state?.openNewFromIntake
    if (intake) {
      openQuoteForm(null, intake)
      setTab('quotes')
    }
    // We deliberately only run when the intake id changes; openQuoteForm is
    // stable within a render and React-Router doesn't change location.state
    // reference unless the navigation actually fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.openNewFromIntake?.id])

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
    // Prefer the linked intake's contact info — when the lead auto-matched to
    // a placeholder client (e.g. "BrightBase Webhook Test"), the client.email
    // is the wrong address. The intake has the real lead's email.
    const intake = q.intake_id ? intakes.find(i => i.id === q.intake_id) : null
    const preferEmail = intake?.email || client?.email || ''
    const preferPhone = intake?.phone || client?.phone || ''
    setSendForm({
      channel: preferEmail ? 'email' : 'sms',
      email: preferEmail,
      phone: preferPhone,
      custom_message: ''
    })
    setSelected(q)
    setPanel('send')
  }

  const save = async () => {
    if (!form.client_id) { showToast('Please select a client first'); return }
    if (!form.items.length || form.items.every(i => !i.name || !i.name.trim())) { showToast('Add at least one line item with a name'); return }
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
    } catch (e) { showToast(e.message || 'Error saving quote') }
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
    } catch (e) { showToast(e.message || 'Error converting to job') }
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
    return `${companyName} — Quote ${q.quote_number || `QT-${q.id}`}\n${st} clean${q.address ? ` at ${q.address}` : ''}\nTotal: $${parseFloat(q.total || 0).toFixed(2)}${q.valid_until ? `\nValid until: ${q.valid_until}` : ''}\n\nReply YES to accept or ask any questions.`
  }

  const newLeads = intakes.filter(i => i.status === 'new').length

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col min-w-0 overflow-hidden">

        {/* Tabs + action */}
        <div className="flex justify-between items-center mb-5 shrink-0">
          <div className="flex items-center gap-1 bg-bg-2 rounded-lg p-1">
            <button onClick={() => setTab('leads')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${tab === 'leads' ? 'bg-bg-2 text-ink' : 'text-ink-3 hover:text-ink-3'}`}>
              Leads
              {newLeads > 0 && <span className="bg-yellow-500 text-black text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{newLeads}</span>}
            </button>
            <button onClick={() => setTab('quotes')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'quotes' ? 'bg-bg-2 text-ink' : 'text-ink-3 hover:text-ink-3'}`}>
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
              <div className="text-center py-16 text-ink-3">
                <p className="text-sm">No leads yet</p>
                <p className="text-xs mt-1 text-ink-3">Submissions from maineclean.co will appear here</p>
              </div>
            )}
            {intakes.map(intake => (
              <div key={intake.id} className="bg-panel border border-hairline rounded-xl p-4">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-medium text-ink">{intake.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${LEAD_STATUS_COLORS[intake.status]}`}>{intake.status}</span>
                      <span className="text-xs text-ink-3 capitalize bg-bg-2 px-2 py-0.5 rounded-full">{intake.service_type}</span>
                    </div>
                    <div className="text-xs text-ink-3 space-y-0.5">
                      {(intake.phone || intake.email) && <div>{[intake.phone, intake.email].filter(Boolean).join(' · ')}</div>}
                      {intake.address && <div>{[intake.address, intake.city, intake.state].filter(Boolean).join(', ')}</div>}
                      {intake.preferred_date && <div>Preferred: {intake.preferred_date}</div>}
                      {intake.message && <div className="text-ink-3 italic mt-1 line-clamp-2">"{intake.message}"</div>}
                    </div>
                    <div className="text-xs text-ink-3 mt-1.5">
                      {new Date(intake.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    {intake.status === 'new' && (
                      <button onClick={() => markIntakeReviewed(intake.id)}
                        className="text-xs px-3 py-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 rounded-lg transition-colors border border-hairline">
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
                        className="text-xs px-3 py-1.5 bg-bg-2 hover:bg-bg-2 text-ink-3 rounded-lg transition-colors">
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
            {quotes.length === 0 && <div className="text-center py-16 text-ink-3 text-sm">No quotes yet</div>}
            {quotes.map(q => (
              <div key={q.id} className="bg-panel border border-hairline hover:border-hairline rounded-xl p-4 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openQuoteForm(q)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{clientName(q.client_id)}</span>
                      <span className="text-xs text-ink-3">{q.quote_number}</span>
                      <span className={`text-xs px-2.5 py-0.5 rounded-full border capitalize ${QUOTE_STATUS_COLORS[q.status] || QUOTE_STATUS_COLORS.draft}`}>{(q.status || '').replace(/_/g, ' ')}</span>
                      {q.status === 'changes_requested' && <span className="w-2 h-2 rounded-full bg-amber-500" title="Customer requested changes" />}
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">
                      {[q.service_type && q.service_type.charAt(0).toUpperCase() + q.service_type.slice(1), q.address, `${q.items?.length || 0} items`, new Date(q.created_at).toLocaleDateString()].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="font-semibold text-ink shrink-0">${parseFloat(q.total || 0).toFixed(2)}</div>
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
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 rounded-lg transition-colors">
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
        <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[500px] sm:border-l sm:border-hairline sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
            <div>
              <h2 className="font-semibold text-ink">{selected ? `Edit ${selected.quote_number}` : 'New Quote'}</h2>
              {selectedIntake && <p className="text-xs text-ink-3 mt-0.5">From: {selectedIntake.name}</p>}
            </div>
            <button onClick={() => setPanel(null)} className="text-ink-3 hover:text-ink-3"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

            {/* Customer response banner — what the customer did with this quote */}
            {selected && selected.requested_changes_message && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <div className="font-semibold text-amber-800 mb-1">Customer requested changes</div>
                <div className="text-amber-900 whitespace-pre-wrap">“{selected.requested_changes_message}”</div>
                {selected.requested_changes_at && <div className="text-[11px] text-amber-700 mt-1">{new Date(selected.requested_changes_at).toLocaleString()}</div>}
              </div>
            )}
            {selected && selected.status === 'accepted' && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
                <div className="font-semibold text-emerald-800">Accepted{selected.accepted_by_name ? ` by ${selected.accepted_by_name}` : ''} ✓</div>
                {selected.accepted_at && <div className="text-[11px] text-emerald-700 mt-0.5">{new Date(selected.accepted_at).toLocaleString()}</div>}
              </div>
            )}
            {selected && selected.status === 'declined' && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                <div className="font-semibold text-red-800">Declined{selected.declined_by_name ? ` by ${selected.declined_by_name}` : ''}</div>
                {selected.declined_reason && <div className="text-red-900 mt-0.5">“{selected.declined_reason}”</div>}
                {selected.declined_at && <div className="text-[11px] text-red-700 mt-0.5">{new Date(selected.declined_at).toLocaleString()}</div>}
              </div>
            )}

            {/* Client */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-ink-3">Client *</label>
                <button type="button"
                  onClick={() => { setAddingClient(a => !a); setClientErr('') }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                  {addingClient ? 'Cancel' : '+ New client'}
                </button>
              </div>
              {addingClient && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-2.5 space-y-2 mb-2">
                  <input autoFocus value={newClient.name} onChange={e => setNewClient(n => ({ ...n, name: e.target.value }))}
                    placeholder="Client name *"
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={newClient.phone} onChange={e => setNewClient(n => ({ ...n, phone: e.target.value }))}
                      placeholder="Phone"
                      className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                    <input value={newClient.email} onChange={e => setNewClient(n => ({ ...n, email: e.target.value }))}
                      placeholder="Email"
                      className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                  </div>
                  {clientErr && <div className="text-xs text-red-600">{clientErr}</div>}
                  <button type="button" onClick={createInlineClient} disabled={creatingClient || !newClient.name.trim()}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                    {creatingClient ? 'Creating…' : 'Create & select client'}
                  </button>
                </div>
              )}
              <select value={form.client_id} onChange={e => selectClient(e.target.value)}
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
                <option value="">Select client...</option>
                {(() => {
                  // Dedupe + sort: real names first, placeholders last w/ marker.
                  // Surfaces email/phone so two same-name clients are distinguishable.
                  const PLACEHOLDER_RE = /^(unknown|brightbase webhook test|webhook test|test client|n\/a|\+?[\d\s().-]+)$/i
                  const isPlaceholder = (n) => !n || !n.trim() || PLACEHOLDER_RE.test(n.trim())
                  const seen = new Set()
                  const sorted = [...clients].filter(c => {
                    if (seen.has(c.id)) return false
                    seen.add(c.id); return true
                  }).sort((a, b) => {
                    const ap = isPlaceholder(a.name) ? 1 : 0
                    const bp = isPlaceholder(b.name) ? 1 : 0
                    if (ap !== bp) return ap - bp
                    return (a.name || '').localeCompare(b.name || '')
                  })
                  return sorted.map(c => {
                    const tag = isPlaceholder(c.name) ? ' (placeholder)' : ''
                    const contact = [c.email, c.phone].filter(Boolean).join(' · ')
                    const label = `${c.name || '(no name)'}${tag}${contact ? ' — ' + contact : ''}`
                    return <option key={c.id} value={c.id}>{label}</option>
                  })
                })()}
              </select>
            </div>

            {/* Service type */}
            <div>
              <label className="block text-xs text-ink-3 mb-1.5">Service Type</label>
              <div className="flex gap-2">
                {SERVICE_TYPES.map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, service_type: t }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${form.service_type === t ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                    {t === 'str' ? 'STR / Vacation' : t}
                  </button>
                ))}
              </div>
            </div>

            {/* Address */}
            <div>
              <label className="block text-xs text-ink-3 mb-1">Service Address</label>
              <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                placeholder="123 Main St, Portland, ME 04101"
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
            </div>

            {/* Templates */}
            <div>
              <label className="text-xs text-ink-3 block mb-1">Start from template</label>
              <select
                value=""
                onChange={e => {
                  const tpl = quoteTemplates.find(t => t.id === e.target.value)
                  if (!tpl) return
                  setForm(f => ({ ...f, service_type: tpl.service_type, items: tpl.items.map(it => ({ ...it })) }))
                  e.target.value = ''
                }}
                className="w-full px-3 py-2 bg-bg-2 border border-hairline-2 rounded-md text-white text-sm"
              >
                <option value="">Custom (build from scratch)</option>
                {quoteTemplates.map(t => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
              <p className="text-[11px] text-ink-3 mt-1">Pick a template to pre-fill the line items. You can still edit everything.</p>
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-ink-3">Line Items</label>
                <button onClick={() => setForm(f => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                  className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Add item
                </button>
              </div>
              <div className="space-y-2">
                {form.items.map((item, i) => (
                  <div key={i} className="bg-bg-2 rounded-lg p-3 space-y-2">
                    <div className="flex gap-2">
                      <input value={item.name} onChange={e => updateItem(i, 'name', e.target.value)}
                        placeholder="e.g. Standard Home Clean"
                        className="flex-1 bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none focus:border-blue-400" />
                      <button onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                        className="text-ink-3 hover:text-red-400 shrink-0"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <input value={item.description} onChange={e => updateItem(i, 'description', e.target.value)}
                      placeholder="Description (optional)"
                      className="w-full bg-bg-2 border border-hairline rounded px-2 py-1.5 text-xs text-ink-3 focus:outline-none" />
                    <div className="flex gap-2">
                      <div className="w-20">
                        <label className="text-xs text-ink-3">Qty</label>
                        <input type="number" inputMode="decimal" min="0" step="0.5" value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)}
                          className="w-full bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-ink-3">Unit Price ($)</label>
                        <input type="number" inputMode="decimal" min="0" step="5" value={item.unit_price} onChange={e => updateItem(i, 'unit_price', e.target.value)}
                          className="w-full bg-bg-2 border border-hairline rounded px-2 py-2.5 sm:py-1.5 text-base sm:text-sm focus:outline-none mt-0.5" />
                      </div>
                      <div className="flex-1 flex flex-col justify-end">
                        <label className="text-xs text-ink-3">Line Total</label>
                        <div className="text-sm font-semibold text-ink mt-1.5">${((parseFloat(item.qty) || 0) * (parseFloat(item.unit_price) || 0)).toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tax + valid until */}
            <div className="flex gap-3">
              <div className="w-28">
                <label className="block text-xs text-ink-3 mb-1">Tax (%)</label>
                <input type="number" min="0" max="100" value={form.tax_rate} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-ink-3 mb-1">Valid Until</label>
                <input type="date" value={form.valid_until} onChange={e => setForm(f => ({ ...f, valid_until: e.target.value }))}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>

            {/* Totals summary */}
            <div className="bg-bg-2 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="flex justify-between text-ink-3">
                <span>Subtotal</span><span>${subtotal(form.items).toFixed(2)}</span>
              </div>
              {parseFloat(form.tax_rate) > 0 && (
                <div className="flex justify-between text-ink-3">
                  <span>Tax ({form.tax_rate}%)</span><span>${taxAmt(form.items, form.tax_rate).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-ink text-base border-t border-hairline pt-2">
                <span>Total</span><span>${total(form.items, form.tax_rate).toFixed(2)}</span>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs text-ink-3 mb-1">Notes / Scope</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                placeholder="Special instructions, inclusions/exclusions, access details..."
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>
          </div>

          <div className="p-6 border-t border-hairline flex gap-3 shrink-0">
            <button onClick={save} disabled={saving || !form.client_id}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
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
        <div className="fixed inset-0 z-40 bg-panel flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-[460px] sm:border-l sm:border-hairline sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-hairline shrink-0">
            <div>
              <h2 className="font-semibold text-ink">Send Quote</h2>
              <p className="text-xs text-ink-3 mt-0.5">{selected.quote_number} · {clientName(selected.client_id)} · ${parseFloat(selected.total || 0).toFixed(2)}</p>
            </div>
            <button onClick={() => setPanel(null)} className="text-ink-3 hover:text-ink-3"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5 scrollbar-thin">

            {/* Channel selector */}
            <div>
              <label className="block text-xs text-ink-3 mb-2">Send via</label>
              <div className="flex gap-2">
                {[
                  { id: 'email', label: 'Email', icon: Mail },
                  { id: 'sms', label: 'SMS', icon: MessageSquare },
                  { id: 'both', label: 'Both', icon: Send },
                ].map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => setSendForm(f => ({ ...f, channel: id }))}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${sendForm.channel === id ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                    <Icon className="w-3.5 h-3.5" />{label}
                  </button>
                ))}
              </div>
            </div>

            {/* Email address */}
            {(sendForm.channel === 'email' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-ink-3 mb-1">Email Address</label>
                <input type="email" value={sendForm.email} onChange={e => setSendForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@example.com"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            )}

            {/* Phone */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <label className="block text-xs text-ink-3 mb-1">Phone Number</label>
                <input type="tel" value={sendForm.phone} onChange={e => setSendForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+12075551234"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
              </div>
            )}

            {/* SMS preview */}
            {(sendForm.channel === 'sms' || sendForm.channel === 'both') && (
              <div>
                <button onClick={() => setPreviewOpen(p => !p)}
                  className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-3 mb-2">
                  <Eye className="w-3.5 h-3.5" /> Preview SMS <ChevronDown className={`w-3 h-3 transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
                </button>
                {previewOpen && (
                  <div className="bg-bg-2 rounded-lg p-3 text-xs text-ink-3 whitespace-pre-wrap font-mono border border-hairline">
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
              <label className="block text-xs text-ink-3 mb-1">Personal note (optional)</label>
              <textarea value={sendForm.custom_message} onChange={e => setSendForm(f => ({ ...f, custom_message: e.target.value }))}
                rows={3} placeholder="Hi! Great talking with you — here's the quote we discussed..."
                className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
              <p className="text-xs text-ink-3 mt-1">Prepended to SMS. Not included in email (reply to the email thread instead).</p>
            </div>

            {/* Quote summary */}
            <div className="bg-bg-2 rounded-xl p-4 space-y-1.5 text-sm">
              <div className="text-xs text-ink-3 mb-2">Quote summary</div>
              {(selected.items || []).map((item, i) => (
                <div key={i} className="flex justify-between text-ink-3">
                  <span>{item.name} {parseFloat(item.qty) !== 1 ? `×${item.qty}` : ''}</span>
                  <span>${(parseFloat(item.qty || 1) * parseFloat(item.unit_price || 0)).toFixed(2)}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold text-ink border-t border-hairline pt-2 mt-1">
                <span>Total</span><span>${parseFloat(selected.total || 0).toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="p-6 border-t border-hairline shrink-0">
            <button onClick={sendQuote} disabled={sending || (!sendForm.email && !sendForm.phone)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
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
