import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import AgentWidget from '../components/AgentWidget'
import ClientCRMSummary from '../components/ClientCRMSummary'
import ActivityTimeline from '../components/ActivityTimeline'
import OpportunityLinker from '../components/OpportunityLinker'
import { del, get, post, patch } from "../api"
import {
  ArrowLeft, Phone, Mail, MapPin, Edit2, Save, X,
  Plus, Calendar, FileText, Receipt, MessageSquare,
  CheckCircle, Clock, AlertCircle, Send, ChevronLeft, ChevronRight, Home, RefreshCw,
  TrendingUp, DollarSign, Target, Inbox, ArrowUpRight, Zap
} from 'lucide-react'

const STATUS_COLORS = {
  lead:     'bg-amber-500/15 text-amber-500 border-amber-500/20',
  active:   'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
  inactive: 'bg-zinc-100 text-zinc-400 border-zinc-200',
}

const JOB_COLORS = {
  scheduled:   'bg-blue-500/20 text-blue-400',
  in_progress: 'bg-yellow-500/20 text-yellow-400',
  completed:   'bg-green-500/20 text-green-400',
  cancelled:   'bg-red-500/20 text-red-400',
}

const INVOICE_COLORS = {
  draft:   'bg-zinc-500/20 text-zinc-400',
  sent:    'bg-blue-500/20 text-blue-400',
  paid:    'bg-green-500/20 text-green-400',
  overdue: 'bg-red-500/20 text-red-400',
}

const QUOTE_COLORS = {
  draft:    'bg-zinc-500/20 text-zinc-400',
  sent:     'bg-blue-500/20 text-blue-400',
  accepted: 'bg-green-500/20 text-green-400',
  declined: 'bg-red-500/20 text-red-400',
}

const PROPERTY_TYPE_COLORS = {
  residential: 'bg-blue-50 text-blue-700 border-blue-200',
  commercial:  'bg-emerald-50 text-emerald-700 border-emerald-200',
  str:         'bg-orange-50 text-orange-700 border-orange-200',
}

const PROPERTY_TYPE_LABELS = {
  residential: 'Residential',
  commercial: 'Commercial',
  str: 'STR'
}

const INPUT_CLASS = 'w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none'

function Tab({ label, icon: Icon, active, count, onClick }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? 'border-blue-500 text-blue-500'
          : 'border-transparent text-zinc-500 hover:text-zinc-500'
      }`}>
      <Icon className="w-4 h-4" />
      {label}
      {count > 0 && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-blue-500/15 text-blue-500' : 'bg-zinc-200 text-zinc-400'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

export default function ClientProfile() {
  const { id } = useParams()
  const navigate = useNavigate()

  // Tab redirect for backward compatibility (12 → 5 tabs)
  const TAB_REDIRECTS = {
    details: 'overview', crm: 'overview', properties: 'overview',
    calendar: 'schedule', recurring: 'schedule', jobs: 'schedule',
    emails: 'activity', quotes: 'money', invoices: 'money', opportunities: 'money',
  }
  
  // On mount, check URL hash for old tab names and redirect
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    const params = new URLSearchParams(hash)
    const oldTab = params.get('tab')
    if (oldTab && TAB_REDIRECTS[oldTab]) {
      setTab(TAB_REDIRECTS[oldTab])
      window.location.hash = `tab=${TAB_REDIRECTS[oldTab]}`
    } else if (hash) {
      window.location.hash = `tab=${tab}`
    }
  }, [])
  const [client, setClient] = useState(null)
  const [jobs, setJobs] = useState([])
  const [quotes, setQuotes] = useState([])
  const [invoices, setInvoices] = useState([])
  const [messages, setMessages] = useState([])
  const [properties, setProperties] = useState([])
  const [schedules, setSchedules] = useState([])
  const [opportunities, setOpportunities] = useState([])
  const [activities, setActivities] = useState([])
  const [emails, setEmails] = useState([])
  const [tab, setTab] = useState('details')
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

  const [visitStats, setVisitStats] = useState(null)
  const [profileVisits, setProfileVisits] = useState({ upcoming: [], past: [] })

  const load = async () => {
    const [profile, j, q, inv, msgs, props, scheds, opps, acts, gmailRes] = await Promise.all([
      get(`/api/clients/${id}/profile`).catch(() => null),
      get(`/api/jobs?client_id=${id}`),
      get(`/api/quotes?client_id=${id}`),
      get(`/api/invoices?client_id=${id}`),
      get(`/api/comms/messages?client_id=${id}`),
      get(`/api/properties?client_id=${id}`),
      get(`/api/recurring?client_id=${id}`),
      get(`/api/opportunities?client_id=${id}`).catch(() => []),
      get(`/api/activities?client_id=${id}&limit=50`).catch(() => []),
      get(`/api/gmail/inbox?max_results=40&skip_automated=true`).catch(() => ({ emails: [] })),
    ])
    // Use profile endpoint data if available, fall back to basic client
    const c = profile || await get(`/api/clients/${id}`)
    setClient(c)
    // Backfill first_name / last_name from `name` if the form has empties.
    // A lot of seeded/imported clients only have `name` set, so the Edit
    // form was opening with blank First/Last fields even though the header
    // displayed the right name.
    const formFill = { ...c }
    if ((!formFill.first_name || !formFill.first_name.trim())
        && (!formFill.last_name || !formFill.last_name.trim())
        && c.name) {
      const parts = c.name.trim().split(/\s+/)
      formFill.first_name = parts[0] || ''
      formFill.last_name = parts.slice(1).join(' ') || ''
    }
    setForm(formFill)
    if (profile?.visit_stats) setVisitStats(profile.visit_stats)
    if (profile?.upcoming_visits || profile?.past_visits) {
      setProfileVisits({
        upcoming: profile.upcoming_visits || [],
        past: profile.past_visits || [],
      })
    }
    setJobs(Array.isArray(j) ? j : [])
    setQuotes(Array.isArray(q) ? q : [])
    setInvoices(Array.isArray(inv) ? inv : [])
    setMessages(Array.isArray(msgs) ? msgs : [])
    setProperties(Array.isArray(props) ? props : [])
    setSchedules(Array.isArray(scheds) ? scheds : [])
    setOpportunities(Array.isArray(opps) ? opps : [])
    setActivities(Array.isArray(acts) ? acts : [])
    const allEmails = gmailRes?.emails || []
    const clientEmail = c?.email?.toLowerCase()
    setEmails(clientEmail ? allEmails.filter(e => e.from_email?.toLowerCase() === clientEmail || e.client?.id === parseInt(id)) : [])
  }

  const saveProp = async () => {
    setSavingProp(true)
    try {
      const url = editingProp ? `/api/properties/${editingProp.id}` : '/api/properties'
      const body = editingProp ? propForm : { ...propForm, client_id: parseInt(id) }
      editingProp ? await patch(url, body) : await post(url, body)
      const props = await get(`/api/properties?client_id=${id}`)
      setProperties(Array.isArray(props) ? props : [])
      setShowPropForm(false); setEditingProp(null); setPropForm(EMPTY_PROP)
    } catch (e) {
      console.error('[saveProp]', e)
    }
    setSavingProp(false)
  }

  const deleteProp = async (propId) => {
    if (!confirm('Remove this property?')) return
    await del(`/api/properties/${propId}`)
    await load()
  }

  const openNewProp = () => { setPropForm(EMPTY_PROP); setEditingProp(null); setShowPropForm(true) }
  const openEditProp = (p) => { setPropForm({ ...p }); setEditingProp(p); setShowPropForm(true) }

  useEffect(() => { load() }, [id])

  const save = async () => {
    setSaving(true)
    try {
      const payload = { ...form }
      // derive name from first/last if set
      const parts = [payload.first_name, payload.last_name].filter(Boolean).join(' ')
      if (parts) payload.name = parts
      await patch(`/api/clients/${id}`, payload)
      await load(); setEditing(false)
    } catch {}
    setSaving(false)
  }

  const sendSms = async () => {
    if (!smsText.trim() || !client?.phone) return
    setSending(true)
    try {
      await post('/api/comms/sms', { to: client.phone, body: smsText, client_id: parseInt(id) })
    } catch {}
    setSmsText('')
    await load()
    setSending(false)
  }

  if (!client) return (
    <div className="flex items-center justify-center h-full text-zinc-500 text-sm">Loading...</div>
  )

  // Revenue from this client
  const totalRevenue = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total || 0), 0)
  const outstanding = invoices.filter(i => ['sent', 'overdue'].includes(i.status)).reduce((s, i) => s + (i.total || 0), 0)
  const completedJobs = jobs.filter(j => j.status === 'completed').length

  // Upcoming and past cleanings
  const todayStr = new Date().toISOString().slice(0, 10)
  const upcomingJobs = jobs
    .filter(j => j.scheduled_date >= todayStr && j.status !== 'cancelled')
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || (a.start_time || '').localeCompare(b.start_time || ''))
  const pastJobs = jobs
    .filter(j => j.scheduled_date < todayStr || j.status === 'cancelled')
    .sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))
  const nextJob = upcomingJobs[0] || null

  const OPP_COLORS = {
    new: 'bg-amber-500/20 text-amber-500',
    qualified: 'bg-blue-500/20 text-blue-400',
    quoted: 'bg-purple-500/20 text-purple-400',
    won: 'bg-green-500/20 text-green-400',
    lost: 'bg-red-500/20 text-red-400',
  }

  // Build activity feed (all records sorted by date)
  const activity = [
    ...jobs.map(j => ({ type: 'job', date: j.created_at, data: j })),
    ...quotes.map(q => ({ type: 'quote', date: q.created_at, data: q })),
    ...invoices.map(i => ({ type: 'invoice', date: i.created_at, data: i })),
    ...messages.map(m => ({ type: 'message', date: m.created_at, data: m })),
    ...opportunities.map(o => ({ type: 'opportunity', date: o.created_at, data: o })),
    ...activities.filter(a => !['email_received'].includes(a.activity_type)).map(a => ({ type: 'activity_log', date: a.created_at, data: a })),
    ...emails.map(e => ({ type: 'email', date: e.date, data: e })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-zinc-200 px-4 sm:px-6 py-4 shrink-0">
        <button onClick={() => navigate('/clients')}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-500 mb-3 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Clients
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-blue-500/10 flex items-center justify-center shrink-0">
              <span className="text-blue-500 font-bold text-xl">{(client.first_name || client.name)[0]?.toUpperCase()}</span>
            </div>
            <div>
              {editing ? (
                <div className="flex gap-2">
                  <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                    placeholder="First"
                    className="text-xl font-bold bg-zinc-100 border border-zinc-300 rounded-lg px-3 py-1 text-zinc-900 focus:outline-none focus:border-blue-500 w-32" />
                  <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                    placeholder="Last"
                    className="text-xl font-bold bg-zinc-100 border border-zinc-300 rounded-lg px-3 py-1 text-zinc-900 focus:outline-none focus:border-blue-500 w-32" />
                </div>
              ) : (
                <h1 className="text-xl font-bold text-zinc-900">{client.name}</h1>
              )}
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {client.phone && <span className="flex items-center gap-1 text-sm text-zinc-400"><Phone className="w-3.5 h-3.5" />{client.phone}</span>}
                {client.email && <span className="flex items-center gap-1 text-sm text-zinc-400"><Mail className="w-3.5 h-3.5" />{client.email}</span>}
                {(client.city || client.address) && (
                  <span className="flex items-center gap-1 text-sm text-zinc-400">
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
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm transition-colors">
                  <Save className="w-3.5 h-3.5" />{saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => { setEditing(false); setForm(client) }}
                  className="p-1.5 text-zinc-500 hover:text-zinc-500 rounded-lg hover:bg-zinc-100">
                  <X className="w-4 h-4" />
                </button>
              </>
            ) : (
              <button onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-3 py-1.5 rounded-lg text-sm transition-colors">
                <Edit2 className="w-3.5 h-3.5" /> Edit
              </button>
            )}
          </div>
        </div>

        {/* Stats bar — 4 consolidated stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-zinc-200">
          {/* Upcoming */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="text-xs text-blue-600 font-medium">Upcoming</div>
            <div className="text-lg font-bold text-blue-700 mt-1">{visitStats?.upcoming ?? upcomingJobs.length}</div>
            {nextJob && <div className="text-xs text-blue-600 mt-1">Next: {new Date(nextJob.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>}
          </div>

          {/* Revenue */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <div className="text-xs text-green-600 font-medium">Revenue</div>
            <div className="text-lg font-bold text-green-700 mt-1">${totalRevenue.toFixed(0)}</div>
            {completedJobs > 0 && <div className="text-xs text-green-600 mt-1">{completedJobs} job{completedJobs !== 1 ? 's' : ''} done</div>}
          </div>

          {/* Outstanding */}
          <div className={`border rounded-lg p-3 ${outstanding > 0 ? 'bg-amber-50 border-amber-200' : 'bg-zinc-50 border-zinc-200'}`}>
            <div className={`text-xs font-medium ${outstanding > 0 ? 'text-amber-600' : 'text-zinc-600'}`}>Outstanding</div>
            <div className={`text-lg font-bold mt-1 ${outstanding > 0 ? 'text-amber-700' : 'text-zinc-700'}`}>${outstanding.toFixed(0)}</div>
            {outstanding > 0 && <div className="text-xs text-amber-600 mt-1">{invoices.filter(i => ['sent', 'overdue'].includes(i.status)).length} unpaid</div>}
          </div>

          {/* GCal */}
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3">
            <div className="text-xs text-indigo-600 font-medium">GCal</div>
            <div className="text-sm font-mono text-indigo-700 mt-1">
              <span>● {visitStats?.gcal_synced ?? 0} synced</span>
              <br />
              <span>✓ {visitStats?.invites_sent ?? 0} sent</span>
            </div>
          </div>
        </div>

        {/* Upcoming cleanings banner */}
        {upcomingJobs.length > 0 && (
          <div className="mt-4 pt-4 border-t border-zinc-200">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-4 h-4 text-blue-500" />
              <span className="text-xs font-semibold text-zinc-600 uppercase tracking-wide">Upcoming Cleanings</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {upcomingJobs.slice(0, 5).map(j => {
                const typeColor = j.job_type === 'str_turnover' ? 'border-orange-400/30 bg-orange-500/10' : j.job_type === 'commercial' ? 'border-green-400/30 bg-green-500/10' : 'border-blue-400/30 bg-blue-500/10'
                const textColor = j.job_type === 'str_turnover' ? 'text-orange-600' : j.job_type === 'commercial' ? 'text-green-600' : 'text-blue-600'
                return (
                  <div key={j.id} className={`flex-shrink-0 ${typeColor} border rounded-lg px-3 py-2 min-w-[140px]`}>
                    <div className={`text-xs font-semibold ${textColor}`}>
                      {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </div>
                    <div className={`text-[11px] ${textColor} mt-0.5`}>{j.start_time} – {j.end_time}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{j.property_name || j.title}</div>
                    {j.gcal_event_id && <span className="text-[9px] text-indigo-400 mt-0.5">● GCal</span>}
                  </div>
                )
              })}
              {upcomingJobs.length > 5 && (
                <button onClick={() => setTab('jobs')} className="flex-shrink-0 flex items-center text-xs text-blue-600 hover:text-blue-600 px-2">
                  +{upcomingJobs.length - 5} more <ChevronRight className="w-3 h-3 ml-0.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Inline contact form — for missing phone/email */}
        {(!client.phone || !client.email) && (
          <div className="mt-4 pt-4 border-t border-amber-200 bg-amber-50 rounded-lg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 flex-1 min-w-0">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-amber-900 mb-2">Missing contact info</div>
                  <div className="flex gap-2 flex-wrap">
                    {!client.phone && (
                      <input
                        type="tel"
                        placeholder="Phone"
                        onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                        className={`text-xs px-2 py-1.5 rounded border border-amber-300 bg-white focus:outline-none focus:border-amber-500 flex-1 min-w-[140px] ${INPUT_CLASS.split(' ').join(' ')}`}
                        style={{width: '160px'}}
                      />
                    )}
                    {!client.email && (
                      <input
                        type="email"
                        placeholder="Email"
                        onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                        className={`text-xs px-2 py-1.5 rounded border border-amber-300 bg-white focus:outline-none focus:border-amber-500 flex-1 min-w-[140px] ${INPUT_CLASS.split(' ').join(' ')}`}
                        style={{width: '160px'}}
                      />
                    )}
                    <button
                      onClick={async () => {
                        const updates = {}
                        if (!client.phone && form.phone) updates.phone = form.phone
                        if (!client.email && form.email) updates.email = form.email
                        if (Object.keys(updates).length > 0) {
                          try {
                            await patch(`/api/clients/${id}`, updates)
                            await load()
                          } catch (e) {
                            console.error('Failed to save contact info:', e)
                          }
                        }
                      }}
                      className="text-xs bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded font-medium transition-colors shrink-0"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setForm(f => ({ ...f, phone: client.phone, email: client.email }))}
                className="text-amber-600 hover:text-amber-700 p-1 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3 bg-white/50 border-b border-zinc-200 shrink-0">
        <span className="text-xs text-zinc-500 mr-1">Quick:</span>
        <button onClick={() => navigate(`/quoting`)}
          className="flex items-center gap-1.5 text-xs bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-3 py-1.5 rounded-lg transition-colors">
          <FileText className="w-3.5 h-3.5 text-blue-400" /> New Quote
        </button>
        <button onClick={() => navigate(`/scheduling?client_id=${id}`)}
          className="flex items-center gap-1.5 text-xs bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-3 py-1.5 rounded-lg transition-colors">
          <Calendar className="w-3.5 h-3.5 text-blue-500" /> Schedule Job
        </button>
        <button onClick={() => navigate(`/invoicing`)}
          className="flex items-center gap-1.5 text-xs bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-3 py-1.5 rounded-lg transition-colors">
          <Receipt className="w-3.5 h-3.5 text-green-400" /> New Invoice
        </button>
        <button onClick={() => setTab('messages')}
          className="flex items-center gap-1.5 text-xs bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-3 py-1.5 rounded-lg transition-colors">
          <MessageSquare className="w-3.5 h-3.5 text-purple-400" /> Send SMS
        </button>
      </div>

      {/* Tabs — 5 consolidated tabs (Overview, Schedule, Activity, Messages, Money) */}
      <div className="flex border-b border-zinc-200 px-6 bg-white/30 shrink-0 overflow-x-auto">
        <Tab label="Overview" icon={Edit2} active={['details', 'crm', 'properties'].includes(tab)} count={0} onClick={() => setTab('details')} />
        <Tab label="Schedule" icon={Calendar} active={['calendar', 'recurring', 'jobs'].includes(tab)} count={upcomingJobs.length} onClick={() => setTab('calendar')} />
        <Tab label="Activity" icon={Clock} active={['activity', 'emails'].includes(tab)} count={activity.length} onClick={() => setTab('activity')} />
        <Tab label="Messages" icon={MessageSquare} active={tab === 'messages'} count={messages.length} onClick={() => setTab('messages')} />
        <Tab label="Money" icon={DollarSign} active={['quotes', 'invoices', 'opportunities'].includes(tab)} count={quotes.length + invoices.length} onClick={() => setTab('quotes')} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 scrollbar-thin">

        {/* CRM Summary */}
        {tab === 'crm' && (
          <ClientCRMSummary clientId={id} />
        )}

        {/* Activity feed */}
        {tab === 'activity' && (
          <div className="max-w-2xl space-y-3">
            {activity.length === 0 && <p className="text-zinc-500 text-sm text-center py-10">No activity yet</p>}
            {activity.map((item, i) => (
              <div key={i} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    item.type === 'job'          ? 'bg-blue-500/10' :
                    item.type === 'quote'        ? 'bg-blue-600/20' :
                    item.type === 'invoice'      ? 'bg-green-50' :
                    item.type === 'opportunity'  ? 'bg-amber-50' :
                    item.type === 'email'        ? 'bg-cyan-50' :
                    item.type === 'activity_log' ? 'bg-zinc-100' :
                                                   'bg-purple-50'
                  }`}>
                    {item.type === 'job'          && <Calendar className="w-3.5 h-3.5 text-blue-500" />}
                    {item.type === 'quote'        && <FileText className="w-3.5 h-3.5 text-blue-400" />}
                    {item.type === 'invoice'      && <Receipt className="w-3.5 h-3.5 text-green-400" />}
                    {item.type === 'message'      && <MessageSquare className="w-3.5 h-3.5 text-purple-400" />}
                    {item.type === 'opportunity'  && <TrendingUp className="w-3.5 h-3.5 text-amber-500" />}
                    {item.type === 'email'        && <Mail className="w-3.5 h-3.5 text-cyan-500" />}
                    {item.type === 'activity_log' && <Zap className="w-3.5 h-3.5 text-zinc-400" />}
                  </div>
                  {i < activity.length - 1 && <div className="w-px flex-1 bg-zinc-100 mt-1" />}
                </div>
                <div className="flex-1 pb-4 min-w-0">
                  <div className="bg-white border border-zinc-200 rounded-xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {item.type === 'job' && (
                          <>
                            <div className="text-sm font-medium text-zinc-900">{item.data.title}</div>
                            <div className="text-xs text-zinc-400 mt-0.5">{item.data.scheduled_date} · {item.data.start_time}–{item.data.end_time}</div>
                          </>
                        )}
                        {item.type === 'quote' && (
                          <>
                            <div className="text-sm font-medium text-zinc-900">Quote — ${item.data.total?.toFixed(2)}</div>
                            <div className="text-xs text-zinc-400 mt-0.5">{item.data.items?.length || 0} items</div>
                          </>
                        )}
                        {item.type === 'invoice' && (
                          <>
                            <div className="text-sm font-medium text-zinc-900">{item.data.invoice_number} — ${item.data.total?.toFixed(2)}</div>
                            <div className="text-xs text-zinc-400 mt-0.5">Due {item.data.due_date || 'N/A'}</div>
                          </>
                        )}
                        {item.type === 'message' && (
                          <>
                            <div className="text-sm text-zinc-500">{item.data.body}</div>
                            <div className="text-xs text-zinc-500 mt-0.5">{item.data.direction} · {item.data.channel}</div>
                          </>
                        )}
                        {item.type === 'opportunity' && (
                          <>
                            <div className="text-sm font-medium text-zinc-900">{item.data.title}</div>
                            <div className="text-xs text-zinc-400 mt-0.5">
                              {item.data.amount != null && <span className="text-emerald-600 font-medium">${item.data.amount.toLocaleString()}</span>}
                              {item.data.service_type && <span className="ml-2">{item.data.service_type.replace('_', ' ')}</span>}
                            </div>
                          </>
                        )}
                        {item.type === 'email' && (
                          <>
                            <div className="text-sm font-medium text-zinc-900">{item.data.subject || '(no subject)'}</div>
                            <div className="text-xs text-zinc-400 mt-0.5">from {item.data.from_name || item.data.from_email}</div>
                            {item.data.snippet && <div className="text-xs text-zinc-400 mt-1 truncate">{item.data.snippet.slice(0, 120)}</div>}
                          </>
                        )}
                        {item.type === 'activity_log' && (
                          <>
                            <div className="text-sm text-zinc-500">{item.data.summary}</div>
                            <div className="text-xs text-zinc-400 mt-0.5">{item.data.activity_type.replace(/_/g, ' ')}</div>
                          </>
                        )}
                               </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                          item.type === 'job'          ? JOB_COLORS[item.data.status] :
                          item.type === 'quote'        ? QUOTE_COLORS[item.data.status] :
                          item.type === 'invoice'      ? INVOICE_COLORS[item.data.status] :
                          item.type === 'opportunity'  ? (OPP_COLORS[item.data.stage] || 'bg-amber-500/20 text-amber-500') :
                          item.type === 'email'        ? 'bg-cyan-500/20 text-cyan-500' :
                          item.type === 'activity_log' ? 'bg-zinc-200 text-zinc-500' :
                          'bg-purple-500/20 text-purple-400'
                        }`}>
                          {item.type === 'message' ? item.data.direction :
                           item.type === 'opportunity' ? item.data.stage :
                           item.type === 'email' ? 'email' :
                           item.type === 'activity_log' ? item.data.activity_type?.split('_')[0] :
                           item.data.status?.replace('_', ' ')}
                        </span>
                        <span className="text-xs text-zinc-500">
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

        {/* Calendar — Twenty-style mini calendar + event list */}
        {tab === 'calendar' && (
          <ClientCalendarTab
            jobs={jobs}
            upcomingJobs={profileVisits.upcoming.length > 0 ? profileVisits.upcoming : upcomingJobs}
            pastJobs={profileVisits.past.length > 0 ? profileVisits.past : pastJobs}
            navigate={navigate}
            clientId={id}
            visitStats={visitStats}
          />
        )}

        {/* Properties */}
        {tab === 'properties' && (
          <div className="max-w-2xl">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-zinc-400">{properties.length} propert{properties.length !== 1 ? 'ies' : 'y'}</p>
              <button onClick={openNewProp}
                className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add Property
              </button>
            </div>

            {/* Property form */}
            {showPropForm && (
              <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-4 space-y-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-zinc-900">{editingProp ? 'Edit Property' : 'New Property'}</span>
                  <button onClick={() => setShowPropForm(false)} className="text-zinc-500 hover:text-zinc-500"><X className="w-4 h-4" /></button>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Property Name *</label>
                  <input value={propForm.name || ''} onChange={e => setPropForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Main Home, Lake House"
                    className={INPUT_CLASS} />
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Type</label>
                  <div className="flex gap-2">
                    {[['residential','Residential'],['commercial','Commercial'],['str','STR / Airbnb']].map(([val, label]) => (
                      <button key={val} onClick={() => setPropForm(f => ({ ...f, property_type: val }))}
                        className={`flex-1 py-1.5 rounded-lg text-xs transition-colors ${propForm.property_type === val ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Address</label>
                  <input value={propForm.address || ''} onChange={e => setPropForm(f => ({ ...f, address: e.target.value }))}
                    className={INPUT_CLASS} />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-xs text-zinc-400 mb-1">City</label>
                    <input value={propForm.city || ''} onChange={e => setPropForm(f => ({ ...f, city: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                  <div className="w-16">
                    <label className="block text-xs text-zinc-400 mb-1">State</label>
                    <input value={propForm.state || ''} onChange={e => setPropForm(f => ({ ...f, state: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                  <div className="w-24">
                    <label className="block text-xs text-zinc-400 mb-1">ZIP</label>
                    <input value={propForm.zip_code || ''} onChange={e => setPropForm(f => ({ ...f, zip_code: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                </div>

                <div className="w-40">
                  <label className="block text-xs text-zinc-400 mb-1">Default Duration (hrs)</label>
                  <input type="number" step="0.5" min="0.5" value={propForm.default_duration_hours || 3}
                    onChange={e => setPropForm(f => ({ ...f, default_duration_hours: parseFloat(e.target.value) }))}
                    className={INPUT_CLASS} />
                </div>

                {propForm.property_type === 'str' && (
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Airbnb iCal URL</label>
                    <input value={propForm.ical_url || ''} onChange={e => setPropForm(f => ({ ...f, ical_url: e.target.value }))}
                      placeholder="https://www.airbnb.com/calendar/ical/..."
                      className={INPUT_CLASS} />
                  </div>
                )}

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Notes</label>
                  <textarea value={propForm.notes || ''} onChange={e => setPropForm(f => ({ ...f, notes: e.target.value }))} rows={2}
                    className={INPUT_CLASS + " resize-none"} />
                </div>

                <div className="flex gap-2 pt-1">
                  {editingProp && (
                    <button onClick={() => deleteProp(editingProp.id)}
                      className="px-3 py-2 text-sm text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 rounded-lg transition-colors">
                      Delete
                    </button>
                  )}
                  <button onClick={saveProp} disabled={savingProp || !propForm.name}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                    {savingProp ? 'Saving...' : 'Save Property'}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {properties.length === 0 && !showPropForm && (
                <p className="text-zinc-500 text-sm text-center py-10">No properties yet</p>
              )}
              {properties.map(p => {
                return (
                  <div key={p.id}
                    className="bg-white border border-zinc-200 hover:border-zinc-200 rounded-xl p-4 cursor-pointer transition-colors"
                    onClick={() => openEditProp(p)}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0 mt-0.5">
                          <Home className="w-4 h-4 text-zinc-400" />
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-zinc-900 text-sm">{p.name}</div>
                          {p.address && (
                            <div className="text-xs text-zinc-400 flex items-center gap-1 mt-0.5">
                              <MapPin className="w-3 h-3 shrink-0" />
                              {[p.address, p.city, p.state].filter(Boolean).join(', ')}
                              {p.zip_code ? ` ${p.zip_code}` : ''}
                            </div>
                          )}
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${PROPERTY_TYPE_COLORS[p.property_type] || PROPERTY_TYPE_COLORS.residential}`}>
                              {PROPERTY_TYPE_LABELS[p.property_type] || p.property_type}
                            </span>
                            <span className="text-[10px] text-zinc-500">{p.default_duration_hours}h default</span>
                            {p.ical_url && <span className="text-[10px] text-orange-400">iCal linked</span>}
                          </div>
                        </div>
                      </div>
                      <Edit2 className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-1" />
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
              <p className="text-sm text-zinc-400">{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</p>
              <a href="/recurring"
                className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add Schedule
              </a>
            </div>
            {schedules.length === 0 && (
              <div className="text-center py-10">
                <RefreshCw className="w-8 h-8 mx-auto mb-2 text-zinc-600" />
                <p className="text-zinc-500 text-sm mb-3">No recurring schedules</p>
                <a href="/recurring" className="text-xs text-blue-500 hover:text-sky-300">Set one up on the Recurring page</a>
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
                  <div key={s.id} className={`bg-white border rounded-xl p-4 ${s.active ? 'border-zinc-200' : 'border-zinc-200 opacity-60'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-zinc-900">{s.title}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${typeColors[s.job_type] || typeColors.residential}`}>
                            {s.job_type}
                          </span>
                          {!s.active && <span className="text-[10px] text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded-full">Paused</span>}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {FREQ[s.frequency]} · {s.frequency !== 'monthly' ? `${DAYS_S[s.day_of_week]}s` : `day ${s.day_of_month}`} · {s.start_time}–{s.end_time}
                        </div>
                        {s.address && <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1"><MapPin className="w-2.5 h-2.5" />{s.address}</div>}
                      </div>
                      <a href="/recurring" className="text-xs text-zinc-500 hover:text-zinc-500 bg-zinc-100 hover:bg-zinc-200 px-2.5 py-1.5 rounded-lg transition-colors shrink-0">
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
          <div className="max-w-2xl space-y-5">
            {jobs.length === 0 && <p className="text-zinc-500 text-sm text-center py-10">No jobs yet</p>}

            {/* Upcoming */}
            {upcomingJobs.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Calendar className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-semibold text-zinc-600 uppercase tracking-wide">Upcoming ({upcomingJobs.length})</span>
                </div>
                <div className="space-y-2">
                  {upcomingJobs.map(j => (
                    <div key={j.id} className="bg-white border border-blue-400/30 rounded-xl p-4 flex items-center gap-4">
                      <div className="text-center w-16 shrink-0">
                        <div className="text-sm font-semibold text-blue-600">
                          {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                        <div className="text-xs text-blue-500">{j.start_time}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-zinc-900">{j.title}</div>
                        {j.address && <div className="text-xs text-zinc-400 flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" />{j.address}</div>}
                      </div>
                      <div className="flex items-center gap-2">
                        {j.dispatched && <span className="text-xs bg-purple-100 text-purple-700 border border-purple-200 px-2 py-0.5 rounded-full">Dispatched</span>}
                        <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${JOB_COLORS[j.status]}`}>{j.status.replace('_', ' ')}</span>
                        <OpportunityLinker
                          clientId={id}
                          itemType="job"
                          itemId={j.id}
                          itemName={j.title}
                          currentOpportunityId={j.opportunity_id}
                          onLinked={() => load()}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Past */}
            {pastJobs.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-3">Past ({pastJobs.length})</p>
                <div className="space-y-2">
                  {pastJobs.map(j => (
                    <div key={j.id} className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 flex items-center gap-4">
                      <div className="text-center w-16 shrink-0">
                        <div className="text-sm font-medium text-zinc-500">
                          {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                        <div className="text-xs text-zinc-400">{j.start_time}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-zinc-500">{j.title}</div>
                        {j.address && <div className="text-xs text-zinc-400 flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" />{j.address}</div>}
                      </div>
                      <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${JOB_COLORS[j.status]}`}>{j.status.replace('_', ' ')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Quotes */}
        {tab === 'quotes' && (
          <div className="max-w-2xl space-y-2">
            {quotes.length === 0 && <p className="text-zinc-500 text-sm text-center py-10">No quotes yet</p>}
            {quotes.map(q => (
              <div key={q.id} className="bg-white border border-zinc-200 rounded-xl p-4 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-zinc-900">${q.total?.toFixed(2)}</div>
                  <div className="text-xs text-zinc-400 mt-0.5">{q.items?.length || 0} items · {new Date(q.created_at).toLocaleDateString()}</div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${QUOTE_COLORS[q.status]}`}>{q.status}</span>
                  <OpportunityLinker
                    clientId={id}
                    itemType="quote"
                    itemId={q.id}
                    itemName={`Quote $${q.total?.toFixed(2)}`}
                    currentOpportunityId={q.opportunity_id}
                    onLinked={() => load()}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Invoices */}
        {tab === 'invoices' && (
          <div className="max-w-2xl space-y-2">
            {invoices.length === 0 && <p className="text-zinc-500 text-sm text-center py-10">No invoices yet</p>}
            {invoices.map(inv => (
              <div key={inv.id} className="bg-white border border-zinc-200 rounded-xl p-4 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-zinc-900">{inv.invoice_number}</div>
                  <div className="text-xs text-zinc-400 mt-0.5">Due {inv.due_date || 'N/A'} · ${inv.total?.toFixed(2)}</div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${INVOICE_COLORS[inv.status]}`}>{inv.status}</span>
                  <OpportunityLinker
                    clientId={id}
                    itemType="invoice"
                    itemId={inv.id}
                    itemName={inv.invoice_number}
                    currentOpportunityId={inv.opportunity_id}
                    onLinked={() => load()}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Messages */}
        {tab === 'messages' && (
          <div className="max-w-2xl">
            {/* SMS compose */}
            {client.phone && (
              <div className="bg-white border border-zinc-200 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <MessageSquare className="w-4 h-4 text-purple-400" />
                  <span className="text-sm font-medium text-zinc-900">Send SMS to {client.phone}</span>
                </div>
                <div className="flex gap-2">
                  <input value={smsText} onChange={e => setSmsText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendSms()}
                    placeholder="Type a message..."
                    className="flex-1 bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
                  <button onClick={sendSms} disabled={sending || !smsText.trim()}
                    className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-200 px-4 py-2 rounded-lg text-sm transition-colors">
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
              {messages.length === 0 && <p className="text-zinc-500 text-sm text-center py-8">No messages yet</p>}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-sm px-4 py-2.5 rounded-2xl text-sm ${
                    m.direction === 'outbound'
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-zinc-100 text-gray-800 rounded-bl-sm'
                  }`}>
                    <div>{m.body}</div>
                    <div className={`text-xs mt-1 ${m.direction === 'outbound' ? 'text-sky-200' : 'text-zinc-500'}`}>
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
            <div className="bg-white border border-zinc-200 rounded-xl p-6 space-y-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1">Contact</div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">First Name</label>
                  <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                    className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-1.5 text-sm text-zinc-900 focus:outline-none focus:border-gray-400" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">Last Name</label>
                  <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                    className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-1.5 text-sm text-zinc-900 focus:outline-none focus:border-gray-400" />
                </div>
              </div>
              {[
                { label: 'Phone', key: 'phone' },
                { label: 'Email', key: 'email' },
                { label: 'Lead Source', key: 'source' },
              ].map(({ label, key }) => (
                <div key={key} className="flex items-center gap-4">
                  <span className="text-xs text-zinc-500 w-24 shrink-0">{label}</span>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 bg-white border border-zinc-200 rounded-lg px-3 py-1.5 text-sm text-zinc-900 focus:outline-none focus:border-gray-400" />
                </div>
              ))}
              <div className="flex items-center gap-4">
                <span className="text-xs text-zinc-500 w-24 shrink-0">Status</span>
                <select value={form.status || 'lead'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  className="flex-1 bg-white border border-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none">
                  <option value="lead">Lead</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div className="flex items-start gap-4">
                <span className="text-xs text-zinc-500 w-24 shrink-0 pt-2">Notes</span>
                <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                  className="flex-1 bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:border-gray-400 resize-none" />
              </div>
            </div>

            {/* Service address */}
            <div className="bg-white border border-zinc-200 rounded-xl p-6 space-y-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1">Service Address</div>
              {[
                { label: 'Street', key: 'address' },
                { label: 'City', key: 'city' },
                { label: 'State', key: 'state' },
                { label: 'ZIP', key: 'zip_code' },
              ].map(({ label, key }) => (
                <div key={key} className="flex items-center gap-4">
                  <span className="text-xs text-zinc-500 w-24 shrink-0">{label}</span>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 bg-white border border-zinc-200 rounded-lg px-3 py-1.5 text-sm text-zinc-900 focus:outline-none focus:border-gray-400" />
                </div>
              ))}
            </div>

            {/* Billing address */}
            <div className="bg-white border border-zinc-200 rounded-xl p-6 space-y-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1">Billing Address</div>
              <p className="text-xs text-zinc-400 -mt-2">Leave blank to use service address on invoices</p>
              {[
                { label: 'Street', key: 'billing_address' },
                { label: 'City', key: 'billing_city' },
                { label: 'State', key: 'billing_state' },
                { label: 'ZIP', key: 'billing_zip' },
              ].map(({ label, key }) => (
                <div key={key} className="flex items-center gap-4">
                  <span className="text-xs text-zinc-500 w-24 shrink-0">{label}</span>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 bg-white border border-zinc-200 rounded-lg px-3 py-1.5 text-sm text-zinc-900 focus:outline-none focus:border-gray-400" />
                </div>
              ))}
            </div>

            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-200 px-5 py-2 rounded-lg text-sm font-medium transition-colors">
              <Save className="w-4 h-4" />{saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}

        {/* Opportunities */}
        {tab === 'opportunities' && (
          <div className="max-w-2xl space-y-3">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-zinc-400">{opportunities.length} opportunit{opportunities.length !== 1 ? 'ies' : 'y'}</p>
              <button onClick={() => navigate('/pipeline')}
                className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> New Deal
              </button>
            </div>
            {opportunities.length === 0 && <p className="text-zinc-500 text-sm text-center py-10">No opportunities yet</p>}
            {opportunities.map(opp => (
              <div key={opp.id} className="bg-white border border-zinc-200 rounded-xl p-4 hover:shadow-sm transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-4 h-4 text-amber-500" />
                      <span className="font-medium text-zinc-900">{opp.title}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${OPP_COLORS[opp.stage] || 'bg-zinc-200 text-zinc-500'}`}>
                        {opp.stage}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 text-xs text-zinc-400">
                      {opp.service_type && <span className="capitalize">{opp.service_type.replace('_', ' ')}</span>}
                      {opp.owner && <span>Owner: {opp.owner}</span>}
                      {opp.close_date && <span>Close: {opp.close_date}</span>}
                      {opp.probability != null && <span>{opp.probability}% likely</span>}
                    </div>
                    {opp.notes && <p className="text-xs text-zinc-400 mt-2 italic">{opp.notes}</p>}
                  </div>
                  {opp.amount != null && (
                    <span className="text-lg font-bold text-emerald-600 shrink-0">${opp.amount.toLocaleString()}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Emails */}
        {tab === 'emails' && (
          <div className="max-w-2xl space-y-3">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-zinc-400">{emails.length} email{emails.length !== 1 ? 's' : ''} from this contact</p>
            </div>
            {emails.length === 0 && (
              <div className="text-center py-10">
                <Mail className="w-10 h-10 text-zinc-300 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">No emails found for this client</p>
                <p className="text-xs text-zinc-400 mt-1">Emails will appear here when Gmail syncs match this contact</p>
              </div>
            )}
            {emails.map((em, i) => (
              <div key={em.message_id || i} className="bg-white border border-zinc-200 rounded-xl p-4 hover:shadow-sm transition-all">
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${em.is_read ? 'bg-zinc-100' : 'bg-cyan-100'}`}>
                    <Mail className={`w-4 h-4 ${em.is_read ? 'text-zinc-400' : 'text-cyan-600'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm truncate flex-1 ${em.is_read ? 'text-zinc-600' : 'font-semibold text-zinc-900'}`}>
                        {em.subject || '(no subject)'}
                      </span>
                      <span className="text-[10px] text-zinc-400 shrink-0">
                        {em.date ? new Date(em.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-400 mt-0.5">{em.from_name || em.from_email}</div>
                    {em.snippet && <p className="text-xs text-zinc-500 mt-1.5 line-clamp-2">{em.snippet}</p>}
                    {em.has_attachments && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 mt-1.5 bg-zinc-50 px-2 py-0.5 rounded-md">
                        Attachments
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>

      <AgentWidget
        pageContext="clients"
        prompts={[
          `Tell me about this client's history`,
          'What services should I upsell to this client?',
          'Draft a follow-up message for this client',
        ]}
      />
    </div>
  )
}


/* ─────────── Twenty-style Client Calendar Tab ─────────── */

const MINI_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

const JOB_TYPE_DOT = {
  residential:  'bg-blue-500',
  commercial:   'bg-green-500',
  str_turnover: 'bg-orange-500',
}

const JOB_TYPE_LABEL = {
  residential:  'Residential',
  commercial:   'Commercial',
  str_turnover: 'STR Turnover',
}

const STATUS_PILL = {
  scheduled:   'bg-blue-50 text-blue-700 border-blue-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  completed:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled:   'bg-zinc-100 text-zinc-500 border-zinc-200',
}

function ClientCalendarTab({ jobs, upcomingJobs, pastJobs, navigate, clientId, visitStats }) {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [selectedDate, setSelectedDate] = useState(null)

  const todayStr = now.toISOString().slice(0, 10)

  // Build map of date → jobs for this client
  const jobsByDate = {}
  jobs.forEach(j => {
    if (!j.scheduled_date) return
    if (!jobsByDate[j.scheduled_date]) jobsByDate[j.scheduled_date] = []
    jobsByDate[j.scheduled_date].push(j)
  })

  // Calendar grid math
  const firstDay = new Date(year, month, 1)
  const lastDay  = new Date(year, month + 1, 0)
  const startDow = firstDay.getDay()
  const totalDays = lastDay.getDate()

  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= totalDays; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push(iso)
  }
  while (cells.length % 7 !== 0) cells.push(null)

  const prevMonth = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const nextMonth = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  // Jobs to show in the event list below the calendar
  const selectedDayJobs = selectedDate ? (jobsByDate[selectedDate] || []) : null
  const listJobs = selectedDayJobs !== null ? selectedDayJobs : upcomingJobs

  return (
    <div className="max-w-2xl space-y-5">
      {/* GCal sync summary */}
      {visitStats && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-indigo-500" />
            <span className="text-sm font-medium text-indigo-700">Google Calendar</span>
          </div>
          <div className="flex gap-4 text-xs">
            <span className="text-indigo-600"><strong>{visitStats.gcal_synced}</strong> synced</span>
            <span className="text-emerald-600"><strong>{visitStats.invites_sent}</strong> invites sent</span>
            <span className="text-blue-600"><strong>{visitStats.upcoming}</strong> upcoming</span>
            <span className="text-zinc-500"><strong>{visitStats.completed}</strong> completed</span>
            {visitStats.cancelled > 0 && <span className="text-red-500"><strong>{visitStats.cancelled}</strong> cancelled</span>}
          </div>
        </div>
      )}

      {/* Mini month calendar */}
      <div className="bg-white border border-zinc-200 rounded-xl p-5">
        {/* Month nav */}
        <div className="flex items-center justify-between mb-3">
          <button onClick={prevMonth} className="p-1 hover:bg-zinc-100 rounded-lg text-zinc-400 hover:text-zinc-500">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-gray-800">{MONTH_NAMES[month]} {year}</span>
          <button onClick={nextMonth} className="p-1 hover:bg-zinc-100 rounded-lg text-zinc-400 hover:text-zinc-500">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {MINI_DAYS.map(d => (
            <div key={d} className="text-center text-[10px] font-medium text-zinc-400 py-1">{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((date, i) => {
            if (!date) return <div key={i} className="h-9" />

            const dayNum = parseInt(date.slice(8))
            const isToday = date === todayStr
            const isSelected = date === selectedDate
            const dayJobs = jobsByDate[date] || []
            const hasJobs = dayJobs.length > 0

            return (
              <button
                key={date}
                onClick={() => setSelectedDate(selectedDate === date ? null : date)}
                className={`h-9 flex flex-col items-center justify-center rounded-lg text-xs transition-all relative ${
                  isSelected
                    ? 'bg-blue-600 text-white'
                    : isToday
                    ? 'bg-blue-500/10 text-blue-600 font-semibold'
                    : hasJobs
                    ? 'hover:bg-zinc-100 text-gray-800 font-medium'
                    : 'hover:bg-zinc-50 text-zinc-400'
                }`}
              >
                {dayNum}
                {/* Job indicator dots */}
                {hasJobs && (
                  <div className="flex gap-0.5 mt-0.5">
                    {dayJobs.slice(0, 3).map((j, idx) => (
                      <span
                        key={idx}
                        className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white/70' : (JOB_TYPE_DOT[j.job_type] || 'bg-blue-500')}`}
                      />
                    ))}
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 mt-3 pt-3 border-t border-gray-100">
          {Object.entries(JOB_TYPE_DOT).map(([type, color]) => (
            <span key={type} className="flex items-center gap-1 text-[10px] text-zinc-400">
              <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
              {JOB_TYPE_LABEL[type]}
            </span>
          ))}
        </div>
      </div>

      {/* Event list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
            {selectedDate
              ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Upcoming Cleanings'}
          </h3>
          {selectedDate && (
            <button onClick={() => setSelectedDate(null)} className="text-[10px] text-zinc-400 hover:text-zinc-500">
              Show all upcoming
            </button>
          )}
        </div>

        {listJobs.length === 0 ? (
          <div className="text-center py-10 bg-white border border-zinc-200 rounded-xl">
            <Calendar className="w-8 h-8 mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-zinc-400">
              {selectedDate ? 'No cleanings on this day' : 'No upcoming cleanings'}
            </p>
            <button onClick={() => navigate(`/scheduling?client_id=${clientId}`)}
              className="mt-3 text-xs text-blue-600 hover:text-blue-600 font-medium">
              + Schedule a cleaning
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {listJobs.map(j => {
              const dotColor = JOB_TYPE_DOT[j.job_type] || 'bg-blue-500'
              const statusPill = STATUS_PILL[j.status] || STATUS_PILL.scheduled
              const isPast = j.scheduled_date < todayStr

              return (
                <div key={j.id} className={`bg-white border border-zinc-200 rounded-xl p-4 flex items-start gap-3 transition-colors hover:border-zinc-300 ${isPast ? 'opacity-60' : ''}`}>
                  {/* Color bar */}
                  <div className={`w-1 self-stretch rounded-full shrink-0 ${dotColor}`} />

                  {/* Date block */}
                  <div className="text-center w-12 shrink-0 pt-0.5">
                    <div className="text-xs font-bold text-gray-800">
                      {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                    </div>
                  </div>

                  {/* Job info */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-zinc-900 truncate">{j.title}</div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {j.start_time} – {j.end_time}
                      </span>
                      <span className="text-[10px] text-gray-300">|</span>
                      <span>{JOB_TYPE_LABEL[j.job_type] || j.job_type}</span>
                    </div>
                    {j.property_name && (
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-indigo-500 truncate">
                        <Home className="w-3 h-3 shrink-0" />{j.property_name}
                      </div>
                    )}
                    {j.address && (
                      <div className="flex items-center gap-1 mt-0.5 text-[11px] text-zinc-400 truncate">
                        <MapPin className="w-3 h-3 shrink-0" />{j.address}
                      </div>
                    )}
                  </div>

                  {/* Status + indicators */}
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${statusPill}`}>
                      {j.status?.replace('_', ' ')}
                    </span>
                    <div className="flex gap-1">
                      {j.gcal_event_id && <span title="On Google Calendar" className="w-3.5 h-3.5 rounded-full bg-indigo-100 flex items-center justify-center text-[8px] text-indigo-500 font-bold">G</span>}
                      {j.calendar_invite_sent && <span title="Invite sent" className="w-3.5 h-3.5 rounded-full bg-emerald-100 flex items-center justify-center text-[8px] text-emerald-500 font-bold">✓</span>}
                      {j.dispatched && <span title="Dispatched" className="w-3.5 h-3.5 rounded-full bg-blue-100 flex items-center justify-center text-[8px] text-blue-500 font-bold">D</span>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
