import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, X, Calendar, Clock, MapPin, Users, ChevronDown,
  CheckCircle, AlertCircle, Trash2, Edit3, Send, Repeat, RefreshCw,
  Filter, Home
} from 'lucide-react'
import CalendarView from '../components/CalendarView'
import AgentWidget from '../components/AgentWidget'
import { get, post, patch, del } from '../api'

const JOB_TYPES = [
  { value: 'residential',  label: 'Residential' },
  { value: 'commercial',   label: 'Commercial' },
  { value: 'str_turnover', label: 'STR Turnover' },
]

const STATUS_OPTIONS = [
  { value: 'scheduled',   label: 'Scheduled',   color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  { value: 'completed',   label: 'Completed',   color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { value: 'cancelled',   label: 'Cancelled',   color: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
]

const TYPE_BADGE = {
  residential:  'bg-blue-50 text-blue-700 border-blue-200',
  commercial:   'bg-green-50 text-green-700 border-green-200',
  str_turnover: 'bg-orange-50 text-orange-700 border-orange-200',
}

const EMPTY_FORM = {
  client_id: '',
  title: '',
  job_type: 'residential',
  scheduled_date: '',
  start_time: '09:00',
  end_time: '12:00',
  address: '',
  cleaner_ids: [],
  notes: '',
  property_id: '',
}

export default function Scheduling() {
  const navigate = useNavigate()

  // Panel state: null | 'create' | 'edit' | 'view'
  const [panel, setPanel] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editingJob, setEditingJob] = useState(null)
  const [viewingJob, setViewingJob] = useState(null)

  // Data
  const [clients, setClients] = useState([])
  const [employees, setEmployees] = useState([])
  const [clientProperties, setClientProperties] = useState([])

  // UI state
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [converting, setConverting] = useState(false)

  // GCal sync
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)

  // Mobile: toggle between calendar and list view
  const [mobileView, setMobileView] = useState('calendar')
  // Jobs for list view on mobile
  const [upcomingJobs, setUpcomingJobs] = useState([])

  // Filters
  const [filters, setFilters] = useState({ job_type: '', status: '', property_id: '' })
  const [allProperties, setAllProperties] = useState([])
  const [showFilters, setShowFilters] = useState(false)
  const activeFilterCount = Object.values(filters).filter(Boolean).length

  // Load clients, employees, and properties once
  useEffect(() => {
    get('/api/clients?status=active').then(setClients).catch(() => {})
    get('/api/dispatch/employees')
      .then(data => setEmployees(Array.isArray(data) ? data : []))
      .catch(() => {})
    get('/api/properties')
      .then(data => setAllProperties(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  // Load upcoming jobs for mobile list view
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10)
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    get(`/api/jobs?date_from=${today}&date_to=${future}`)
      .then(data => setUpcomingJobs(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [refreshKey])

  // Load properties when client changes in form
  useEffect(() => {
    if (!form.client_id) { setClientProperties([]); return }
    get(`/api/properties?client_id=${form.client_id}`)
      .then(props => setClientProperties(Array.isArray(props) ? props : []))
      .catch(() => setClientProperties([]))
  }, [form.client_id])

  // Sync from Google Calendar (GCal is source of truth)
  const syncFromGCal = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await post('/api/jobs/sync-gcal')
      setSyncResult(result)
      setRefreshKey(k => k + 1)
    } catch (e) {
      setSyncResult({ error: e.message || 'Sync failed' })
    }
    setSyncing(false)
    // Auto-dismiss after 5 seconds
    setTimeout(() => setSyncResult(null), 5000)
  }

  const clientName = (id) => clients.find(c => c.id === id)?.name || ''
  const empName = (id) => {
    const e = employees.find(e => e.id === id || e.userId === id)
    return e ? (e.name || e.displayName || id) : id
  }

  // Open create panel for a specific date
  const handleDayClick = useCallback((date) => {
    setForm({ ...EMPTY_FORM, scheduled_date: date })
    setEditingJob(null)
    setViewingJob(null)
    setPanel('create')
    setSaveError(null)
  }, [])

  // Open view panel for clicked job
  const handleJobClick = useCallback((job) => {
    setViewingJob(job)
    setPanel('view')
    setSaveError(null)
  }, [])

  // Switch from view to edit mode
  const startEditing = () => {
    const job = viewingJob
    setEditingJob(job)
    setForm({
      client_id: job.client_id || '',
      title: job.title || '',
      job_type: job.job_type || 'residential',
      scheduled_date: job.scheduled_date || '',
      start_time: job.start_time || '09:00',
      end_time: job.end_time || '12:00',
      address: job.address || '',
      cleaner_ids: job.cleaner_ids || [],
      notes: job.notes || '',
      property_id: job.property_id || '',
    })
    setPanel('edit')
    setSaveError(null)
  }

  const closePanel = () => {
    setPanel(null)
    setEditingJob(null)
    setViewingJob(null)
    setSaveError(null)
  }

  // Auto-fill address from client if they only have one
  const onClientChange = (clientId) => {
    const client = clients.find(c => c.id === parseInt(clientId))
    setForm(f => ({
      ...f,
      client_id: clientId,
      address: client?.address ? [client.address, client.city, client.state].filter(Boolean).join(', ') : f.address,
      title: f.title || (client ? `${client.name} â Clean` : ''),
      property_id: '',
    }))
  }

  const selectProperty = (prop) => {
    setForm(f => ({
      ...f,
      property_id: prop.id,
      address: [prop.address, prop.city, prop.state].filter(Boolean).join(', '),
      job_type: prop.property_type === 'commercial' ? 'commercial'
              : prop.property_type === 'str'        ? 'str_turnover'
              : f.job_type,
    }))
  }

  // Toggle cleaner assignment
  const toggleCleaner = (id) => {
    setForm(f => ({
      ...f,
      cleaner_ids: f.cleaner_ids.includes(id)
        ? f.cleaner_ids.filter(x => x !== id)
        : [...f.cleaner_ids, id]
    }))
  }

  // Save (create or update)
  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const body = {
        ...form,
        client_id: parseInt(form.client_id),
        property_id: form.property_id ? parseInt(form.property_id) : null,
      }
      if (panel === 'edit' && editingJob) {
        await patch(`/api/jobs/${editingJob.id}`, body)
      } else {
        await post('/api/jobs', body)
      }
      setRefreshKey(k => k + 1)
      closePanel()
    } catch (e) {
      setSaveError(e.message || 'Failed to save job')
    }
    setSaving(false)
  }

  // Update job status
  const updateStatus = async (jobId, status) => {
    setStatusUpdating(true)
    try {
      const updated = await patch(`/api/jobs/${jobId}`, { status })
      setViewingJob(updated)
      setRefreshKey(k => k + 1)
    } catch (e) {
      setSaveError(e.message || 'Failed to update status')
    }
    setStatusUpdating(false)
  }

  // Delete job
  const deleteJob = async (jobId) => {
    setDeleting(true)
    try {
      await del(`/api/jobs/${jobId}`)
      setRefreshKey(k => k + 1)
      closePanel()
    } catch (e) {
      setSaveError(e.message || 'Failed to delete job')
    }
    setDeleting(false)
  }

  // Invite client to GCal event â the "I'm ready" button
  const inviteClient = async (jobId) => {
    setInviting(true)
    try {
      const result = await post(`/api/jobs/${jobId}/invite-client`)
      // Update the viewing job to reflect invite sent
      setViewingJob(prev => prev ? { ...prev, calendar_invite_sent: true } : prev)
      setRefreshKey(k => k + 1)
    } catch (e) {
      setSaveError(e.message || 'Failed to send invite')
    }
    setInviting(false)
  }

  const convertToInvoice = async (jobId) => {
    setConverting(true)
    try {
      const invoice = await post(`/api/jobs/${jobId}/convert-to-invoice`)
      setSaveError(null)
      navigate(`/invoicing`, { state: { invoiceId: invoice.id } })
    } catch (e) {
      setSaveError(e.message || 'Failed to create invoice')
    }
    setConverting(false)
  }

  const statusConfig = (s) => STATUS_OPTIONS.find(o => o.value === s) || STATUS_OPTIONS[0]

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Mobile toggle bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 lg:hidden">
        <div className="flex bg-zinc-100 rounded-lg p-0.5">
          <button
            onClick={() => setMobileView('calendar')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              mobileView === 'calendar' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'
            }`}
          >
            <Calendar className="w-3.5 h-3.5 inline mr-1" />Calendar
          </button>
          <button
            onClick={() => setMobileView('list')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              mobileView === 'list' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'
            }`}
          >
            List
          </button>
        </div>
        <button onClick={() => handleDayClick(new Date().toISOString().slice(0, 10))}
          className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium">
          <Plus className="w-3.5 h-3.5" /> New Job
        </button>
      </div>

      {/* Desktop header */}
      <div className="hidden lg:flex items-center justify-between px-6 py-3 border-b border-zinc-200">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-zinc-900">Schedule</h2>
          <span className="text-[10px] text-zinc-400 bg-zinc-100 px-2 py-0.5 rounded-full">Synced with Google Calendar</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={syncFromGCal} disabled={syncing}
            className="flex items-center gap-1.5 bg-white hover:bg-zinc-50 border border-zinc-200 px-3 py-2 rounded-lg text-xs text-zinc-500 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync GCal'}
          </button>
          <button onClick={() => handleDayClick(new Date().toISOString().slice(0, 10))}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Job
          </button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className={`mx-4 lg:mx-6 mt-2 rounded-lg px-4 py-3 text-sm border ${
          syncResult.error
            ? 'bg-red-50 border-red-200 text-red-700'
            : 'bg-emerald-50 border-emerald-200 text-emerald-700'
        }`}>
          <div className="flex items-center gap-2">
            {syncResult.error ? (
              <><AlertCircle className="w-4 h-4 shrink-0" /><span className="font-medium">Sync failed:</span> {syncResult.error}</>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 shrink-0" />
                <div>
                  <span className="font-medium">Synced {syncResult.events_scanned || 0} event{syncResult.events_scanned !== 1 ? 's' : ''}</span>
                  {' from '}
                  {syncResult.calendars_synced || 0} calendar{syncResult.calendars_synced !== 1 ? 's' : ''}
                  {(syncResult.jobs_created > 0 || syncResult.jobs_updated > 0 || syncResult.jobs_cancelled > 0) && (
                    <span className="text-xs ml-2 opacity-80">
                      ({[
                        syncResult.jobs_created > 0 && `${syncResult.jobs_created} created`,
                        syncResult.jobs_updated > 0 && `${syncResult.jobs_updated} updated`,
                        syncResult.jobs_cancelled > 0 && `${syncResult.jobs_cancelled} cancelled`,
                      ].filter(Boolean).join(', ')})
                    </span>
                  )}
                </div>
              </>
            )}
            <button onClick={() => setSyncResult(null)} className="ml-auto opacity-60 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
          {syncResult.unmatched > 0 && (
            <p className="mt-1.5 text-xs opacity-75">
              {syncResult.unmatched} event(s) couldn't be matched to a client â add their email as attendee or use a known address in the location field.
            </p>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div className="hidden lg:block border-b border-zinc-200 bg-white/50">
        <div className="flex items-center gap-2 px-6 py-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              activeFilterCount > 0
                ? 'bg-blue-50 border-blue-200 text-blue-600'
                : 'bg-white border-zinc-200 text-zinc-500 hover:bg-zinc-50'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            Filters
            {activeFilterCount > 0 && (
              <span className="bg-blue-600 text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Quick filter pills */}
          {JOB_TYPES.map(t => (
            <button
              key={t.value}
              onClick={() => setFilters(f => ({ ...f, job_type: f.job_type === t.value ? '' : t.value }))}
              className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
                filters.job_type === t.value
                  ? TYPE_BADGE[t.value]
                  : 'bg-white border-zinc-200 text-zinc-400 hover:bg-zinc-50'
              }`}
            >
              {t.label}
            </button>
          ))}

          <span className="text-zinc-200">|</span>

          {STATUS_OPTIONS.map(s => (
            <button
              key={s.value}
              onClick={() => setFilters(f => ({ ...f, status: f.status === s.value ? '' : s.value }))}
              className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
                filters.status === s.value
                  ? s.color
                  : 'bg-white border-zinc-200 text-zinc-400 hover:bg-zinc-50'
              }`}
            >
              {s.label}
            </button>
          ))}

          {activeFilterCount > 0 && (
            <button
              onClick={() => setFilters({ job_type: '', status: '', property_id: '' })}
              className="text-[11px] text-zinc-400 hover:text-zinc-600 ml-1"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Expanded property filter */}
        {showFilters && allProperties.length > 0 && (
          <div className="px-6 pb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-zinc-400 uppercase tracking-wide flex items-center gap-1">
                <Home className="w-3 h-3" /> Property:
              </span>
              {allProperties.map(p => (
                <button
                  key={p.id}
                  onClick={() => setFilters(f => ({ ...f, property_id: f.property_id === String(p.id) ? '' : String(p.id) }))}
                  className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
                    filters.property_id === String(p.id)
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-600'
                      : 'bg-white border-zinc-200 text-zinc-400 hover:bg-zinc-50'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0 relative">
        {/* Calendar view (desktop always, mobile toggled) */}
        <div className={`flex-1 min-w-0 ${mobileView !== 'calendar' ? 'hidden lg:flex' : 'flex'}`}>
          <CalendarView
            onJobClick={handleJobClick}
            onDayClick={handleDayClick}
            refreshKey={refreshKey}
            filters={filters}
          />
        </div>

        {/* Mobile list view */}
        {mobileView === 'list' && (
          <div className="flex-1 overflow-y-auto p-4 lg:hidden">
            <MobileJobList
              jobs={upcomingJobs.filter(j => {
                if (filters.job_type && j.job_type !== filters.job_type) return false
                if (filters.status && j.status !== filters.status) return false
                if (filters.property_id && String(j.property_id) !== filters.property_id) return false
                return true
              })}
              onJobClick={handleJobClick}
              statusConfig={statusConfig}
            />
          </div>
        )}

        {/* Side panel (create / edit / view) */}
        {panel && (
          <>
            {/* Mobile backdrop */}
            <div className="fixed inset-0 bg-black/30 z-30 lg:hidden" onClick={closePanel} />

            <div className="fixed inset-y-0 right-0 w-full max-w-md z-40 bg-white border-l border-zinc-200 flex flex-col
                            lg:static lg:inset-auto lg:w-[400px] lg:z-auto lg:max-w-none lg:shrink-0">
              {/* Panel header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200">
                <h3 className="font-semibold text-zinc-900 text-sm">
                  {panel === 'create' ? 'New Job' : panel === 'edit' ? 'Edit Job' : viewingJob?.title || 'Job Details'}
                </h3>
                <button onClick={closePanel} className="p-1.5 hover:bg-zinc-100 rounded-lg text-zinc-400">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {panel === 'view' ? (
                  <JobViewPanel
                    job={viewingJob}
                    clients={clients}
                    employees={employees}
                    empName={empName}
                    statusConfig={statusConfig}
                    onEdit={startEditing}
                    onDelete={deleteJob}
                    onStatusChange={updateStatus}
                    onInviteClient={inviteClient}
                    onConvertToInvoice={convertToInvoice}
                    onNavigateToClient={(clientId) => navigate(`/clients/${clientId}`)}
                    deleting={deleting}
                    statusUpdating={statusUpdating}
                    inviting={inviting}
                    converting={converting}
                    saveError={saveError}
                  />
                ) : (
                  <JobFormPanel
                    form={form}
                    setForm={setForm}
                    clients={clients}
                    employees={employees}
                    clientProperties={clientProperties}
                    isEdit={panel === 'edit'}
                    saving={saving}
                    saveError={saveError}
                    onSave={save}
                    onClientChange={onClientChange}
                    onSelectProperty={selectProperty}
                    onToggleCleaner={toggleCleaner}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <AgentWidget
        pageContext="scheduling"
        prompts={[
          "What's on the schedule this week?",
          'Which jobs are missing cleaner assignments?',
          'Show me all cancelled jobs this month',
        ]}
      />
    </div>
  )
}


/* ââââââââââââââââââââââââââââââ Job View Panel ââââââââââââââââââââââââââââââ */

function JobViewPanel({ job, clients, employees, empName, statusConfig, onEdit, onDelete, onStatusChange, onInviteClient, onConvertToInvoice, onNavigateToClient, deleting, statusUpdating, inviting, converting, saveError }) {
  if (!job) return null
  const sc = statusConfig(job.status)
  const typeBadge = TYPE_BADGE[job.job_type] || TYPE_BADGE.residential
  const client = clients.find(c => c.id === job.client_id)

  return (
    <div className="p-5 space-y-5">
      {/* Title + badges */}
      <div>
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-base font-semibold text-zinc-900 break-words" title={job.title}>{job.title}</h3>
          <div className="flex gap-1.5 shrink-0">
            <button onClick={onEdit} className="p-1.5 hover:bg-zinc-100 rounded-lg text-zinc-400 hover:text-zinc-500" title="Edit">
              <Edit3 className="w-4 h-4" />
            </button>
            <button onClick={() => onDelete(job.id)} disabled={deleting}
              className="p-1.5 hover:bg-red-50 rounded-lg text-zinc-400 hover:text-red-500" title="Delete">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${typeBadge}`}>
            {JOB_TYPES.find(t => t.value === job.job_type)?.label || job.job_type}
          </span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${sc.color}`}>
            {sc.label}
          </span>
          {job.recurring_schedule_id && (
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-purple-200 bg-purple-50 text-purple-700 font-medium flex items-center gap-1">
              <Repeat className="w-3 h-3" /> Recurring
            </span>
          )}
        </div>
      </div>

      {/* Details grid */}
      <div className="space-y-3">
        {client && (
          <div className="flex items-start gap-3">
            <Users className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-[10px] text-zinc-400 uppercase tracking-wide">Client</p>
              <button
                onClick={() => onNavigateToClient?.(client.id)}
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline font-medium text-left"
              >
                {client.name}
              </button>
            </div>
          </div>
        )}
        <DetailRow icon={Calendar} label="Date" value={job.scheduled_date ? new Date(job.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }) : 'Not set'} />
        <DetailRow icon={Clock} label="Time" value={job.start_time && job.end_time ? `${job.start_time} – ${job.end_time}` : 'Not set'} />
        {job.address && <DetailRow icon={MapPin} label="Address" value={job.address} />}
      </div>

      {/* Assigned cleaners */}
      <div>
        <p className="text-xs text-zinc-400 font-medium mb-2">Assigned Cleaners</p>
        {job.cleaner_ids?.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {job.cleaner_ids.map(id => (
              <span key={id} className="text-xs bg-zinc-100 text-zinc-600 px-2.5 py-1 rounded-full border border-zinc-200">
                {empName(id)}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-amber-600 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> No cleaners assigned
          </p>
        )}
      </div>

      {/* Notes */}
      {job.notes && (
        <div>
          <p className="text-xs text-zinc-400 font-medium mb-1">Notes</p>
          <p className="text-sm text-zinc-500 whitespace-pre-wrap">{job.notes}</p>
        </div>
      )}

      {/* Client invite action */}
      <div className="border-t border-gray-100 pt-4">
        {job.calendar_invite_sent ? (
          <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5">
            <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
            <div>
              <p className="text-xs font-medium text-emerald-700">Client invited</p>
              <p className="text-[10px] text-emerald-600">
                {client?.email ? `Invite sent to ${client.email}` : 'Invite sent via Google Calendar'}
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2.5">
            <p className="text-xs text-zinc-500 mb-2">
              This job is on <span className="font-medium">your</span> Google Calendar only.
              {client?.email
                ? ' When you\'re ready, invite the client so they see it too.'
                : ' Add an email to the client to send them an invite.'}
            </p>
            {client?.email && (
              <button
                onClick={() => onInviteClient(job.id)}
                disabled={inviting}
                className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-gray-300 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              >
                <Send className="w-3 h-3" />
                {inviting ? 'Sending...' : `Invite ${client.name || 'Client'}`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Other integrations */}
      <div className="flex flex-wrap gap-2">
        {job.gcal_event_id && (
          <span className="text-[11px] bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-1 rounded-lg flex items-center gap-1">
            <Calendar className="w-3 h-3" /> On Google Calendar
          </span>
        )}
        {job.sms_reminder_sent && (
          <span className="text-[11px] bg-green-50 text-green-600 border border-green-200 px-2 py-1 rounded-lg flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> SMS Sent
          </span>
        )}
        {job.dispatched && (
          <span className="text-[11px] bg-emerald-50 text-emerald-600 border border-emerald-200 px-2 py-1 rounded-lg flex items-center gap-1">
            <Send className="w-3 h-3" /> Dispatched
          </span>
        )}
      </div>

      {/* Status actions */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs text-zinc-400 font-medium mb-2">Update Status</p>
        <div className="grid grid-cols-2 gap-2">
          {STATUS_OPTIONS.map(s => (
            <button
              key={s.value}
              onClick={() => onStatusChange(job.id, s.value)}
              disabled={statusUpdating || job.status === s.value}
              className={`text-xs px-3 py-2 rounded-lg border font-medium transition-colors disabled:opacity-40 ${
                job.status === s.value ? s.color + ' cursor-default' : 'bg-white border-zinc-200 text-zinc-500 hover:bg-zinc-50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Create invoice action */}
      {job.status === 'completed' && (
        <button
          onClick={() => onConvertToInvoice(job.id)}
          disabled={converting}
          className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-zinc-300 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
        >
          <CheckCircle className="w-4 h-4" />
          {converting ? 'Creating Invoice...' : 'Create Invoice'}
        </button>
      )}

      {saveError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-xs">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {saveError}
        </div>
      )}
    </div>
  )
}

function DetailRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
      <div>
        <p className="text-[10px] text-zinc-400 uppercase tracking-wide">{label}</p>
        <p className="text-sm text-gray-800">{value}</p>
      </div>
    </div>
  )
}


/* ââââââââââââââââââââââââââââââ Job Form Panel ââââââââââââââââââââââââââââââ */

function JobFormPanel({ form, setForm, clients, employees, clientProperties, isEdit, saving, saveError, onSave, onClientChange, onSelectProperty, onToggleCleaner }) {
  const canSave = form.client_id && form.title && form.scheduled_date && form.start_time && form.end_time

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {/* Client */}
        <Field label="Client *">
          <select value={form.client_id} onChange={e => onClientChange(e.target.value)}
            className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
            <option value="">Select client...</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        {/* Property picker (if client has properties) */}
        {form.client_id && clientProperties.length > 0 && (
          <Field label="Property">
            <div className="space-y-1.5">
              {clientProperties.map(p => (
                <button key={p.id} onClick={() => onSelectProperty(p)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left border transition-colors ${
                    parseInt(form.property_id) === p.id
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-zinc-50 border-zinc-200 text-zinc-500 hover:bg-zinc-100'
                  }`}>
                  <MapPin className="w-3.5 h-3.5 shrink-0 opacity-60" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{p.name}</div>
                    {p.address && <div className="text-[10px] text-zinc-500 truncate">{p.address}</div>}
                  </div>
                </button>
              ))}
            </div>
          </Field>
        )}

        {/* Title */}
        <Field label="Job Title *">
          <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="e.g. Smith Residence â Deep Clean"
            className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
        </Field>

        {/* Job type */}
        <Field label="Service Type">
          <div className="flex gap-2">
            {JOB_TYPES.map(t => (
              <button key={t.value} onClick={() => setForm(f => ({ ...f, job_type: t.value }))}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                  form.job_type === t.value
                    ? 'bg-blue-600 text-white border-gray-900'
                    : 'bg-white text-zinc-500 border-zinc-200 hover:bg-zinc-50'
                }`}>
                {t.label}
              </button>
            ))}
          </div>
        </Field>

        {/* Date */}
        <Field label="Date *">
          <input type="date" value={form.scheduled_date}
            onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
            className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
        </Field>

        {/* Time */}
        <div className="flex gap-3">
          <Field label="Start *" className="flex-1">
            <input type="time" value={form.start_time}
              onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
              className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </Field>
          <Field label="End *" className="flex-1">
            <input type="time" value={form.end_time}
              onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
              className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </Field>
        </div>

        {/* Address */}
        <Field label="Service Address">
          <input value={form.address || ''} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
            placeholder="123 Main St, Portland, ME"
            className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
        </Field>

        {/* Cleaner assignment */}
        <Field label="Assign Cleaners">
          {employees.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {employees.map(e => {
                const id = e.id || e.userId
                const name = e.name || e.displayName || id
                const selected = form.cleaner_ids.includes(id)
                return (
                  <button key={id} onClick={() => onToggleCleaner(id)}
                    className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                      selected
                        ? 'bg-blue-600 text-white border-gray-900'
                        : 'bg-white text-zinc-500 border-zinc-200 hover:bg-zinc-50'
                    }`}>
                    {name}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-zinc-400">No Connecteam employees loaded</p>
          )}
        </Field>

        {/* Notes */}
        <Field label="Notes">
          <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            rows={2} placeholder="Special instructions, access codes, etc."
            className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
        </Field>
      </div>

      {/* Save footer */}
      <div className="p-5 border-t border-zinc-200 space-y-2">
        {saveError && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-xs">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {saveError}
          </div>
        )}
        <button onClick={onSave} disabled={saving || !canSave}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-200 disabled:text-zinc-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
          {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Job'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, className = '', children }) {
  return (
    <div className={className}>
      <label className="block text-xs text-zinc-400 font-medium mb-1">{label}</label>
      {children}
    </div>
  )
}


/* ââââââââââââââââââââââââââââââ Mobile List View ââââââââââââââââââââââââââââââ */

function MobileJobList({ jobs, onJobClick, statusConfig }) {
  if (jobs.length === 0) {
    return (
      <div className="text-center py-16">
        <Calendar className="w-10 h-10 mx-auto mb-3 text-gray-300" />
        <p className="text-zinc-500 font-medium">No upcoming jobs</p>
        <p className="text-sm text-zinc-400 mt-1">Tap + to schedule a new job</p>
      </div>
    )
  }

  // Group jobs by date
  const grouped = {}
  jobs.forEach(j => {
    const d = j.scheduled_date || 'Unscheduled'
    if (!grouped[d]) grouped[d] = []
    grouped[d].push(j)
  })

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([date, dayJobs]) => (
        <div key={date}>
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
            {date !== 'Unscheduled'
              ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
              : 'Unscheduled'}
          </p>
          <div className="space-y-2">
            {dayJobs.map(j => {
              const sc = statusConfig(j.status)
              const typeBadge = TYPE_BADGE[j.job_type] || TYPE_BADGE.residential
              return (
                <button key={j.id} onClick={() => onJobClick(j)}
                  className="w-full bg-white border border-zinc-200 rounded-xl p-4 text-left hover:border-zinc-300 transition-colors active:bg-zinc-50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-zinc-900 text-sm truncate">{j.title}</div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />{j.start_time && j.end_time ? `${j.start_time} – ${j.end_time}` : 'Not set'}
                        </span>
                        {j.client_name && (
                          <span className="flex items-center gap-1">
                            <Users className="w-3 h-3" />{j.client_name}
                          </span>
                        )}
                      </div>
                      {j.address && (
                        <div className="flex items-center gap-1 mt-1 text-[11px] text-zinc-400 truncate">
                          <MapPin className="w-3 h-3 shrink-0" />{j.address}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${typeBadge}`}>
                        {JOB_TYPES.find(t => t.value === j.job_type)?.label}
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${sc.color}`}>
                        {sc.label}
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
