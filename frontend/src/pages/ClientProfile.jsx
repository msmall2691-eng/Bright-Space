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
import ClientOverview from '../components/client/ClientOverview'
import ClientProfileSkeleton from '../components/client/ClientProfileSkeleton'
import {
  RecurringTab, JobsListTab, QuotesListTab, InvoicesListTab, OpportunitiesTab,
} from '../components/client/ClientListTabs'
import { useClientProfileData } from '../hooks/useClientProfileData'
import {
  STATUS_COLORS, JOB_COLORS, INVOICE_COLORS, QUOTE_COLORS,
  PROPERTY_TYPE_COLORS, PROPERTY_TYPE_LABELS, INPUT_CLASS,
  EMPTY_ICAL, OPP_COLORS,
} from '../components/client/constants'
import { del, get, post, patch } from "../api"
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import {
  ArrowLeft, Phone, Mail, MapPin, Edit2, Save, X,
  Plus, Calendar, FileText, Receipt, MessageSquare,
  CheckCircle, Clock, AlertCircle, Send, ChevronLeft, ChevronRight, Home, RefreshCw,
  TrendingUp, DollarSign, Target, Inbox, ArrowUpRight, Zap, Trash2, LayoutGrid
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

// Second-level pills for a top Tab that covers more than one sub-view.
// Both "Schedule" and "Money" only ever landed on their first sub-view
// (calendar / quotes) — 'jobs'/'recurring' and 'invoices'/'opportunities'
// were real tab values with real content, just unreachable from the UI.
function SubNav({ items, active, onSelect }) {
  return (
    <div className="flex items-center gap-1 px-4 sm:px-6 py-2 border-b border-hairline bg-bg/40 overflow-x-auto">
      {items.map(it => (
        <button key={it.key} onClick={() => onSelect(it.key)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
            active === it.key ? 'bg-blue-500/15 text-blue-500' : 'text-ink-3 hover:text-ink-2 hover:bg-bg-2'
          }`}>
          {it.label}
          {it.count > 0 && <span className="ml-1.5 opacity-70">{it.count}</span>}
        </button>
      ))}
    </div>
  )
}

export default function ClientProfile() {
  const { id } = useParams()
  const navigate = useNavigate()

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
  const {
    client, setClient,
    jobs, quotes, invoices, messages, emails,
    properties, schedules, opportunities, intakes,
    visitStats, timelineEvents,
    load, reloadActivities, reloadProperties,
    totalRevenue, outstanding, upcomingJobs, pastJobs, allActivity,
  } = useClientProfileData(id)

  const [tab, setTab] = useState('overview')  // Customer 360 at-a-glance landing
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
  // Seed the form / billing-showing state from the loaded client. This lives in
  // the page (not the data hook) because `form` and `showBilling` are UI state
  // — the same client can render with different form drafts across tabs.
  useEffect(() => {
    if (!client) return
    const formFill = { ...client }
    if ((!formFill.first_name || !formFill.first_name.trim())
        && (!formFill.last_name || !formFill.last_name.trim())
        && client.name) {
      const parts = client.name.trim().split(/\s+/)
      formFill.first_name = parts[0] || ''
      formFill.last_name = parts.slice(1).join(' ') || ''
    }
    setForm(formFill)
    if (client.billing_address || client.billing_city || client.billing_state || client.billing_zip) {
      setShowBilling(true)
    }
  }, [client])

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
    if (!(await confirmDialog('Remove this property?'))) return
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
    if (!(await confirmDialog('Remove this calendar feed?'))) return
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

  if (!client) return <ClientProfileSkeleton />

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
        <Tab label="Overview" icon={LayoutGrid} active={['overview', 'details', 'crm'].includes(tab)} count={0} onClick={() => setTab('overview')} />
        <Tab label="Properties" icon={Home} active={tab === 'properties'} count={properties.length} onClick={() => setTab('properties')} />
        <Tab label="Schedule" icon={Calendar} active={['calendar', 'recurring', 'jobs'].includes(tab)} count={upcomingJobs.length} onClick={() => setTab('calendar')} />
        <Tab label="Timeline" icon={Clock} active={tab === 'activity'} count={allActivity.length} onClick={() => setTab('activity')} />
        <Tab label="Messages" icon={MessageSquare} active={tab === 'messages'} count={messages.length + emails.length} onClick={() => setTab('messages')} />
        <Tab label="Money" icon={DollarSign} active={['quotes', 'invoices', 'opportunities'].includes(tab)} count={quotes.length + invoices.length} onClick={() => setTab('quotes')} />
      </div>

      {['calendar', 'jobs', 'recurring'].includes(tab) && (
        <SubNav
          active={tab}
          onSelect={setTab}
          items={[
            { key: 'calendar', label: 'Calendar' },
            { key: 'jobs', label: 'All Jobs', count: jobs.length },
            { key: 'recurring', label: 'Recurring', count: schedules.length },
          ]}
        />
      )}
      {['quotes', 'invoices', 'opportunities'].includes(tab) && (
        <SubNav
          active={tab}
          onSelect={setTab}
          items={[
            { key: 'quotes', label: 'Quotes', count: quotes.length },
            { key: 'invoices', label: 'Invoices', count: invoices.length },
            { key: 'opportunities', label: 'Opportunities', count: opportunities.length },
          ]}
        />
      )}

      {/* Tab content */}
      <div className="p-4 sm:p-6 pb-28 sm:pb-6 sm:flex-1 sm:overflow-y-auto sm:scrollbar-thin">

        {/* Customer 360 — at-a-glance overview (default landing) */}
        {tab === 'overview' && (
          <ClientOverview
            client={client} navigate={navigate} setTab={setTab}
            totalRevenue={totalRevenue} outstanding={outstanding}
            invoices={invoices} quotes={quotes}
            upcomingJobs={upcomingJobs} pastJobs={pastJobs}
            schedules={schedules} properties={properties}
            visitStats={visitStats} allActivity={allActivity}
            intakes={intakes}
          />
        )}

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
            quotes={quotes} clientId={id}
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

    </div>
  )
}
