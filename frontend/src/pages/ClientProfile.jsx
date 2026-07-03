import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import RecordLink from '../components/RecordLink'
import ClientCRMSummary from '../components/ClientCRMSummary'
import OpportunityLinker from '../components/OpportunityLinker'
import JobCreateModal from '../components/JobCreateModal'
import JobEditModal from '../components/JobEditModal'
import ClientCalendarTab from '../components/client/ClientCalendarTab'
import ClientLeftRail from '../components/client/ClientLeftRail'
import MessagesTab from '../components/client/MessagesTab'
import PropertiesTab from '../components/client/PropertiesTab'
import ActivityTimeline from '../components/client/ActivityTimeline'
import ClientMobileHeader from '../components/client/ClientMobileHeader'
import ClientDetailsTab from '../components/client/ClientDetailsTab'
import {
  RecurringTab, JobsListTab, QuotesListTab, InvoicesListTab, OpportunitiesTab,
} from '../components/client/ClientListTabs'
import {
  STATUS_COLORS, JOB_COLORS, INVOICE_COLORS, QUOTE_COLORS,
  PROPERTY_TYPE_COLORS, PROPERTY_TYPE_LABELS, INPUT_CLASS,
  EMPTY_ICAL, OPP_COLORS,
} from '../components/client/constants'
import { del, get, post, patch } from "../api"
import { useToast } from '../components/ui/Toast'
import {
  ArrowLeft, Phone, Mail, MapPin, Edit2, Save, X,
  Plus, Calendar, FileText, Receipt, MessageSquare,
  CheckCircle, Clock, AlertCircle, Send, ChevronLeft, ChevronRight, Home, RefreshCw,
  TrendingUp, DollarSign, Target, Inbox, ArrowUpRight, Zap, Trash2
} from 'lucide-react'

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
  const [tab, setTab] = useState('activity')  // Twenty leads with the Timeline
  const [activityFilter, setActivityFilter] = useState('all')
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
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

  // iCal feed management (STR turnover automation).
  // EMPTY_ICAL lives in components/client/constants so PropertiesTab and
  // the parent's reset handlers share one canonical shape.
  const [icalForm, setIcalForm] = useState(EMPTY_ICAL)
  const [showIcalForm, setShowIcalForm] = useState(false)
  const [syncingPropId, setSyncingPropId] = useState(null)
  const [syncBanner, setSyncBanner] = useState(null)

  // Schedule form state

  // One-off job creation modal
  const [jobModal, setJobModal] = useState(null)  // null | { propertyId?: number }
  // Deep-link "Schedule job for <client>" (e.g. from Cmd+K): /clients/:id?schedule=1
  // opens the schedule modal pre-scoped to this client, then strips the param.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('schedule') === '1') {
      setJobModal({})
      const next = new URLSearchParams(searchParams); next.delete('schedule')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])
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

  const reloadActivities = async () => {
    try {
      const acts = await get(`/api/activities?client_id=${id}&limit=50`)
      setActivities(Array.isArray(acts) ? acts : [])
    } catch { /* non-fatal */ }
  }

  const submitNote = async () => {
    if (savingNote) return  // guard against ⌘/Ctrl+Enter repeats while in flight
    const body = noteText.trim()
    if (!body) return
    setSavingNote(true)
    try {
      await post(`/api/clients/${id}/notes`, { body })
      setNoteText('')
      await reloadActivities()
      toast.success('Note added')
    } catch (e) {
      toast.error(e.message || 'Could not add note')
    }
    setSavingNote(false)
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

  // Twenty-style inline save: patch a single client field and update locally.
  const [savingField, setSavingField] = useState(null)
  const saveField = async (key, value) => {
    setSavingField(key)
    try {
      const updated = await patch(`/api/clients/${id}`, { [key]: value })
      setClient(c => ({ ...c, ...(updated && typeof updated === 'object' ? updated : {}), [key]: value }))
      toast.success('Saved')
    } catch (e) {
      toast.error('Could not save: ' + (e?.message || 'unknown error'))
    } finally {
      setSavingField(null)
    }
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
      toast.error('Could not save: ' + (e?.message || 'unknown error'))
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
  // Null-safe: some jobs (legacy / unscheduled) have a null scheduled_date —
  // calling .localeCompare on null crashed the whole profile page.
  const upcomingJobs = jobs
    .filter(j => j.scheduled_date && j.scheduled_date >= todayStr && j.status !== 'cancelled')
    .sort((a, b) => (a.scheduled_date || '').localeCompare(b.scheduled_date || '') || (a.start_time || '').localeCompare(b.start_time || ''))
  const pastJobs = jobs
    .filter(j => (j.scheduled_date && j.scheduled_date < todayStr) || j.status === 'cancelled')
    .sort((a, b) => (b.scheduled_date || '').localeCompare(a.scheduled_date || ''))
  const nextJob = upcomingJobs[0] || null

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

  return (
    <div className="flex h-full overflow-hidden" data-testid="client-profile-root">
      {/* Twenty-style left record rail (desktop): identity, fields, related. */}
      <ClientLeftRail
        client={client} navigate={navigate} setTab={setTab}
        savingField={savingField} saveField={saveField}
        visitStats={visitStats} upcomingJobs={upcomingJobs}
        totalRevenue={totalRevenue} outstanding={outstanding}
        properties={properties}
      />

      {/* Main column: tabs + Timeline/content */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-y-auto sm:overflow-hidden">
      {/* Header (mobile only — desktop uses the left rail) */}
      <ClientMobileHeader
        client={client} navigate={navigate} setTab={setTab}
        visitStats={visitStats} upcomingJobs={upcomingJobs}
        totalRevenue={totalRevenue} outstanding={outstanding}
        quickContactOpen={quickContactOpen} setQuickContactOpen={setQuickContactOpen}
        quickContact={quickContact} setQuickContact={setQuickContact}
        quickContactSaving={quickContactSaving}
        openQuickContact={openQuickContact} saveQuickContact={saveQuickContact}
      />

      {/* Quick actions */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center gap-2 px-4 sm:px-6 py-3 bg-panel/50 border-b border-hairline shrink-0">
        <button onClick={() => navigate('/billing?view=quotes', { state: { openNew: true, clientId: parseInt(id) } })}
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
          <ActivityTimeline
            allActivity={allActivity}
            activityFilter={activityFilter} setActivityFilter={setActivityFilter}
            noteText={noteText} setNoteText={setNoteText}
            savingNote={savingNote} submitNote={submitNote}
          />
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
          <PropertiesTab
            properties={properties} navigate={navigate} setJobModal={setJobModal}
            propForm={propForm} setPropForm={setPropForm}
            showPropForm={showPropForm} setShowPropForm={setShowPropForm}
            editingProp={editingProp}
            savingProp={savingProp} saveProp={saveProp} deleteProp={deleteProp}
            openNewProp={openNewProp} openEditProp={openEditProp}
            icalForm={icalForm} setIcalForm={setIcalForm}
            showIcalForm={showIcalForm} setShowIcalForm={setShowIcalForm}
            addIcal={addIcal} removeIcal={removeIcal}
            syncingPropId={syncingPropId} syncProperty={syncProperty}
            syncBanner={syncBanner} setSyncBanner={setSyncBanner}
          />
        )}

        {/* Recurring schedules */}
        {tab === 'recurring' && (
          <RecurringTab schedules={schedules} />
        )}

        {/* Jobs */}
        {tab === 'jobs' && (
          <JobsListTab
            jobs={jobs} upcomingJobs={upcomingJobs} pastJobs={pastJobs}
            clientId={id} onLinked={() => load()}
          />
        )}

        {/* Quotes */}
        {tab === 'quotes' && (
          <QuotesListTab
            quotes={quotes} clientId={id} navigate={navigate}
            onLinked={() => load()}
          />
        )}

        {/* Invoices */}
        {tab === 'invoices' && (
          <InvoicesListTab
            invoices={invoices} clientId={id} onLinked={() => load()}
          />
        )}

        {/* Messages */}
        {tab === 'messages' && (
          <MessagesTab
            client={client} messages={messages} emails={emails}
            commsFilter={commsFilter} setCommsFilter={setCommsFilter}
            smsText={smsText} setSmsText={setSmsText}
            sendSms={sendSms} sending={sending}
          />
        )}

        {/* Details / Edit */}
        {tab === 'details' && (
          <ClientDetailsTab
            form={form} setForm={setForm}
            upcomingJobs={upcomingJobs}
            saving={saving} save={save}
            showBilling={showBilling} setShowBilling={setShowBilling}
          />
        )}

        {/* Opportunities */}
        {tab === 'opportunities' && (
          <OpportunitiesTab
            opportunities={opportunities} navigate={navigate}
          />
        )}

        {/* Emails */}
      </div>
      </div>


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
