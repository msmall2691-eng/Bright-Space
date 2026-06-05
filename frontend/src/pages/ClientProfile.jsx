import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import AgentWidget from '../components/AgentWidget'
import ClientCRMSummary from '../components/ClientCRMSummary'
import ActivityTimeline from '../components/ActivityTimeline'
import OpportunityLinker from '../components/OpportunityLinker'
import JobCreateModal from '../components/JobCreateModal'
import JobEditModal from '../components/JobEditModal'
import { del, get, post, patch } from "../api"
import { useToast } from '../components/ui/Toast'
import {
  ArrowLeft, Phone, Mail, MapPin, Edit2, Save, X,
  Plus, Calendar, FileText, Receipt, MessageSquare,
  CheckCircle, Clock, AlertCircle, Send, ChevronLeft, ChevronRight, Home, RefreshCw,
  TrendingUp, DollarSign, Target, Inbox, ArrowUpRight, Zap, Trash2
} from 'lucide-react'

const STATUS_COLORS = {
  lead:     'bg-amber-500/15 text-amber-500 border-amber-500/20',
  active:   'bg-emerald-500/15 text-emerald-500 border-emerald-500/20',
  inactive: 'bg-bg-2 text-ink-3 border-hairline',
}

const JOB_COLORS = {
  scheduled:   'bg-blue-500/20 text-blue-400',
  in_progress: 'bg-yellow-500/20 text-yellow-400',
  completed:   'bg-green-500/20 text-green-400',
  cancelled:   'bg-red-500/20 text-red-400',
}

const INVOICE_COLORS = {
  draft:   'bg-ink-3/15 text-ink-3',
  sent:    'bg-blue-500/20 text-blue-400',
  paid:    'bg-green-500/20 text-green-400',
  overdue: 'bg-red-500/20 text-red-400',
}

const QUOTE_COLORS = {
  draft:    'bg-ink-3/15 text-ink-3',
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

const INPUT_CLASS = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none'

function Tab({ label, icon: Icon, active, count, onClick }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? 'border-blue-500 text-blue-500'
          : 'border-transparent text-ink-3 hover:text-ink-3'
      }`}>
      <Icon className="w-4 h-4" />
      {label}
      {count > 0 && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-blue-500/15 text-blue-500' : 'bg-bg-2 text-ink-3'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

export default function ClientProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { toast, ToastContainer } = useToast()

  // Tab redirect for backward compatibility (legacy hash names → current tab keys).
  // 'properties' is its own tab again (PR 1) — no redirect.
  const TAB_REDIRECTS = {
    details: 'overview', crm: 'overview',
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
  const [activityFilter, setActivityFilter] = useState('all')
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [smsText, setSmsText] = useState('')
  const [sending, setSending] = useState(false)
  const [showBilling, setShowBilling] = useState(false)
  // Quick-add contact (banner expands inline so phone/email can be saved
  // without leaving the current tab — particularly important on mobile).
  const [quickContactOpen, setQuickContactOpen] = useState(false)
  const [quickContact, setQuickContact] = useState({ phone: '', email: '' })
  const [quickContactSaving, setQuickContactSaving] = useState(false)
  // Property form state
  const [showPropForm, setShowPropForm] = useState(false)
  const [propForm, setPropForm] = useState({})
  const [editingProp, setEditingProp] = useState(null)
  const [savingProp, setSavingProp] = useState(false)
  const EMPTY_PROP = { name: '', address: '', city: '', state: 'ME', zip_code: '', property_type: 'residential', default_duration_hours: 3, notes: '' }

  // iCal feed management (STR turnover automation)
  const EMPTY_ICAL = { url: '', source: '', checkout_time: '', duration_hours: '', house_code: '', instructions: '' }
  const [icalForm, setIcalForm] = useState(EMPTY_ICAL)
  const [showIcalForm, setShowIcalForm] = useState(false)
  const [syncingPropId, setSyncingPropId] = useState(null)
  const [syncBanner, setSyncBanner] = useState(null)

  // Schedule form state

  // One-off job creation modal
  const [jobModal, setJobModal] = useState(null)  // null | { propertyId?: number }
  // Bumped after add/edit/cancel/invite to force the embedded Google Calendar
  // iframe to reload (Google's embed caches, so a fresh event needs a nudge).
  const [gcalReload, setGcalReload] = useState(0)
  const [editJob, setEditJob] = useState(null)  // appointment being edited in the side panel
  const [commsFilter, setCommsFilter] = useState('all')  // all | sms | email
  const [timelineEvents, setTimelineEvents] = useState([])  // linked Google Calendar events for the timeline

  const [visitStats, setVisitStats] = useState(null)
  const [profileVisits, setProfileVisits] = useState({ upcoming: [], past: [] })

  const load = async () => {
    try {
      // Load client first (blocking)
      const profile = await get(`/api/clients/${id}/profile`).catch(() => null)
      const c = profile || await get(`/api/clients/${id}`)
      setClient(c)

      // Backfill name
      const formFill = { ...c }
      if ((!formFill.first_name || !formFill.first_name.trim())
          && (!formFill.last_name || !formFill.last_name.trim())
          && c.name) {
        const parts = c.name.trim().split(/\s+/)
        formFill.first_name = parts[0] || ''
        formFill.last_name = parts.slice(1).join(' ') || ''
      }
      setForm(formFill)
      const hasBilling = !!(c.billing_address || c.billing_city || c.billing_state || c.billing_zip)
      if (hasBilling) setShowBilling(true)
      if (profile?.visit_stats) setVisitStats(profile.visit_stats)
      if (profile?.upcoming_visits || profile?.past_visits) {
        setProfileVisits({
          upcoming: profile.upcoming_visits || [],
          past: profile.past_visits || [],
        })
      }

      // Load other data in background (non-blocking)
      Promise.all([
        get(`/api/jobs?client_id=${id}`).then(j => setJobs(Array.isArray(j) ? j : [])).catch(() => {}),
        get(`/api/quotes?client_id=${id}`).then(q => setQuotes(Array.isArray(q) ? q : [])).catch(() => {}),
        get(`/api/invoices?client_id=${id}`).then(inv => setInvoices(Array.isArray(inv) ? inv : [])).catch(() => {}),
        // Unified, contact-linked comms: emails + SMS matched by client_id OR
        // the client's email/phone (server-side), split by channel here.
        get(`/api/comms/client/${id}`).then(r => {
          const all = Array.isArray(r?.messages) ? r.messages : []
          setMessages(all.filter(m => m.channel === 'sms'))
          setEmails(all.filter(m => m.channel === 'email').reverse())  // newest first
        }).catch(() => {}),
        get(`/api/properties?client_id=${id}`).then(props => setProperties(Array.isArray(props) ? props : [])).catch(() => {}),
        get(`/api/recurring?client_id=${id}`).then(scheds => setSchedules(Array.isArray(scheds) ? scheds : [])).catch(() => {}),
        get(`/api/opportunities?client_id=${id}`).then(opps => setOpportunities(Array.isArray(opps) ? opps : [])).catch(() => {}),
        get(`/api/activities?client_id=${id}&limit=50`).then(acts => setActivities(Array.isArray(acts) ? acts : [])).catch(() => {}),
        // Linked Google Calendar events — interleaved into the unified timeline.
        get(`/api/jobs/client/${id}/gcal-events`).then(r => setTimelineEvents(Array.isArray(r?.events) ? r.events : [])).catch(() => {}),
      ])
    } catch (e) {
      console.error('[ClientProfile load error]', e)
    }
  }

  const reloadProperties = async () => {
    const props = await get(`/api/properties?client_id=${id}`)
    setProperties(Array.isArray(props) ? props : [])
    return Array.isArray(props) ? props : []
  }

  const saveProp = async () => {
    setSavingProp(true)
    try {
      const url = editingProp ? `/api/properties/${editingProp.id}` : '/api/properties'
      const body = editingProp ? propForm : { ...propForm, client_id: parseInt(id) }
      const saved = editingProp ? await patch(url, body) : await post(url, body)
      const props = await reloadProperties()
      // If a brand-new STR property was just created, keep the form open so the
      // user can add iCal feeds without an extra navigation step.
      if (!editingProp && saved?.id && propForm.property_type === 'str') {
        const fresh = props.find(p => p.id === saved.id) || saved
        setEditingProp(fresh)
        setPropForm({ ...fresh })
      } else {
        setShowPropForm(false); setEditingProp(null); setPropForm(EMPTY_PROP)
      }
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

  const openQuickContact = () => {
    setQuickContact({ phone: client?.phone || '', email: client?.email || '' })
    setQuickContactOpen(true)
  }

  const saveQuickContact = async () => {
    const payload = {}
    if (!client?.phone && quickContact.phone.trim()) payload.phone = quickContact.phone.trim()
    if (!client?.email && quickContact.email.trim()) payload.email = quickContact.email.trim()
    if (Object.keys(payload).length === 0) { setQuickContactOpen(false); return }
    setQuickContactSaving(true)
    try {
      await patch(`/api/clients/${id}`, payload)
      await load()
      setQuickContactOpen(false)
    } catch (e) {
      console.error('[saveQuickContact]', e)
      toast.error('Could not save contact: ' + (e?.message || 'unknown error'))
    }
    setQuickContactSaving(false)
  }

  const addIcal = async (propId) => {
    if (!icalForm.url.trim()) return
    try {
      const body = {
        ...icalForm,
        duration_hours: icalForm.duration_hours ? parseFloat(icalForm.duration_hours) : null,
      }
      await post(`/api/properties/${propId}/icals`, body)
      const props = await reloadProperties()
      const updated = props.find(p => p.id === propId)
      if (updated) { setEditingProp(updated); setPropForm({ ...updated }) }
      setIcalForm(EMPTY_ICAL); setShowIcalForm(false)
    } catch (e) {
      console.error('[addIcal]', e)
      toast.error('Could not add iCal: ' + (e?.message || 'unknown error'))
    }
  }

  const removeIcal = async (propId, icalId) => {
    if (!confirm('Remove this calendar feed?')) return
    try {
      await del(`/api/properties/${propId}/icals/${icalId}`)
      const props = await reloadProperties()
      const updated = props.find(p => p.id === propId)
      if (updated) { setEditingProp(updated); setPropForm({ ...updated }) }
    } catch (e) {
      console.error('[removeIcal]', e)
    }
  }

  const syncProperty = async (propId) => {
    setSyncingPropId(propId); setSyncBanner(null)
    try {
      const data = await post(`/api/properties/${propId}/sync`)
      const jobsCreated = data?.jobs_created ?? 0
      setSyncBanner({ ok: true, propId, message: jobsCreated > 0 ? `Synced — ${jobsCreated} new turnover${jobsCreated === 1 ? '' : 's'} scheduled` : 'Synced — no new turnovers' })
      await Promise.all([reloadProperties(), load()])
    } catch (e) {
      setSyncBanner({ ok: false, propId, message: e?.message || 'Sync failed' })
    }
    setSyncingPropId(null)
  }

  const openNewProp = () => { setPropForm(EMPTY_PROP); setEditingProp(null); setShowIcalForm(false); setIcalForm(EMPTY_ICAL); setShowPropForm(true) }
  const openEditProp = (p) => { setPropForm({ ...p }); setEditingProp(p); setShowIcalForm(false); setIcalForm(EMPTY_ICAL); setShowPropForm(true) }

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
    } catch (e) {
      console.error('[ClientProfile save error]', e)
      toast.error('Failed to save changes. Please try again.')
    }
    setSaving(false)
  }

  const sendSms = async () => {
    if (!smsText.trim() || !client?.phone) return
    setSending(true)
    try {
      await post('/api/comms/sms', { to: client.phone, body: smsText, client_id: parseInt(id) })
    } catch (e) {
      console.error('[ClientProfile] sendSms error:', e)
      toast.error('Failed to send SMS')
    }
    setSmsText('')
    await load()
    setSending(false)
  }

  if (!client) return (
    <div className="flex items-center justify-center h-full text-ink-3 text-sm">Loading...</div>
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

  // Build activity feed (all records sorted by date).
  //
  // Dedupe: PR 1 auto-logs JOB_CREATED / JOB_SCHEDULED activities for every
  // job, but those jobs are already in the `jobs` array — so we exclude
  // job_* activity_log entries to avoid duplicate rows. Email and visit
  // activities still pass through since they don't have a sibling source.
  const JOB_SHADOWED_TYPES = new Set([
    'job_created', 'job_scheduled', 'job_started', 'job_completed', 'job_cancelled',
  ])
  const activityLogVisible = activities.filter(a => {
    if (a.activity_type === 'email_received') return false
    // Drop job_* events that mirror a job already shown — UNLESS the row was
    // emitted by the GCal source (event created/updated/cancelled in calendar)
    // or it's a single-occurrence visit skip, both of which add real signal.
    if (JOB_SHADOWED_TYPES.has(a.activity_type)) {
      const fromGcal = a.extra_data?.source === 'gcal'
      const visitSkip = a.extra_data?.single_occurrence === true
      return fromGcal || visitSkip
    }
    return true
  })

  const allActivity = [
    ...jobs.map(j => ({ type: 'job', date: j.created_at, data: j })),
    ...quotes.map(q => ({ type: 'quote', date: q.created_at, data: q })),
    ...invoices.map(i => ({ type: 'invoice', date: i.created_at, data: i })),
    ...messages.map(m => ({ type: 'message', date: m.created_at, data: m })),
    ...opportunities.map(o => ({ type: 'opportunity', date: o.created_at, data: o })),
    ...activityLogVisible.map(a => ({ type: 'activity_log', date: a.created_at, data: a })),
    ...emails.map(e => ({ type: 'email', date: e.created_at, data: e })),
    // Real Google Calendar events linked by email. Skip ones that mirror an app
    // job (they already appear as a 'job' item) to avoid double entries.
    ...timelineEvents.filter(ev => !ev.job_id).map(ev => ({ type: 'gcal_event', date: ev.start, data: ev })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  // Filter chips: All / Email / Calendar / Money / Notes
  const ACTIVITY_FILTERS = [
    { value: 'all',      label: 'All' },
    { value: 'email',    label: 'Emails',   match: i => i.type === 'email' || i.type === 'message' || (i.type === 'activity_log' && i.data.activity_type?.startsWith('email_')) },
    { value: 'calendar', label: 'Calendar', match: i => i.type === 'job' || i.type === 'gcal_event' || (i.type === 'activity_log' && (i.data.activity_type?.startsWith('job_') || i.data.extra_data?.source === 'gcal')) },
    { value: 'money',    label: 'Money',    match: i => i.type === 'quote' || i.type === 'invoice' || i.type === 'opportunity' },
    { value: 'notes',    label: 'Notes',    match: i => i.type === 'activity_log' && (i.data.activity_type === 'note_added' || !i.data.activity_type?.match(/^(email|job|sms)_/)) },
  ]
  const activeFilter = ACTIVITY_FILTERS.find(f => f.value === activityFilter)
  const activity = activityFilter === 'all' || !activeFilter?.match
    ? allActivity
    : allActivity.filter(activeFilter.match)

  return (
    <div className="flex flex-col h-full overflow-y-auto sm:overflow-hidden" data-testid="client-profile-root">
      {/* Header */}
      <div className="bg-panel border-b border-hairline px-4 sm:px-6 py-4 shrink-0">
        <button onClick={() => navigate('/clients')}
          className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-3 mb-3 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Clients
        </button>

        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-2xl bg-blue-500/10 flex items-center justify-center shrink-0">
              <span className="text-blue-500 font-bold text-lg sm:text-xl">{(client.first_name || client.name)[0]?.toUpperCase()}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg sm:text-xl font-bold text-ink truncate">{client.name}</h1>
                <span className={`text-[10px] sm:text-xs px-2 py-0.5 rounded-full border capitalize ${STATUS_COLORS[client.status]}`}>
                  {client.status}
                </span>
              </div>
              <div className="flex items-center gap-x-3 gap-y-1 mt-1 flex-wrap">
                {client.phone && <span className="flex items-center gap-1 text-xs sm:text-sm text-ink-3"><Phone className="w-3.5 h-3.5" />{client.phone}</span>}
                {client.email && <span className="flex items-center gap-1 text-xs sm:text-sm text-ink-3 truncate max-w-full"><Mail className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{client.email}</span></span>}
                {(client.city || client.address) && (
                  <span className="flex items-center gap-1 text-xs sm:text-sm text-ink-3">
                    <MapPin className="w-3.5 h-3.5" />{client.city || client.address}
                  </span>
                )}
              </div>
            </div>
          </div>

          <button onClick={() => {
              setTab('details')
              setTimeout(() => {
                document.querySelector('[data-testid="client-edit-contact"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 50)
            }}
            data-testid="client-header-edit"
            className="flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-bg-2 border border-hairline px-3 py-1.5 rounded-lg text-sm transition-colors shrink-0 self-start">
            <Edit2 className="w-3.5 h-3.5" /> Edit Info
          </button>
        </div>

        {/* Stats bar — compact on mobile, normal on desktop */}
        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-hairline sm:grid-cols-4">
          {/* Upcoming */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 sm:p-3">
            <div className="text-xs sm:text-sm text-blue-600 font-medium">Upcoming</div>
            <div className="text-lg sm:text-base font-bold text-blue-700 mt-0.5">{visitStats?.upcoming ?? upcomingJobs.length}</div>
          </div>

          {/* Revenue */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 sm:p-3">
            <div className="text-xs sm:text-sm text-green-600 font-medium">Revenue</div>
            <div className="text-lg sm:text-base font-bold text-green-700 mt-0.5">${totalRevenue.toFixed(0)}</div>
          </div>

          {/* Outstanding */}
          <div className={`border rounded-lg p-2.5 sm:p-3 ${outstanding > 0 ? 'bg-amber-50 border-amber-200' : 'bg-bg border-hairline'}`}>
            <div className={`text-xs sm:text-sm font-medium ${outstanding > 0 ? 'text-amber-600' : 'text-ink-2'}`}>Outstanding</div>
            <div className={`text-lg sm:text-base font-bold mt-0.5 ${outstanding > 0 ? 'text-amber-700' : 'text-ink-2'}`}>${outstanding.toFixed(0)}</div>
          </div>

          {/* GCal */}
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-2.5 sm:p-3">
            <div className="text-xs sm:text-sm text-indigo-600 font-medium">GCal</div>
            <div className="text-xs sm:text-sm text-indigo-700">● {visitStats?.gcal_synced ?? 0} | ✓ {visitStats?.invites_sent ?? 0}</div>
          </div>
        </div>


        {/* Missing contact info — tappable quick-add (mobile-friendly) */}
        {(!client.phone || !client.email) && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg overflow-hidden" data-testid="missing-contact-banner">
            {!quickContactOpen ? (
              <button
                type="button"
                onClick={openQuickContact}
                data-testid="missing-contact-open"
                className="w-full flex items-center gap-2.5 p-3 text-left hover:bg-amber-100/60 transition-colors">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-amber-900">Add {!client.phone && !client.email ? 'phone and email' : !client.phone ? 'phone number' : 'email'}</div>
                  <p className="text-xs text-amber-700 mt-0.5">Tap to add now</p>
                </div>
                <span className="text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-md shrink-0">
                  Add
                </span>
              </button>
            ) : (
              <div className="p-3 space-y-2.5">
                {!client.phone && (
                  <div>
                    <label className="block text-[11px] font-medium text-amber-900 mb-1">Phone</label>
                    <input
                      type="tel"
                      inputMode="tel"
                      autoFocus
                      value={quickContact.phone}
                      onChange={e => setQuickContact(q => ({ ...q, phone: e.target.value }))}
                      placeholder="+1 (555) 123-4567"
                      data-testid="missing-contact-phone"
                      className="w-full bg-panel border border-amber-200 rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/30" />
                  </div>
                )}
                {!client.email && (
                  <div>
                    <label className="block text-[11px] font-medium text-amber-900 mb-1">Email</label>
                    <input
                      type="email"
                      inputMode="email"
                      autoFocus={!!client.phone}
                      value={quickContact.email}
                      onChange={e => setQuickContact(q => ({ ...q, email: e.target.value }))}
                      placeholder="client@example.com"
                      data-testid="missing-contact-email"
                      className="w-full bg-panel border border-amber-200 rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/30" />
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setQuickContactOpen(false)}
                    className="px-3 py-2 text-sm text-amber-900 hover:bg-amber-100 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveQuickContact}
                    disabled={quickContactSaving || (!quickContact.phone.trim() && !quickContact.email.trim())}
                    data-testid="missing-contact-save"
                    className="flex-1 flex items-center justify-center gap-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                    <Save className="w-3.5 h-3.5" />
                    {quickContactSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center gap-2 px-4 sm:px-6 py-3 bg-panel/50 border-b border-hairline shrink-0">
        <button onClick={() => navigate('/quoting', { state: { openNew: true, clientId: parseInt(id) } })}
          data-testid="client-action-new-quote"
          className="flex items-center justify-center sm:justify-start gap-1.5 text-xs bg-bg-2 hover:bg-bg-2 border border-hairline px-3 py-2 sm:py-1.5 rounded-lg transition-colors">
          <FileText className="w-3.5 h-3.5 text-blue-400" /> <span className="hidden sm:inline">New Quote</span>
        </button>
        <button onClick={() => setJobModal({})}
          data-testid="client-action-schedule-job"
          className="flex items-center justify-center sm:justify-start gap-1.5 text-xs bg-bg-2 hover:bg-bg-2 border border-hairline px-3 py-2 sm:py-1.5 rounded-lg transition-colors">
          <Calendar className="w-3.5 h-3.5 text-blue-500" /> <span className="hidden sm:inline">Schedule Job</span>
        </button>
        <button onClick={() => navigate(`/invoicing`)}
          className="flex items-center justify-center sm:justify-start gap-1.5 text-xs bg-bg-2 hover:bg-bg-2 border border-hairline px-3 py-2 sm:py-1.5 rounded-lg transition-colors">
          <Receipt className="w-3.5 h-3.5 text-green-400" /> <span className="hidden sm:inline">New Invoice</span>
        </button>
        <button onClick={() => setTab('messages')}
          className="flex items-center justify-center sm:justify-start gap-1.5 text-xs bg-bg-2 hover:bg-bg-2 border border-hairline px-3 py-2 sm:py-1.5 rounded-lg transition-colors">
          <MessageSquare className="w-3.5 h-3.5 text-purple-400" /> <span className="hidden sm:inline">Send SMS</span>
        </button>
      </div>

      {/* Tabs — Overview, Properties, Schedule, Activity, Messages, Money */}
      <div className="flex border-b border-hairline px-4 sm:px-6 bg-panel/95 backdrop-blur shrink-0 overflow-x-auto sticky top-0 z-20 sm:static sm:bg-panel/30 sm:backdrop-blur-0" data-testid="client-profile-tabs">
        <Tab label="Overview" icon={Edit2} active={['details', 'crm'].includes(tab)} count={0} onClick={() => setTab('details')} />
        <Tab label="Properties" icon={Home} active={tab === 'properties'} count={properties.length} onClick={() => setTab('properties')} />
        <Tab label="Schedule" icon={Calendar} active={['calendar', 'recurring', 'jobs'].includes(tab)} count={upcomingJobs.length} onClick={() => setTab('calendar')} />
        <Tab label="Timeline" icon={Clock} active={tab === 'activity'} count={allActivity.length} onClick={() => setTab('activity')} />
        <Tab label="Messages" icon={MessageSquare} active={tab === 'messages'} count={messages.length + emails.length} onClick={() => setTab('messages')} />
        <Tab label="Money" icon={DollarSign} active={['quotes', 'invoices', 'opportunities'].includes(tab)} count={quotes.length + invoices.length} onClick={() => setTab('quotes')} />
      </div>

      {/* Tab content */}
      <div className="p-4 sm:p-6 pb-28 sm:pb-6 sm:flex-1 sm:overflow-y-auto sm:scrollbar-thin">

        {/* CRM Summary */}
        {tab === 'crm' && (
          <ClientCRMSummary clientId={id} />
        )}

        {/* Activity feed */}
        {tab === 'activity' && (
          <div className="max-w-2xl space-y-3">
            {/* Twenty-style filter chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mt-1 sticky top-0 bg-bg z-10 py-2">
              {ACTIVITY_FILTERS.map(f => {
                const count = f.value === 'all' ? allActivity.length : (f.match ? allActivity.filter(f.match).length : 0)
                const isActive = activityFilter === f.value
                return (
                  <button
                    key={f.value}
                    onClick={() => setActivityFilter(f.value)}
                    className={`text-xs px-2.5 py-1 rounded-full border font-medium whitespace-nowrap transition-colors ${
                      isActive
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-panel border-hairline text-ink-3 hover:bg-bg'
                    }`}
                  >
                    {f.label}
                    <span className={`ml-1.5 text-[10px] opacity-70 ${isActive ? 'text-white' : 'text-ink-3'}`}>{count}</span>
                  </button>
                )
              })}
            </div>
            {activity.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No {activityFilter === 'all' ? '' : activityFilter} activity yet</p>}
            {activity.map((item, i) => (
              <div key={i} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    item.type === 'job'          ? 'bg-blue-500/10' :
                    item.type === 'gcal_event'   ? 'bg-indigo-50' :
                    item.type === 'quote'        ? 'bg-blue-600/20' :
                    item.type === 'invoice'      ? 'bg-green-50' :
                    item.type === 'opportunity'  ? 'bg-amber-50' :
                    item.type === 'email'        ? 'bg-cyan-50' :
                    item.type === 'activity_log' ? 'bg-bg-2' :
                                                   'bg-purple-50'
                  }`}>
                    {item.type === 'job'          && <Calendar className="w-3.5 h-3.5 text-blue-500" />}
                    {item.type === 'gcal_event'   && <Calendar className="w-3.5 h-3.5 text-indigo-500" />}
                    {item.type === 'quote'        && <FileText className="w-3.5 h-3.5 text-blue-400" />}
                    {item.type === 'invoice'      && <Receipt className="w-3.5 h-3.5 text-green-400" />}
                    {item.type === 'message'      && <MessageSquare className="w-3.5 h-3.5 text-purple-400" />}
                    {item.type === 'opportunity'  && <TrendingUp className="w-3.5 h-3.5 text-amber-500" />}
                    {item.type === 'email'        && <Mail className="w-3.5 h-3.5 text-cyan-500" />}
                    {item.type === 'activity_log' && (
                      item.data.extra_data?.source === 'gcal' ? <Calendar className="w-3.5 h-3.5 text-indigo-500" />
                      : item.data.extra_data?.single_occurrence ? <X className="w-3.5 h-3.5 text-rose-500" />
                      : item.data.activity_type?.startsWith('email_') ? <Mail className="w-3.5 h-3.5 text-cyan-500" />
                      : <Zap className="w-3.5 h-3.5 text-ink-3" />
                    )}
                  </div>
                  {i < activity.length - 1 && <div className="w-px flex-1 bg-bg-2 mt-1" />}
                </div>
                <div className="flex-1 pb-4 min-w-0">
                  <div className="bg-panel border border-hairline rounded-xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {item.type === 'job' && (
                          <>
                            <div className="text-sm font-medium text-ink">{item.data.title}</div>
                            <div className="text-xs text-ink-3 mt-0.5">{item.data.scheduled_date} · {item.data.start_time}–{item.data.end_time}</div>
                          </>
                        )}
                        {item.type === 'gcal_event' && (
                          <>
                            <div className="text-sm font-medium text-ink">{item.data.title}</div>
                            <div className="text-xs text-ink-3 mt-0.5">
                              {item.data.start ? new Date(item.data.start).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                              {item.data.location ? ` · ${item.data.location}` : ''}
                            </div>
                          </>
                        )}
                        {item.type === 'quote' && (
                          <>
                            <div className="text-sm font-medium text-ink">Quote — ${item.data.total?.toFixed(2)}</div>
                            <div className="text-xs text-ink-3 mt-0.5">{item.data.items?.length || 0} items</div>
                          </>
                        )}
                        {item.type === 'invoice' && (
                          <>
                            <div className="text-sm font-medium text-ink">{item.data.invoice_number} — ${item.data.total?.toFixed(2)}</div>
                            <div className="text-xs text-ink-3 mt-0.5">Due {item.data.due_date || 'N/A'}</div>
                          </>
                        )}
                        {item.type === 'message' && (
                          <>
                            <div className="text-sm text-ink-3">{item.data.body}</div>
                            <div className="text-xs text-ink-3 mt-0.5">{item.data.direction} · {item.data.channel}</div>
                          </>
                        )}
                        {item.type === 'opportunity' && (
                          <>
                            <div className="text-sm font-medium text-ink">{item.data.title}</div>
                            <div className="text-xs text-ink-3 mt-0.5">
                              {item.data.amount != null && <span className="text-emerald-600 font-medium">${item.data.amount.toLocaleString()}</span>}
                              {item.data.service_type && <span className="ml-2">{item.data.service_type.replace('_', ' ')}</span>}
                            </div>
                          </>
                        )}
                        {item.type === 'email' && (
                          <>
                            <div className="text-sm font-medium text-ink">{item.data.subject || '(no subject)'}</div>
                            <div className="text-xs text-ink-3 mt-0.5">
                              {item.data.direction === 'outbound' ? `to ${item.data.to_addr || ''}` : `from ${item.data.from_addr || ''}`}
                            </div>
                            {item.data.body && <div className="text-xs text-ink-3 mt-1 truncate">{item.data.body.slice(0, 120)}</div>}
                          </>
                        )}
                        {item.type === 'activity_log' && (
                          <>
                            <div className="text-sm text-ink-3">{item.data.summary}</div>
                            <div className="text-xs text-ink-3 mt-0.5">{item.data.activity_type.replace(/_/g, ' ')}</div>
                          </>
                        )}
                               </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                          item.type === 'job'          ? JOB_COLORS[item.data.status] :
                          item.type === 'gcal_event'   ? 'bg-indigo-500/20 text-indigo-500' :
                          item.type === 'quote'        ? QUOTE_COLORS[item.data.status] :
                          item.type === 'invoice'      ? INVOICE_COLORS[item.data.status] :
                          item.type === 'opportunity'  ? (OPP_COLORS[item.data.stage] || 'bg-amber-500/20 text-amber-500') :
                          item.type === 'email'        ? 'bg-cyan-500/20 text-cyan-500' :
                          item.type === 'activity_log' ? 'bg-bg-2 text-ink-3' :
                          'bg-purple-500/20 text-purple-400'
                        }`}>
                          {item.type === 'message' ? item.data.direction :
                           item.type === 'gcal_event' ? 'event' :
                           item.type === 'opportunity' ? item.data.stage :
                           item.type === 'email' ? (item.data.direction === 'outbound' ? 'sent' : 'email') :
                           item.type === 'activity_log' ? item.data.activity_type?.split('_')[0] :
                           item.data.status?.replace('_', ' ')}
                        </span>
                        <span className="text-xs text-ink-3">
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
            clientEmail={client?.email}
            visitStats={visitStats}
            gcalReloadKey={gcalReload}
            onAddAppointment={() => setJobModal({})}
            onEditJob={(j) => setEditJob(j)}
            onChanged={() => { load(); setGcalReload(k => k + 1) }}
            toast={toast}
          />
        )}

        {/* Properties */}
        {tab === 'properties' && (
          <div className="max-w-2xl" data-testid="client-properties-tab">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-ink-3">{properties.length} propert{properties.length !== 1 ? 'ies' : 'y'}</p>
              <button onClick={openNewProp}
                data-testid="client-add-property"
                className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add Property
              </button>
            </div>

            {syncBanner && (
              <div className={`flex items-start gap-2 rounded-lg p-3 mb-3 text-xs border ${syncBanner.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                {syncBanner.ok ? <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                <span className="flex-1">{syncBanner.message}</span>
                <button onClick={() => setSyncBanner(null)} className="opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* Property form */}
            {showPropForm && (
              <div className="bg-panel border border-hairline rounded-xl p-5 mb-4 space-y-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-ink">{editingProp ? 'Edit Property' : 'New Property'}</span>
                  <button onClick={() => setShowPropForm(false)} className="text-ink-3 hover:text-ink-3"><X className="w-4 h-4" /></button>
                </div>

                <div>
                  <label className="block text-xs text-ink-3 mb-1">Property Name *</label>
                  <input value={propForm.name || ''} onChange={e => setPropForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Main Home, Lake House"
                    className={INPUT_CLASS} />
                </div>

                <div>
                  <label className="block text-xs text-ink-3 mb-1">Type</label>
                  <div className="flex gap-2">
                    {[['residential','Residential'],['commercial','Commercial'],['str','STR / Airbnb']].map(([val, label]) => (
                      <button key={val} onClick={() => setPropForm(f => ({ ...f, property_type: val }))}
                        className={`flex-1 py-1.5 rounded-lg text-xs transition-colors ${propForm.property_type === val ? 'bg-blue-600 text-white' : 'bg-bg-2 text-ink-3 hover:bg-bg-2'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-ink-3 mb-1">Address</label>
                  <input value={propForm.address || ''} onChange={e => setPropForm(f => ({ ...f, address: e.target.value }))}
                    className={INPUT_CLASS} />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-xs text-ink-3 mb-1">City</label>
                    <input value={propForm.city || ''} onChange={e => setPropForm(f => ({ ...f, city: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                  <div className="w-16">
                    <label className="block text-xs text-ink-3 mb-1">State</label>
                    <input value={propForm.state || ''} onChange={e => setPropForm(f => ({ ...f, state: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                  <div className="w-24">
                    <label className="block text-xs text-ink-3 mb-1">ZIP</label>
                    <input value={propForm.zip_code || ''} onChange={e => setPropForm(f => ({ ...f, zip_code: e.target.value }))}
                      className={INPUT_CLASS} />
                  </div>
                </div>

                {propForm.property_type === 'str' && (
                  <>
                    <div className="border-t border-hairline pt-4">
                      <h3 className="text-xs font-semibold text-ink-2 uppercase mb-3">STR / Turnover Settings</h3>

                      <div className="grid grid-cols-2 gap-2 mb-3">
                        <div>
                          <label className="block text-xs text-ink-3 mb-1">Check-in Time</label>
                          <input type="time" value={propForm.check_in_time || '14:00'}
                            onChange={e => setPropForm(f => ({ ...f, check_in_time: e.target.value }))}
                            className={INPUT_CLASS} />
                        </div>
                        <div>
                          <label className="block text-xs text-ink-3 mb-1">Check-out Time</label>
                          <input type="time" value={propForm.check_out_time || '10:00'}
                            onChange={e => setPropForm(f => ({ ...f, check_out_time: e.target.value }))}
                            className={INPUT_CLASS} />
                        </div>
                      </div>

                      <div className="mb-3">
                        <label className="block text-xs text-ink-3 mb-1">House Code/Key Code</label>
                        <input value={propForm.house_code || ''}
                          onChange={e => setPropForm(f => ({ ...f, house_code: e.target.value }))}
                          placeholder="e.g. 1234 or Front door code"
                          className={INPUT_CLASS} />
                      </div>

                      <div>
                        <label className="block text-xs text-ink-3 mb-1">Default Turnover Duration (hours)</label>
                        <input type="number" step="0.5" min="0.5" value={propForm.default_duration_hours || 3}
                          onChange={e => setPropForm(f => ({ ...f, default_duration_hours: parseFloat(e.target.value) }))}
                          className={INPUT_CLASS} />
                      </div>
                    </div>

                    {/* Multi-iCal feed management (Airbnb / VRBO / etc.) */}
                    <div className="border-t border-hairline pt-4" data-testid="client-property-ical-section">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-xs font-semibold text-ink-2 uppercase">Calendar Feeds</h3>
                        {editingProp && (editingProp.icals?.length || 0) > 0 && (
                          <button
                            type="button"
                            onClick={() => syncProperty(editingProp.id)}
                            disabled={syncingPropId === editingProp.id}
                            className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 disabled:opacity-50">
                            <RefreshCw className={`w-3 h-3 ${syncingPropId === editingProp.id ? 'animate-spin' : ''}`} />
                            {syncingPropId === editingProp.id ? 'Syncing…' : 'Sync now'}
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-ink-3 mb-2">Paste an iCal URL from Airbnb, VRBO, or any booking platform. Turnover jobs are auto-created on each checkout.</p>
                      {editingProp && (
                        <button
                          type="button"
                          onClick={() => navigate(`/properties/${editingProp.id}/icals`)}
                          data-testid="open-bulk-icals"
                          className="text-[11px] text-blue-600 hover:text-blue-700 mb-3">
                          Paste multiple URLs at once →
                        </button>
                      )}

                      {!editingProp ? (
                        <p className="text-xs text-ink-3 bg-bg border border-hairline rounded-lg px-3 py-2">
                          Save the property first, then add calendar feeds here.
                        </p>
                      ) : (
                        <>
                          <div className="space-y-2 mb-2">
                            {(editingProp.icals || []).map(ical => (
                              <div key={ical.id} className="bg-bg border border-hairline rounded-lg p-2.5" data-testid="client-property-ical-row">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[11px] font-mono text-ink-2 truncate">{ical.url}</div>
                                    {ical.source && <div className="text-[10px] text-ink-3 mt-0.5">{ical.source}</div>}
                                    {(ical.last_synced_at || ical.last_sync_status) && (
                                      <div className="flex items-center gap-1.5 text-[10px] mt-1">
                                        {ical.last_sync_status === 'failed' ? (
                                          <>
                                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
                                            <span className="text-red-600 font-medium">Sync failed</span>
                                            {ical.last_sync_error && <span className="text-ink-3 truncate">{ical.last_sync_error}</span>}
                                          </>
                                        ) : ical.last_synced_at ? (
                                          <>
                                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                            <span className="text-ink-2">Synced {new Date(ical.last_synced_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                                          </>
                                        ) : (
                                          <>
                                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-bg-2" />
                                            <span className="text-ink-3">Never synced</span>
                                          </>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeIcal(editingProp.id, ical.id)}
                                    className="text-ink-3 hover:text-red-500 shrink-0"
                                    aria-label="Remove calendar feed">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            ))}
                            {(editingProp.icals?.length || 0) === 0 && !showIcalForm && (
                              <p className="text-xs text-ink-3 italic py-1">No calendar feeds yet.</p>
                            )}
                          </div>

                          {showIcalForm ? (
                            <div className="bg-panel border border-hairline rounded-lg p-3 space-y-2">
                              <input value={icalForm.url}
                                onChange={e => setIcalForm(f => ({ ...f, url: e.target.value }))}
                                placeholder="https://www.airbnb.com/calendar/ical/…"
                                className={INPUT_CLASS} />
                              <input value={icalForm.source}
                                onChange={e => setIcalForm(f => ({ ...f, source: e.target.value }))}
                                placeholder="Source (airbnb, vrbo, …)"
                                className={INPUT_CLASS} />
                              <div className="grid grid-cols-2 gap-2">
                                <input type="time" value={icalForm.checkout_time}
                                  onChange={e => setIcalForm(f => ({ ...f, checkout_time: e.target.value }))}
                                  placeholder="Checkout"
                                  className={INPUT_CLASS} />
                                <input type="number" step="0.5" min="0.5" value={icalForm.duration_hours}
                                  onChange={e => setIcalForm(f => ({ ...f, duration_hours: e.target.value }))}
                                  placeholder="Duration (hrs)"
                                  className={INPUT_CLASS} />
                              </div>
                              <div className="flex gap-2 pt-1">
                                <button type="button" onClick={() => addIcal(editingProp.id)}
                                  disabled={!icalForm.url.trim()}
                                  data-testid="client-property-ical-save"
                                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-bg-2 disabled:text-ink-3 text-white px-3 py-2 rounded-lg text-xs font-medium">
                                  Add Feed
                                </button>
                                <button type="button" onClick={() => { setShowIcalForm(false); setIcalForm(EMPTY_ICAL) }}
                                  className="flex-1 bg-bg-2 hover:bg-bg-2 text-ink-2 px-3 py-2 rounded-lg text-xs">
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" onClick={() => setShowIcalForm(true)}
                              data-testid="client-property-ical-add"
                              className="w-full text-xs text-blue-600 hover:text-blue-700 border border-blue-200 bg-blue-50/50 hover:bg-blue-50 px-3 py-2 rounded-lg transition-colors">
                              + Add Calendar Feed
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-xs text-ink-3 mb-1">Notes</label>
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
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                    {savingProp ? 'Saving...' : 'Save Property'}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {properties.length === 0 && !showPropForm && (
                <p className="text-ink-3 text-sm text-center py-10">No properties yet</p>
              )}
              {properties.map(p => {
                const pType = (p.property_type || '').toLowerCase()
                const isStr = pType === 'str'
                const feedCount = (p.icals?.length || 0) + (p.ical_url ? 1 : 0)
                const icalPill = isStr
                  ? feedCount > 0
                    ? { label: `${feedCount} iCal feed${feedCount !== 1 ? 's' : ''}`, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
                    : { label: 'No iCal feeds', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                  : null
                return (
                  <div key={p.id}
                    data-testid="client-property-row"
                    className="bg-panel border border-hairline hover:border-hairline rounded-xl p-4 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-lg bg-bg-2 flex items-center justify-center shrink-0 mt-0.5">
                          <Home className="w-4 h-4 text-ink-3" />
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-ink text-sm">{p.name}</div>
                          {p.address && (
                            <div className="text-xs text-ink-3 flex items-center gap-1 mt-0.5">
                              <MapPin className="w-3 h-3 shrink-0" />
                              {[p.address, p.city, p.state].filter(Boolean).join(', ')}
                              {p.zip_code ? ` ${p.zip_code}` : ''}
                            </div>
                          )}
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${PROPERTY_TYPE_COLORS[pType] || PROPERTY_TYPE_COLORS.residential}`}>
                              {PROPERTY_TYPE_LABELS[pType] || p.property_type}
                            </span>
                            {icalPill && (
                              <span className={`text-[10px] px-2 py-0.5 rounded-full border ${icalPill.cls}`}>
                                {icalPill.label}
                              </span>
                            )}
                            {isStr && p.default_duration_hours && (
                              <span className="text-[10px] text-ink-3">{p.default_duration_hours}h turnover</span>
                            )}
                            {isStr && p.house_code && (
                              <span className="text-[10px] bg-blue-500/10 text-blue-600 px-1.5 py-0.5 rounded">Code: {p.house_code}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                        {isStr && feedCount > 0 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); syncProperty(p.id) }}
                            disabled={syncingPropId === p.id}
                            data-testid="client-property-sync"
                            className="flex items-center gap-1 text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                            title="Sync iCal feeds and auto-create turnover jobs"
                          >
                            <RefreshCw className={`w-3 h-3 ${syncingPropId === p.id ? 'animate-spin' : ''}`} />
                            {syncingPropId === p.id ? '…' : 'Sync'}
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate(`/properties/${p.id}`) }}
                          data-testid="client-property-view-jobs"
                          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-2.5 py-1.5 rounded-lg transition-colors"
                          title="View jobs and visits for this property"
                        >
                          <Calendar className="w-3 h-3" /> Jobs
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setJobModal({ propertyId: p.id }) }}
                          data-testid="client-property-add-job"
                          className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                          title="Schedule a job at this property"
                        >
                          <Plus className="w-3 h-3" /> Job
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); openEditProp(p) }}
                          className="text-xs text-ink-2 hover:text-ink bg-bg-2 hover:bg-bg-2 px-2.5 py-1.5 rounded-lg transition-colors"
                        >
                          Edit
                        </button>
                      </div>
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
              <p className="text-sm text-ink-3">{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</p>
              <a href="/recurring"
                className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add Schedule
              </a>
            </div>
            {schedules.length === 0 && (
              <div className="text-center py-10">
                <RefreshCw className="w-8 h-8 mx-auto mb-2 text-ink-2" />
                <p className="text-ink-3 text-sm mb-3">No recurring schedules</p>
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
                  <div key={s.id} className={`bg-panel border rounded-xl p-4 ${s.active ? 'border-hairline' : 'border-hairline opacity-60'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-ink">{s.title}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${typeColors[s.job_type] || typeColors.residential}`}>
                            {s.job_type}
                          </span>
                          {!s.active && <span className="text-[10px] text-ink-3 bg-bg-2 px-2 py-0.5 rounded-full">Paused</span>}
                        </div>
                        <div className="text-xs text-ink-3">
                          {FREQ[s.frequency]} · {s.frequency !== 'monthly' ? `${DAYS_S[s.day_of_week]}s` : `day ${s.day_of_month}`} · {s.start_time}–{s.end_time}
                        </div>
                        {s.address && <div className="text-[10px] text-ink-3 mt-0.5 flex items-center gap-1"><MapPin className="w-2.5 h-2.5" />{s.address}</div>}
                      </div>
                      <a href="/recurring" className="text-xs text-ink-3 hover:text-ink-3 bg-bg-2 hover:bg-bg-2 px-2.5 py-1.5 rounded-lg transition-colors shrink-0">
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
            {jobs.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No jobs yet</p>}

            {/* Upcoming */}
            {upcomingJobs.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Calendar className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">Upcoming ({upcomingJobs.length})</span>
                </div>
                <div className="space-y-2">
                  {upcomingJobs.map(j => (
                    <div key={j.id} className="bg-panel border border-blue-400/30 rounded-xl p-4 flex items-center gap-4">
                      <div className="text-center w-16 shrink-0">
                        <div className="text-sm font-semibold text-blue-600">
                          {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                        <div className="text-xs text-blue-500">{j.start_time}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-ink">{j.title}</div>
                        {j.address && <div className="text-xs text-ink-3 flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" />{j.address}</div>}
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
                <p className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-3">Past ({pastJobs.length})</p>
                <div className="space-y-2">
                  {pastJobs.map(j => (
                    <div key={j.id} className="bg-bg border border-hairline rounded-xl p-4 flex items-center gap-4">
                      <div className="text-center w-16 shrink-0">
                        <div className="text-sm font-medium text-ink-3">
                          {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                        <div className="text-xs text-ink-3">{j.start_time}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-ink-3">{j.title}</div>
                        {j.address && <div className="text-xs text-ink-3 flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" />{j.address}</div>}
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
            {quotes.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No quotes yet</p>}
            {quotes.map(q => (
              <div key={q.id} className="bg-panel border border-hairline rounded-xl p-4 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-ink">${q.total?.toFixed(2)}</div>
                  <div className="text-xs text-ink-3 mt-0.5">{q.items?.length || 0} items · {new Date(q.created_at).toLocaleDateString()}</div>
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
            {invoices.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No invoices yet</p>}
            {invoices.map(inv => (
              <div key={inv.id} className="bg-panel border border-hairline rounded-xl p-4 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-ink">{inv.invoice_number}</div>
                  <div className="text-xs text-ink-3 mt-0.5">Due {inv.due_date || 'N/A'} · ${inv.total?.toFixed(2)}</div>
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
            {/* Channel filter — all aspects linked by email/phone, in one place. */}
            <div className="flex items-center gap-2 mb-4">
              {[
                { value: 'all',   label: 'All',   count: messages.length + emails.length },
                { value: 'sms',   label: 'SMS',   count: messages.length },
                { value: 'email', label: 'Email', count: emails.length },
              ].map(f => (
                <button key={f.value} onClick={() => setCommsFilter(f.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    commsFilter === f.value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
                  }`}>
                  {f.label} <span className={commsFilter === f.value ? 'text-sky-100' : 'text-ink-3'}>{f.count}</span>
                </button>
              ))}
            </div>

            {/* SMS compose (visible on All + SMS) */}
            {commsFilter !== 'email' && (client.phone ? (
              <div className="bg-panel border border-hairline rounded-xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <MessageSquare className="w-4 h-4 text-purple-400" />
                  <span className="text-sm font-medium text-ink">Send SMS to {client.phone}</span>
                </div>
                <div className="flex gap-2">
                  <input value={smsText} onChange={e => setSmsText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendSms()}
                    placeholder="Type a message..."
                    className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-hairline" />
                  <button onClick={sendSms} disabled={sending || !smsText.trim()}
                    className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm transition-colors">
                    <Send className="w-3.5 h-3.5" />{sending ? '...' : 'Send'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 text-sm rounded-xl p-4 mb-4">
                Add a phone number to this client to enable SMS.
              </div>
            ))}

            {/* Unified message feed. SMS render as chat bubbles, emails as cards. */}
            {(() => {
              let items = commsFilter === 'sms' ? messages
                        : commsFilter === 'email' ? emails
                        : [...messages, ...emails]
              // SMS-only reads as a chat (oldest→newest); everything else newest-first.
              items = [...items].sort((a, b) =>
                commsFilter === 'sms'
                  ? new Date(a.created_at) - new Date(b.created_at)
                  : new Date(b.created_at) - new Date(a.created_at)
              )
              if (items.length === 0) {
                return <p className="text-ink-3 text-sm text-center py-8">
                  No {commsFilter === 'all' ? 'messages' : commsFilter === 'sms' ? 'SMS' : 'emails'} linked to this client yet
                </p>
              }
              return (
                <div className="space-y-2">
                  {items.map(m => m.channel === 'email'
                    ? <EmailCard key={`e${m.id}`} em={m} />
                    : (
                      <div key={`s${m.id}`} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-sm px-4 py-2.5 rounded-2xl text-sm ${
                          m.direction === 'outbound'
                            ? 'bg-blue-600 text-white rounded-br-sm'
                            : 'bg-bg-2 text-ink-2 rounded-bl-sm'
                        }`}>
                          <div>{m.body}</div>
                          <div className={`text-xs mt-1 ${m.direction === 'outbound' ? 'text-sky-200' : 'text-ink-3'}`}>
                            {new Date(m.created_at).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    )
                  )}
                </div>
              )
            })()}
          </div>
        )}

        {/* Details / Edit */}
        {tab === 'details' && (
          <div className="max-w-lg space-y-5">

            {/* Upcoming cleanings */}
            {upcomingJobs.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Calendar className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">Upcoming Cleanings</span>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {upcomingJobs.slice(0, 5).map(j => {
                    const typeColor = j.job_type === 'str_turnover' ? 'border-orange-400/30 bg-orange-500/10' : j.job_type === 'commercial' ? 'border-green-400/30 bg-green-500/10' : 'border-blue-400/30 bg-blue-500/10'
                    const textColor = j.job_type === 'str_turnover' ? 'text-orange-600' : j.job_type === 'commercial' ? 'text-green-600' : 'text-blue-600'
                    return (
                      <div key={j.id} className={`flex-shrink-0 ${typeColor} border rounded-lg px-3 py-2 min-w-[130px]`}>
                        <div className={`text-xs font-semibold ${textColor}`}>
                          {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </div>
                        <div className={`text-[11px] ${textColor} mt-0.5`}>{j.start_time} – {j.end_time}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Contact info */}
            <div className="bg-panel border border-hairline rounded-xl p-4 sm:p-6 space-y-4" data-testid="client-edit-contact">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1">Contact Info</div>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-ink-3 mb-1">First Name</label>
                  <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-ink-3 mb-1">Last Name</label>
                  <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                    className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
                </div>
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1">Phone *</label>
                <input type="tel" value={form.phone || ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+1 (555) 123-4567"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1">Email *</label>
                <input type="email" value={form.email || ''} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@example.com"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1">Lead Source</label>
                <input value={form.source || ''} onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
                  placeholder="e.g., Google, Referral, Facebook"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1">Status</label>
                <select value={form.status || 'lead'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400">
                  <option value="lead">Lead</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-ink-3 mb-1">Notes</label>
                <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                  placeholder="Any special notes about this client"
                  className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400 resize-none" />
              </div>
            </div>

            {/* Service address */}
            <div className="bg-panel border border-hairline rounded-xl p-4 sm:p-6 space-y-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">Service Address</div>
              {[
                { label: 'Street', key: 'address' },
                { label: 'City', key: 'city' },
                { label: 'State', key: 'state' },
                { label: 'ZIP', key: 'zip_code' },
              ].map(({ label, key }) => (
                <div key={key} className="flex flex-col sm:flex-row sm:items-center sm:gap-4">
                  <span className="text-xs text-ink-3 sm:w-24 sm:shrink-0 mb-1 sm:mb-0">{label}</span>
                  <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 sm:py-1.5 text-sm text-ink focus:outline-none focus:border-blue-400" />
                </div>
              ))}
            </div>

            {/* Billing address — collapsed by default when empty */}
            <div className="bg-panel border border-hairline rounded-xl p-4 sm:p-6">
              <button
                type="button"
                onClick={() => setShowBilling(s => !s)}
                className="w-full flex items-center justify-between text-left"
                data-testid="client-billing-toggle"
              >
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">Billing Address</div>
                  {!showBilling && (
                    <p className="text-xs text-ink-3 mt-1">Same as service address on invoices</p>
                  )}
                </div>
                <ChevronRight className={`w-4 h-4 text-ink-3 transition-transform ${showBilling ? 'rotate-90' : ''}`} />
              </button>
              {showBilling && (
                <div className="space-y-3 mt-4">
                  {[
                    { label: 'Street', key: 'billing_address' },
                    { label: 'City', key: 'billing_city' },
                    { label: 'State', key: 'billing_state' },
                    { label: 'ZIP', key: 'billing_zip' },
                  ].map(({ label, key }) => (
                    <div key={key} className="flex flex-col sm:flex-row sm:items-center sm:gap-4">
                      <span className="text-xs text-ink-3 sm:w-24 sm:shrink-0 mb-1 sm:mb-0">{label}</span>
                      <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                        className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 sm:py-1.5 text-sm text-ink focus:outline-none focus:border-blue-400" />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button onClick={save} disabled={saving}
              data-testid="client-save-changes"
              className="w-full sm:w-auto flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 px-5 py-2.5 sm:py-2 rounded-lg text-sm font-medium transition-colors">
              <Save className="w-4 h-4" />{saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}

        {/* Opportunities */}
        {tab === 'opportunities' && (
          <div className="max-w-2xl space-y-3">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-ink-3">{opportunities.length} opportunit{opportunities.length !== 1 ? 'ies' : 'y'}</p>
              <button onClick={() => navigate('/pipeline')}
                className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> New Deal
              </button>
            </div>
            {opportunities.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No opportunities yet</p>}
            {opportunities.map(opp => (
              <div key={opp.id} className="bg-panel border border-hairline rounded-xl p-4 hover:shadow-sm transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-4 h-4 text-amber-500" />
                      <span className="font-medium text-ink">{opp.title}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${OPP_COLORS[opp.stage] || 'bg-bg-2 text-ink-3'}`}>
                        {opp.stage}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
                      {opp.service_type && <span className="capitalize">{opp.service_type.replace('_', ' ')}</span>}
                      {opp.owner && <span>Owner: {opp.owner}</span>}
                      {opp.close_date && <span>Close: {opp.close_date}</span>}
                      {opp.probability != null && <span>{opp.probability}% likely</span>}
                    </div>
                    {opp.notes && <p className="text-xs text-ink-3 mt-2 italic">{opp.notes}</p>}
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
      </div>

      <AgentWidget
        pageContext="clients"
        prompts={[
          `Tell me about this client's history`,
          'What services should I upsell to this client?',
          'Draft a follow-up message for this client',
        ]}
      />

      {jobModal && (
        <JobCreateModal
          clientId={parseInt(id)}
          clientName={client?.name}
          initialPropertyId={jobModal.propertyId || null}
          onClose={() => setJobModal(null)}
          onCreated={(res) => {
            setJobModal(null); load(); setGcalReload(k => k + 1)
            if (res?.kind === 'recurring') return
            const g = res?.gcal
            if (g?.synced) {
              toast.success('Added to Google Calendar')
            } else if (g?.reason === 'not_connected') {
              toast.error('Saved, but Google Calendar isn’t connected yet — connect it in Settings so events land on your calendar.')
            } else {
              toast.error('Saved, but couldn’t reach Google Calendar — try Sync from Google, or check the connection in Settings.')
            }
          }}
        />
      )}

      {/* Edit/reschedule/cancel an existing appointment — syncs to Google
          (PATCH updates the linked event) and reloads the embed. */}
      {editJob && (
        <JobEditModal
          job={editJob}
          properties={properties}
          clients={client ? [client] : []}
          onClose={() => setEditJob(null)}
          onSave={() => { setEditJob(null); load(); setGcalReload(k => k + 1) }}
        />
      )}

      <ToastContainer />
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
  cancelled:   'bg-bg-2 text-ink-3 border-hairline',
}

/** A single linked email (from the unified comms tables), Twenty-style. */
function EmailCard({ em }) {
  const outbound = em.direction === 'outbound'
  return (
    <div className="bg-panel border border-hairline rounded-xl p-4 hover:shadow-sm transition-all">
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${outbound ? 'bg-blue-100' : 'bg-cyan-100'}`}>
          <Mail className={`w-4 h-4 ${outbound ? 'text-blue-600' : 'text-cyan-600'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm truncate flex-1 font-medium text-ink">{em.subject || '(no subject)'}</span>
            <span className="text-[10px] text-ink-3 shrink-0">
              {em.created_at ? new Date(em.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
            </span>
          </div>
          <div className="text-xs text-ink-3 mt-0.5 flex items-center gap-1.5">
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${outbound ? 'bg-blue-50 text-blue-600' : 'bg-cyan-50 text-cyan-600'}`}>
              {outbound ? 'Sent' : 'Received'}
            </span>
            <span className="truncate">{outbound ? `To: ${em.to_addr || ''}` : (em.from_addr || '')}</span>
          </div>
          {em.body && <p className="text-xs text-ink-3 mt-1.5 line-clamp-2">{em.body}</p>}
        </div>
      </div>
    </div>
  )
}

/** A single Google Calendar event row in the client's linked timeline. */
function GcalEventRow({ ev }) {
  const start = ev.start ? new Date(ev.start) : null
  const end = ev.end ? new Date(ev.end) : null
  const valid = start && !isNaN(start)
  const dotColor = JOB_TYPE_DOT[ev.job_type] || 'bg-indigo-500'
  const isPast = valid && end && !isNaN(end) ? end < new Date() : false
  const timeStr = valid
    ? (ev.all_day
        ? 'All day'
        : start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) +
          (end && !isNaN(end) ? ` – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''))
    : ''
  const invited = (ev.attendees || []).length > 0
  return (
    <a
      href={ev.html_link || undefined}
      target="_blank"
      rel="noopener noreferrer"
      className={`block bg-panel border border-hairline rounded-xl p-4 flex items-start gap-3 transition-colors hover:border-indigo-300 hover:shadow-sm ${isPast ? 'opacity-60' : ''}`}
      title="Open in Google Calendar"
    >
      <div className={`w-1 self-stretch rounded-full shrink-0 ${dotColor}`} />
      <div className="text-center w-12 shrink-0 pt-0.5">
        <div className="text-xs font-bold text-ink-2">
          {valid ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
        </div>
        <div className="text-[10px] text-ink-3">
          {valid ? start.toLocaleDateString('en-US', { weekday: 'short' }) : ''}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-ink truncate">{ev.title}</div>
        <div className="flex items-center gap-2 mt-1 text-xs text-ink-3 flex-wrap">
          {timeStr && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeStr}</span>}
          {ev.job_type && (<><span className="text-[10px] text-ink-3">|</span><span>{JOB_TYPE_LABEL[ev.job_type] || ev.job_type}</span></>)}
        </div>
        {ev.location && (
          <div className="flex items-center gap-1 mt-0.5 text-[11px] text-ink-3 truncate">
            <MapPin className="w-3 h-3 shrink-0" />{ev.location}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <span title="On Google Calendar" className="w-3.5 h-3.5 rounded-full bg-indigo-100 flex items-center justify-center text-[8px] text-indigo-500 font-bold">G</span>
        {invited && <span title="Client is an attendee" className="w-3.5 h-3.5 rounded-full bg-emerald-100 flex items-center justify-center text-[8px] text-emerald-500 font-bold">✓</span>}
      </div>
    </a>
  )
}

function ClientCalendarTab({ jobs, upcomingJobs, pastJobs, navigate, clientId, clientEmail, visitStats, gcalReloadKey = 0, onAddAppointment, onEditJob, onChanged, toast }) {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [selectedDate, setSelectedDate] = useState(null)

  // Embedded Google Calendar (the business calendar the sync writes to). Editing
  // happens in the appointment form / Google itself — the embed is read-only by
  // design. The src carries a reload key so add/edit/cancel/invite re-fetch it.
  const [embed, setEmbed] = useState({ loading: true })
  const [localReload, setLocalReload] = useState(0)
  const [invitingId, setInvitingId] = useState(null)
  useEffect(() => {
    get('/api/settings/gcal-embed')
      .then(r => setEmbed({ loading: false, url: r?.embed_url, configured: !!r?.configured }))
      .catch(() => setEmbed({ loading: false, configured: false }))
  }, [])

  // Twenty-style linked timeline: this client's actual Google Calendar events,
  // matched by their email (or our brightbase_client_id tag). This is the
  // source of truth — not local app rows.
  const [gcalEvents, setGcalEvents] = useState({ loading: true, events: [] })
  useEffect(() => {
    if (!clientId) return
    setGcalEvents(s => ({ ...s, loading: true }))
    get(`/api/jobs/client/${clientId}/gcal-events`)
      .then(r => setGcalEvents({ loading: false, ...r, events: r?.events || [] }))
      .catch(e => setGcalEvents({ loading: false, connected: false, events: [], detail: e?.message }))
  }, [clientId, gcalReloadKey, localReload])
  const iframeSrc = embed.url ? `${embed.url}&_=${gcalReloadKey}-${localReload}` : null
  const inviteCustomer = async (jobId) => {
    setInvitingId(jobId)
    try {
      await post(`/api/jobs/${jobId}/invite-client`, {})
      toast?.success?.('Customer invited — added to their calendar')
      onChanged?.()
    } catch (e) { toast?.error?.(e?.message || 'Could not invite customer') }
    setInvitingId(null)
  }

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
      {/* Add appointment + embedded Google Calendar */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Google Calendar</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setLocalReload(k => k + 1)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-2 bg-bg-2 hover:bg-hairline transition-colors"
            title="Reload the embed (Google caches new events for a few seconds)">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button onClick={onAddAppointment}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add appointment
          </button>
        </div>
      </div>
      <div className="bg-panel border border-hairline rounded-xl overflow-hidden">
        {embed.loading ? (
          <div className="p-8 text-center text-sm text-ink-3">Loading Google Calendar…</div>
        ) : !embed.configured ? (
          <div className="p-6 text-center text-[13px] text-ink-3">
            Google Calendar isn't set up for embedding yet (Settings → Integrations).
            Appointments you add are still saved straight to Google Calendar.
          </div>
        ) : (
          <iframe title="Google Calendar" src={iframeSrc} className="w-full border-0" style={{ height: '440px' }} />
        )}
      </div>

      {/* Linked Google Calendar events — this client's real events, matched by
          their email (or our brightbase tag). The Twenty-style source of truth. */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Linked Google Calendar events</h3>
          {gcalEvents.client_email && (
            <span className="text-[10px] text-ink-3">matched by {gcalEvents.client_email}</span>
          )}
        </div>
        {gcalEvents.loading ? (
          <div className="text-center py-8 bg-panel border border-hairline rounded-xl text-sm text-ink-3">Loading events from Google…</div>
        ) : gcalEvents.connected === false ? (
          <div className="text-center py-8 bg-amber-50 border border-amber-200 rounded-xl px-4">
            <Calendar className="w-7 h-7 mx-auto mb-2 text-amber-500" />
            <p className="text-sm text-amber-800 font-medium">Google Calendar isn't connected</p>
            <p className="text-xs text-amber-700 mt-1 max-w-sm mx-auto">
              Connect your work Google account in Settings → Integrations so this client's
              events appear here automatically, linked by their email.
            </p>
            <button onClick={() => navigate('/settings?section=integrations')}
              className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-700">Go to Settings →</button>
          </div>
        ) : (gcalEvents.events || []).length === 0 ? (
          <div className="text-center py-8 bg-panel border border-hairline rounded-xl px-4">
            <Calendar className="w-7 h-7 mx-auto mb-2 text-ink-3" />
            <p className="text-sm text-ink-3">
              No Google Calendar events linked to {gcalEvents.client_email || 'this client'} yet.
            </p>
            {!gcalEvents.client_email && (
              <p className="text-[11px] text-ink-3 mt-1">Add an email to this client so their events link automatically.</p>
            )}
            <button onClick={onAddAppointment}
              className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-700">+ Add appointment</button>
          </div>
        ) : (
          <div className="space-y-2">
            {gcalEvents.events.map(ev => <GcalEventRow key={ev.id} ev={ev} />)}
          </div>
        )}
      </div>

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
            <span className="text-ink-3"><strong>{visitStats.completed}</strong> completed</span>
            {visitStats.cancelled > 0 && <span className="text-red-500"><strong>{visitStats.cancelled}</strong> cancelled</span>}
          </div>
        </div>
      )}

      {/* Native fallback — only when Google isn't connected, so the profile is
          never blank. Once connected, the linked Google events above are the
          single source of truth (Twenty-style). */}
      {gcalEvents.connected === false && (<>
      {/* Mini month calendar */}
      <div className="bg-panel border border-hairline rounded-xl p-5">
        {/* Month nav */}
        <div className="flex items-center justify-between mb-3">
          <button onClick={prevMonth} className="p-1 hover:bg-bg-2 rounded-lg text-ink-3 hover:text-ink-3">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-ink-2">{MONTH_NAMES[month]} {year}</span>
          <button onClick={nextMonth} className="p-1 hover:bg-bg-2 rounded-lg text-ink-3 hover:text-ink-3">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {MINI_DAYS.map(d => (
            <div key={d} className="text-center text-[10px] font-medium text-ink-3 py-1">{d}</div>
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
                    ? 'hover:bg-bg-2 text-ink-2 font-medium'
                    : 'hover:bg-bg text-ink-3'
                }`}
              >
                {dayNum}
                {/* Job indicator dots */}
                {hasJobs && (
                  <div className="flex gap-0.5 mt-0.5">
                    {dayJobs.slice(0, 3).map((j, idx) => (
                      <span
                        key={idx}
                        className={`w-1 h-1 rounded-full ${isSelected ? 'bg-panel/70' : (JOB_TYPE_DOT[j.job_type] || 'bg-blue-500')}`}
                      />
                    ))}
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 mt-3 pt-3 border-t border-hairline">
          {Object.entries(JOB_TYPE_DOT).map(([type, color]) => (
            <span key={type} className="flex items-center gap-1 text-[10px] text-ink-3">
              <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
              {JOB_TYPE_LABEL[type]}
            </span>
          ))}
        </div>
      </div>

      {/* Event list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">
            {selectedDate
              ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Upcoming Cleanings'}
          </h3>
          {selectedDate && (
            <button onClick={() => setSelectedDate(null)} className="text-[10px] text-ink-3 hover:text-ink-3">
              Show all upcoming
            </button>
          )}
        </div>

        {listJobs.length === 0 ? (
          <div className="text-center py-10 bg-panel border border-hairline rounded-xl">
            <Calendar className="w-8 h-8 mx-auto mb-2 text-ink-3" />
            <p className="text-sm text-ink-3">
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
                <div key={j.id} onClick={() => onEditJob?.(j)}
                  className={`bg-panel border border-hairline rounded-xl p-4 flex items-start gap-3 transition-colors hover:border-blue-300 hover:shadow-sm cursor-pointer ${isPast ? 'opacity-60' : ''}`}
                  title="Click to edit / reschedule / cancel">
                  {/* Color bar */}
                  <div className={`w-1 self-stretch rounded-full shrink-0 ${dotColor}`} />

                  {/* Date block */}
                  <div className="text-center w-12 shrink-0 pt-0.5">
                    <div className="text-xs font-bold text-ink-2">
                      {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                    <div className="text-[10px] text-ink-3">
                      {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                    </div>
                  </div>

                  {/* Job info */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-ink truncate">{j.title}</div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-ink-3">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {j.start_time} – {j.end_time}
                      </span>
                      <span className="text-[10px] text-ink-3">|</span>
                      <span>{JOB_TYPE_LABEL[j.job_type] || j.job_type}</span>
                    </div>
                    {j.property_name && (
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-indigo-500 truncate">
                        <Home className="w-3 h-3 shrink-0" />{j.property_name}
                      </div>
                    )}
                    {j.address && (
                      <div className="flex items-center gap-1 mt-0.5 text-[11px] text-ink-3 truncate">
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
                    {/* Opt-in: email the customer a calendar invite so the event lands on their calendar */}
                    {!isPast && clientEmail && !j.calendar_invite_sent && (
                      <button onClick={(e) => { e.stopPropagation(); inviteCustomer(j.id) }} disabled={invitingId === j.id}
                        className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-blue-200 text-blue-600 hover:bg-blue-50 disabled:opacity-50 transition-colors"
                        title={`Invite ${clientEmail} to this event`}>
                        <Mail className="w-2.5 h-2.5" /> {invitingId === j.id ? 'Inviting…' : 'Invite'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      </>)}
    </div>
  )
}
