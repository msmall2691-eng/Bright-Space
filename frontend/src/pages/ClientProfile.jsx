import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Phone, Mail, MapPin, Edit2, Save, X,
  Plus, Calendar, FileText, Receipt, MessageSquare,
  CheckCircle, Clock, AlertCircle, Send, ChevronRight, Home, RefreshCw
} from 'lucide-react'

const STATUS_COLORS = {
  lead:     'bg-amber-50 text-amber-700 border-amber-200',
  active:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  inactive: 'bg-gray-100 text-gray-600 border-gray-200',
}

const JOB_COLORS = {
  scheduled:   'bg-blue-500/20 text-blue-400',
  in_progress: 'bg-yellow-500/20 text-yellow-400',
  completed:   'bg-green-500/20 text-green-400',
  cancelled:   'bg-red-500/20 text-red-400',
}

const INVOICE_COLORS = {
  draft:   'bg-gray-500/20 text-gray-400',
  sent:    'bg-blue-500/20 text-blue-400',
  paid:    'bg-green-500/20 text-green-400',
  overdue: 'bg-red-500/20 text-red-400',
}

const QUOTE_COLORS = {
  draft:    'bg-gray-500/20 text-gray-400',
  sent:     'bg-blue-500/20 text-blue-400',
  accepted: 'bg-green-500/20 text-green-400',
  declined: 'bg-red-500/20 text-red-400',
}

function Tab({ label, icon: Icon, active, count, onClick }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? 'border-sky-500 text-sky-400'
          : 'border-transparent text-gray-500 hover:text-gray-600'
      }`}>
      <Icon className="w-4 h-4" />
      {label}
      {count > 0 && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-sky-500/20 text-sky-400' : 'bg-gray-200 text-gray-400'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

export default function ClientProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [client, setClient] = useState(null)
  const [jobs, setJobs] = useState([])
  const [quotes, setQuotes] = useState([])
  const [invoices, setInvoices] = useState([])
  const [messages, setMessages] = useState([])
  const [properties, setProperties] = useState([])
  const [schedules, setSchedules] = useState([])
  const [tab, setTab] = useState('activity')
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [smsText, setSmsText] = useState('')
  const [sending, setSending] = useState(false)
  // Property form state
  const [showPropForm, setShowPropForm] = useState(false)
  const [propForm, setPropForm] = useState({})
  const [editingProp, setEditingProp] = useState(null)
  const [savingProp, setSavingProp] = useState(false)
  const EMPTY_PROP = { name: '', address: '', city: '', state: 'ME', zip_code: '', property_type: 'residential', default_duration_hours: 3, notes: '' }

  const load = async () => {
    const [c, j, q, inv, msgs, props, scheds] = await Promise.all([
      fetch(`/api/clients/${id}`).then(r => r.json()),
      fetch(`/api/jobs?client_id=${id}`).then(r => r.json()),
      fetch(`/api/quotes?client_id=${id}`).then(r => r.json()),
      fetch(`/api/invoices?client_id=${id}`).then(r => r.json()),
      fetch(`/api/comms/messages?client_id=${id}`).then(r => r.json()),
      fetch(`/api/properties?client_id=${id}`).then(r => r.json()),
      fetch(`/api/recurring?client_id=${id}`).then(r => r.json()),
    ])
    setClient(c)
    setForm(c)
    setJobs(Array.isArray(j) ? j : [])
    setQuotes(Array.isArray(q) ? q : [])
    setInvoices(Array.isArray(inv) ? inv : [])
    setMessages(Array.isArray(msgs) ? msgs : [])
    setProperties(Array.isArray(props) ? props : [])
    setSchedules(Array.isArray(scheds) ? scheds : [])
  }

  const saveProp = async () => {
    setSavingProp(true)
    const method = editingProp ? 'PATCH' : 'POST'
    const url = editingProp ? `/api/properties/${editingProp.id}` : '/api/properties'
    const body = editingProp ? propForm : { ...propForm, client_id: parseInt(id) }
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (r.ok) { await load(); setShowPropForm(false); setEditingProp(null) }
    setSavingProp(false)
  }

  const deleteProp = async (propId) => {
    if (!confirm('Remove this property?')) return
    await fetch(`/api/properties/${propId}`, { method: 'DELETE' })
    await load()
  }

  const openNewProp = () => { setPropForm(EMPTY_PROP); setEditingProp(null); setShowPropForm(true) }
  const openEditProp = (p) => { setPropForm({ ...p }); setEditingProp(p); setShowPropForm(true) }

  useEffect(() => { load() }, [id])

  const save = async () => {
    setSaving(true)
    const payload = { ...form }
    // derive name from first/last if set
    const parts = [payload.first_name, payload.last_name].filter(Boolean).join(' ')
    if (parts) payload.name = parts
    const r = await fetch(`/api/clients/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (r.ok) { await load(); setEditing(false) }
    setSaving(false)
  }

  const sendSms = async () => {
    if (!smsText.trim() || !client?.phone) return
    setSending(true)
    await fetch('/api/comms/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: client.phone, body: smsText, client_id: parseInt(id) }),
    })
    setSmsText('')
    await load()
    setSending(false)
  }

  if (!client) return (
    <div className="flex items-center justify-center h-full text-gray-500 text-sm">Loading...</div>
  )

  // Revenue from this client
  const totalRevenue = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total || 0), 0)
  const outstanding = invoices.filter(i => ['sent', 'overdue'].includes(i.status)).reduce((s, i) => s + (i.total || 0), 0)
  const completedJobs = jobs.filter(j => j.status === 'completed').length

  // Build activity feed (all records sorted by date)
  const activity = [
    ...jobs.map(j => ({ type: 'job', date: j.created_at, data: j })),
    ...quotes.map(q => ({ type: 'quote', date: q.created_at, data: q })),
    ...invoices.map(i => ({ type: 'invoice', date: i.created_at, data: i })),
    ...messages.map(m => ({ type: 'message', date: m.created_at, data: m })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <button onClick={() => navigate('/clients')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-600 mb-3 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Clients
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-sky-50 flex items-center justify-center shrink-0">
              <span className="text-sky-400 font-bold text-xl">{(client.first_name || client.name)[0]?.toUpperCase()}</span>
            </div>
            <div>
              {editing ? (
                <div className="flex gap-2">
                  <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                    placeholder="First"
                    className="text-xl font-bold bg-gray-100 border border-gray-300 rounded-lg px-3 py-1 text-gray-900 focus:outline-none focus:border-sky-500 w-32" />
                  <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                    placeholder="Last"
                    className="text-xl font-bold bg-gray-100 border border-gray-300 rounded-lg px-3 py-1 text-gray-900 focus:outline-none focus:border-sky-500 w-32" />
                </div>
              ) : (
                <h1 className="text-xl font-bold text-gray-900">{client.name}</h1>
              )}
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {client.phone && <span className="flex items-center gap-1 text-sm text-gray-400"><Phone className="w-3.5 h-3.5" />{client.phone}</span>}
                {client.email && <span className="flex items-center gap-1 text-sm text-gray-400"><Mail className="w-3.5 h-3.5" />{client.email}</span>}
                {(client.city || client.address) && (
                  <span className="flex items-center gap-1 text-sm text-gray-400">
                    <MapPin className="w-3.5 h-3.5" />{client.city || client.address}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className={`text-xs px-2.5 py-1 rounded-full border capitalize ${STATUS_COLORS[client.status]}`}>
              {client.status}
            </span>
            {editing ? (
              <>
                <button onClick={save} disabled={saving}
                  className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-3 py-1.5 rounded-lg text-sm transition-colors">
                  <Save className="w-3.5 h-3.5" />{saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => { setEditing(false); setForm(client) }}
                  className="p-1.5 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100">
                  <X className="w-4 h-4" />
                </button>
              </>
            ) : (
              <button onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 bg-gray-100 hover:bg-gray-200 border border-gray-200 px-3 py-1.5 rounded-lg text-sm transition-colors">
                <Edit2 className="w-3.5 h-3.5" /> Edit
              </button>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="flex gap-6 mt-4 pt-4 border-t border-gray-200">
          {[
            { label: 'Total Revenue', value: `$${totalRevenue.toFixed(0)}`, color: 'text-green-400' },
            { label: 'Outstanding', value: `$${outstanding.toFixed(0)}`, color: outstanding > 0 ? 'text-yellow-400' : 'text-gray-400' },
            { label: 'Jobs Completed', value: completedJobs, color: 'text-gray-900' },
            { label: 'Total Jobs', value: jobs.length, color: 'text-gray-900' },
            { label: 'Source', value: client.source || '—', color: 'text-gray-400' },
          ].map(s => (
            <div key={s.label}>
              <div className="text-xs text-gray-500">{s.label}</div>
              <div className={`text-sm font-semibold mt-0.5 ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-2 px-6 py-3 bg-white/50 border-b border-gray-200 shrink-0">
        <span className="text-xs text-gray-500 mr-1">Quick:</span>
        <button onClick={() => navigate(`/quoting`)}
          className="flex items-center gap-1.5 text-xs bg-gray-100 hover:bg-gray-200 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors">
          <FileText className="w-3.5 h-3.5 text-blue-400" /> New Quote
        </button>
        <button onClick={() => navigate(`/scheduling?client_id=${id}`)}
          className="flex items-center gap-1.5 text-xs bg-gray-100 hover:bg-gray-200 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors">
          <Calendar className="w-3.5 h-3.5 text-sky-400" /> Schedule Job
        </button>
        <button onClick={() => navigate(`/invoicing`)}
          className="flex items-center gap-1.5 text-xs bg-gray-100 hover:bg-gray-200 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors">
          <Receipt className="w-3.5 h-3.5 text-green-400" /> New Invoice
        </button>
        <button onClick={() => setTab('messages')}
          className="flex items-center gap-1.5 text-xs bg-gray-100 hover:bg-gray-200 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors">
          <MessageSquare className="w-3.5 h-3.5 text-purple-400" /> Send SMS
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 px-6 bg-white/30 shrink-0 overflow-x-auto">
        <Tab label="Activity" icon={Clock} active={tab === 'activity'} count={activity.length} onClick={() => setTab('activity')} />
        <Tab label="Properties" icon={Home} active={tab === 'properties'} count={properties.length} onClick={() => setTab('properties')} />
        <Tab label="Recurring" icon={RefreshCw} active={tab === 'recurring'} count={schedules.filter(s=>s.active).length} onClick={() => setTab('recurring')} />
        <Tab label="Jobs" icon={Calendar} active={tab === 'jobs'} count={jobs.length} onClick={() => setTab('jobs')} />
        <Tab label="Quotes" icon={FileText} active={tab === 'quotes'} count={quotes.length} onClick={() => setTab('quotes')} />
        <Tab label="Invoices" icon={Receipt} active={tab === 'invoices'} count={invoices.length} onClick={() => setTab('invoices')} />
        <Tab label="Messages" icon={MessageSquare} active={tab === 'messages'} count={messages.length} onClick={() => setTab('messages')} />
        <Tab label="Details" icon={Edit2} active={tab === 'details'} count={0} onClick={() => setTab('details')} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">

        {/* Activity feed */}
        {tab === 'activity' && (
          <div className="max-w-2xl space-y-3">
            {activity.length === 0 && <p className="text-gray-500 text-sm text-center py-10">No activity yet</p>}
            {activity.map((item, i) => (
              <div key={i} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    item.type === 'job'     ? 'bg-sky-50' :
                    item.type === 'quote'   ? 'bg-blue-600/20' :
                    item.type === 'invoice' ? 'bg-green-50' :
                                              'bg-purple-50'
                  }`}>
                    {item.type === 'job'     && <Calendar className="w-3.5 h-3.5 text-sky-400" />}
                    {item.type === 'quote'   && <FileText className="w-3.5 h-3.5 text-blue-400" />}
                    {item.type === 'invoice' && <Receipt className="w-3.5 h-3.5 text-green-400" />}
                    {item.type === 'message' && <MessageSquare className="w-3.5 h-3.5 text-purple-400" />}
                  </div>
                  {i < activity.length - 1 && <div className="w-px flex-1 bg-gray-100 mt-1" />}
                </div>
                <div className="flex-1 pb-4 min-w-0">
                  <div className="bg-white border border-gray-200 rounded-xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {item.type === 'job' && (
                          <>
                            <div className="text-sm font-medium text-gray-900">{item.data.title}</div>
                            <div className="text-xs text-gray-400 mt-0.5">{item.data.scheduled_date} · {item.data.start_time}–{item.data.end_time}</div>
                          </>
                        )}
                        {item.type === 'quote' && (
                          <>
                            <div className="text-sm font-medium text-gray-900">Quote — ${item.data.total?.toFixed(2)}</div>
                            <div className="text-xs text-gray-400 mt-0.5">{item.data.items?.length || 0} items</div>
                          </>
                        )}
                        {item.type === 'invoice' && (
                          <>
                            <div className="text-sm font-medium text-gray-900">{item.data.invoice_number} — ${item.data.total?.toFixed(2)}</div>
                            <div className="text-xs text-gray-400 mt-0.5">Due {item.data.due_date || 'N/A'}</div>
                          </>
                        )}
                        {item.type === 'message' && (
                          <>
                            <div className="text-sm text-gray-600">{item.data.body}</div>
                            <div className="text-xs text-gray-500 mt-0.5">{item.data.direction} · {item.data.channel}</div>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                          item.type === 'job'     ? JOB_COLORS[item.data.status] :
                          item.type === 'quote'   ? QUOTE_COLORS[item.data.status] :
                          item.type === 'invoice' ? INVOICE_COLORS[item.data.status] :
                          'bg-purple-500/20 text-purple-400'
                        }`}>
                          {item.type === 'message' ? item.data.direction : item.data.status?.replace('_', ' ')}
                        </span>
                        <span className="text-xs text-gray-600">
                          {new Date(item.date).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Properties */}
        {tab === 'properties' && (
          <div className="max-w-2xl">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-400">{properties.length} propert{properties.length !== 1 ? 'ies' : 'y'}</p>
              <button onClick={openNewProp}
                className="flex items-center gap-1.5 text-xs bg-gray-900 hover:bg-gray-800 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add Property
              </button>
            </div>

            {/* Property form */}
            {showPropForm && (
              <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4 space-y-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-900">{editingProp ? 'Edit Property' : 'New Property'}</span>
                  <button onClick={() => setShowPropForm(false)} className="text-gray-500 hover:text-gray-600"><X className="w-4 h-4" /></button>
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">Property Name *</label>
                  <input value={propForm.name || ''} onChange={e => setPropForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Main Home, Lake House"
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">Type</label>
                  <div className="flex gap-2">
                    {[['residential','Residential'],['commercial','Commercial'],['str','STR / Airbnb']].map(([val, label]) => (
                      <button key={val} onClick={() => setPropForm(f => ({ ...f, property_type: val }))}
                        className={`flex-1 py-1.5 rounded-lg text-xs transition-colors ${propForm.property_type === val ? 'bg-sky-600 text-gray-900' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">Address</label>
                  <input value={propForm.address || ''} onChange={e => setPropForm(f => ({ ...f, address: e.target.value }))}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-400 mb-1">City</label>
                    <input value={propForm.city || ''} onChange={e => setPropForm(f => ({ ...f, city: e.target.value }))}
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
                  </div>
                  <div className="w-16">
                    <label className="block text-xs text-gray-400 mb-1">State</label>
                    <input value={propForm.state || ''} onChange={e => setPropForm(f => ({ ...f, state: e.target.value }))}
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
                  </div>
                  <div className="w-24">
                    <label className="block text-xs text-gray-400 mb-1">ZIP</label>
                    <input value={propForm.zip_code || ''} onChange={e => setPropForm(f => ({ ...f, zip_code: e.target.value }))}
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
                  </div>
                </div>

                <div className="w-40">
                  <label className="block text-xs text-gray-400 mb-1">Default Duration (hrs)</label>
                  <input type="number" step="0.5" min="0.5" value={propForm.default_duration_hours || 3}
                    onChange={e => setPropForm(f => ({ ...f, default_duration_hours: parseFloat(e.target.value) }))}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
                </div>

                {propForm.property_type === 'str' && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Airbnb iCal URL</label>
                    <input value={propForm.ical_url || ''} onChange={e => setPropForm(f => ({ ...f, ical_url: e.target.value }))}
                      placeholder="https://www.airbnb.com/calendar/ical/..."
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
                  </div>
                )}

                <div>
                  <label className="block text-xs text-gray-400 mb-1">Notes</label>
                  <textarea value={propForm.notes || ''} onChange={e => setPropForm(f => ({ ...f, notes: e.target.value }))} rows={2}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
                </div>

                <div className="flex gap-2 pt-1">
                  {editingProp && (
                    <button onClick={() => deleteProp(editingProp.id)}
                      className="px-3 py-2 text-sm text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 rounded-lg transition-colors">
                      Delete
                    </button>
                  )}
                  <button onClick={saveProp} disabled={savingProp || !propForm.name}
                    className="flex-1 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                    {savingProp ? 'Saving...' : 'Save Property'}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {properties.length === 0 && !showPropForm && (
                <p className="text-gray-500 text-sm text-center py-10">No properties yet</p>
              )}
              {properties.map(p => {
                const typeColors = {
                  residential: 'bg-blue-50 text-blue-700 border-blue-200',
                  commercial:  'bg-emerald-50 text-emerald-700 border-emerald-200',
                  str:         'bg-orange-50 text-orange-700 border-orange-200',
                }
                const typeLabel = { residential: 'Residential', commercial: 'Commercial', str: 'STR' }
                return (
                  <div key={p.id}
                    className="bg-white border border-gray-200 hover:border-gray-200 rounded-xl p-4 cursor-pointer transition-colors"
                    onClick={() => openEditProp(p)}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                          <Home className="w-4 h-4 text-gray-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 text-sm">{p.name}</div>
                          {p.address && (
                            <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                              <MapPin className="w-3 h-3 shrink-0" />
                              {[p.address, p.city, p.state].filter(Boolean).join(', ')}
                              {p.zip_code ? ` ${p.zip_code}` : ''}
                            </div>
                          )}
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${typeColors[p.property_type] || typeColors.residential}`}>
                              {typeLabel[p.property_type] || p.property_type}
                            </span>
                            <span className="text-[10px] text-gray-500">{p.default_duration_hours}h default</span>
                            {p.ical_url && <span className="text-[10px] text-orange-400">iCal linked</span>}
                          </div>
                        </div>
                      </div>
                      <Edit2 className="w-3.5 h-3.5 text-gray-600 shrink-0 mt-1" />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Recurring schedules */}
        {tab === 'recurring' && (
          <div className="max-w-2xl">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-400">{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</p>
              <a href="/recurring"
                className="flex items-center gap-1.5 text-xs bg-gray-900 hover:bg-gray-800 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add Schedule
              </a>
            </div>
            {schedules.length === 0 && (
              <div className="text-center py-10">
                <RefreshCw className="w-8 h-8 mx-auto mb-2 text-gray-700" />
                <p className="text-gray-500 text-sm mb-3">No recurring schedules</p>
                <a href="/recurring" className="text-xs text-sky-400 hover:text-sky-300">Set one up on the Recurring page</a>
              </div>
            )}
            <div className="space-y-2">
              {schedules.map(s => {
                const FREQ = { weekly: 'Every week', biweekly: 'Every 2 wks', monthly: 'Monthly' }
                const DAYS_S = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
                const typeColors = {
                  residential: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
                  commercial:  'text-green-400 bg-green-500/10 border-green-500/20',
                }
                return (
                  <div key={s.id} className={`bg-white border rounded-xl p-4 ${s.active ? 'border-gray-200' : 'border-gray-200 opacity-60'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-gray-900">{s.title}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${typeColors[s.job_type] || typeColors.residential}`}>
                            {s.job_type}
                          </span>
                          {!s.active && <span className="text-[10px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">Paused</span>}
                        </div>
                        <div className="text-xs text-gray-500">
                          {FREQ[s.frequency]} · {s.frequency !== 'monthly' ? `${DAYS_S[s.day_of_week]}s` : `day ${s.day_of_month}`} · {s.start_time}–{s.end_time}
                        </div>
                        {s.address && <div className="text-[10px] text-gray-600 mt-0.5 flex items-center gap-1"><MapPin className="w-2.5 h-2.5" />{s.address}</div>}
                      </div>
                      <a href="/recurring" className="text-xs text-gray-500 hover:text-gray-600 bg-gray-100 hover:bg-gray-200 px-2.5 py-1.5 rounded-lg transition-colors shrink-0">
                        Edit
                      </a>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Jobs */}
        {tab === 'jobs' && (
          <div className="max-w-2xl space-y-2">
            {jobs.length === 0 && <p className="text-gray-500 text-sm text-center py-10">No jobs yet</p>}
            {jobs.map(j => (
              <div key={j.id} className="bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4">
                <div className="text-center w-16 shrink-0">
                  <div className="text-sm font-medium text-gray-900">{j.start_time}</div>
                  <div className="text-xs text-gray-500">{j.scheduled_date}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900">{j.title}</div>
                  {j.address && <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" />{j.address}</div>}
                </div>
                <div className="flex items-center gap-2">
                  {j.dispatched && <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full">Dispatched</span>}
                  <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${JOB_COLORS[j.status]}`}>{j.status.replace('_', ' ')}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Quotes */}
        {tab === 'quotes' && (
          <div className="max-w-2xl space-y-2">
            {quotes.length === 0 && <p className="text-gray-500 text-sm text-center py-10">No quotes yet</p>}
            {quotes.map(q => (
              <div key={q.id} className="bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900">${q.total?.toFixed(2)}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{q.items?.length || 0} items · {new Date(q.created_at).toLocaleDateString()}</div>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${QUOTE_COLORS[q.status]}`}>{q.status}</span>
              </div>
            ))}
          </div>
        )}

        {/* Invoices */}
        {tab === 'invoices' && (
          <div className="max-w-2xl space-y-2">
            {invoices.length === 0 && <p className="text-gray-500 text-sm text-center py-10">No invoices yet</p>}
            {invoices.map(inv => (
              <div key={inv.id} className="bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900">{inv.invoice_number}</div>
                  <div className="text-xs text-gray-400 mt-0.5">Due {inv.due_date || 'N/A'} · ${inv.total?.toFixed(2)}</div>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${INVOICE_COLORS[inv.status]}`}>{inv.status}</span>
              </div>
            ))}
          </div>
        )}

        {/* Messages */}
        {tab === 'messages' && (
          <div className="max-w-2xl">
            {/* SMS compose */}
            {client.phone && (
              <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <MessageSquare className="w-4 h-4 text-purple-400" />
                  <span className="text-sm font-medium text-gray-900">Send SMS to {client.phone}</span>
                </div>
                <div className="flex gap-2">
                  <input value={smsText} onChange={e => setSmsText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendSms()}
                    placeholder="Type a message..."
                    className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
                  <button onClick={sendSms} disabled={sending || !smsText.trim()}
                    className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-200 px-4 py-2 rounded-lg text-sm transition-colors">
                    <Send className="w-3.5 h-3.5" />{sending ? '...' : 'Send'}
                  </button>
                </div>
              </div>
            )}
            {!client.phone && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm rounded-xl p-4 mb-4">
                Add a phone number to this client to enable SMS.
              </div>
            )}

            <div className="space-y-2">
              {messages.length === 0 && <p className="text-gray-500 text-sm text-center py-8">No messages yet</p>}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-sm px-4 py-2.5 rounded-2xl text-sm ${
                    m.direction === 'outbound'
                      ? 'bg-sky-600 text-gray-900 rounded-br-sm'
                      : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                  }`}>
                    <div>{m.body}</div>
                    <div className={`text-xs mt-1 ${m.direction === 'outbound' ? 'text-sky-200' : 'text-gray-500'}`}>
                      {new Date(m.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Details / Edit */}
        {tab === 'details' && (
          <div className="max-w-lg space-y-5">

            {/* Contact info */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">Contact</div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">First Name</label>
                  <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-gray-400" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">Last Name</label>
                  <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-gray-400" />
                </div>
              </div>
              {[
                { label: 'Phone', key: 'phone' },
                { label: 'Email', key: 'email' },
                { label: 'Lead Source', key: 'source' },
              ].map(({ label, key }) => (
                <div key={key} className="flex items-center gap-4">
                  <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-gray-400" />
                </div>
              ))}
              <div className="flex items-center gap-4">
                <span className="text-xs text-gray-500 w-24 shrink-0">Status</span>
                <select value={form.status || 'lead'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none">
                  <option value="lead">Lead</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div className="flex items-start gap-4">
                <span className="text-xs text-gray-500 w-24 shrink-0 pt-2">Notes</span>
                <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                  className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-400 resize-none" />
              </div>
            </div>

            {/* Service address */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">Service Address</div>
              {[
                { label: 'Street', key: 'address' },
                { label: 'City', key: 'city' },
                { label: 'State', key: 'state' },
                { label: 'ZIP', key: 'zip_code' },
              ].map(({ label, key }) => (
                <div key={key} className="flex items-center gap-4">
                  <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-gray-400" />
                </div>
              ))}
            </div>

            {/* Billing address */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">Billing Address</div>
              <p className="text-xs text-gray-400 -mt-2">Leave blank to use service address on invoices</p>
              {[
                { label: 'Street', key: 'billing_address' },
                { label: 'City', key: 'billing_city' },
                { label: 'State', key: 'billing_state' },
                { label: 'ZIP', key: 'billing_zip' },
              ].map(({ label, key }) => (
                <div key={key} className="flex items-center gap-4">
                  <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-gray-400" />
                </div>
              ))}
            </div>

            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-200 px-5 py-2 rounded-lg text-sm font-medium transition-colors">
              <Save className="w-4 h-4" />{saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
