import { useState, useEffect } from 'react'
import { CustomFieldsForm } from '../components/CustomFields'
import { useSearchParams } from 'react-router-dom'
import { Plus, X, MapPin, Calendar, MessageSquare, Download, RefreshCw, CheckCircle, LayoutList, ExternalLink, Home, Repeat2, ChevronDown } from 'lucide-react'
import CalendarView from '../components/CalendarView'
import { del, get } from "../api"


const TYPE_CONFIG = {
  residential:  { label: 'Residential', color: 'bg-blue-50 text-blue-700 border-blue-200',   dot: 'bg-blue-400' },
  commercial:   { label: 'Commercial',  color: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-green-400' },
  str_turnover: { label: 'STR',         color: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-400' },
}

const STATUS_COLORS = {
  scheduled:   'bg-blue-50 text-blue-700 border-blue-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  completed:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled:   'bg-red-50 text-red-700 border-red-200',
}

const EMPTY = { client_id: '', title: '', job_type: 'residential', scheduled_date: '', start_time: '', end_time: '', address: '', notes: '', custom_fields: {} }

export default function Scheduling() {
  const [searchParams] = useSearchParams()
  const [jobs, setJobs] = useState([])
  const [clients, setClients] = useState([])
  const [clientProperties, setClientProperties] = useState([])
  const [dateFilter, setDateFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [quickFilter, setQuickFilter] = useState('upcoming') // 'today' | 'week' | 'upcoming' | 'all'
  const [searchQuery, setSearchQuery] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState({})
  const [toast, setToast] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [view, setView] = useState('list')  // 'calendar' | 'list' | 'gcal'
  const [calRefresh, setCalRefresh] = useState(0)
  const [recurringPanel, setRecurringPanel] = useState(false)
  const [recurringForm, setRecurringForm] = useState({})
  const [savingRecurring, setSavingRecurring] = useState(false)

  const load = () => {
    const params = new URLSearchParams()
    const todayStr = new Date().toISOString().slice(0, 10)
    const weekEndStr = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

    if (dateFilter) {
      params.set('date', dateFilter)
    } else if (quickFilter === 'today') {
      params.set('date', todayStr)
    } else if (quickFilter === 'week') {
      params.set('date_from', todayStr)
      params.set('date_to', weekEndStr)
    } else if (quickFilter === 'upcoming') {
      params.set('date_from', todayStr)
    }
    // 'all' = no date filter

    if (typeFilter) params.set('job_type', typeFilter)
    if (statusFilter) params.set('status', statusFilter)
    get(`/api/jobs?${params}`).then(setJobs).catch(err => console.error("[Scheduling]", err))
  }

  useEffect(() => { load() }, [dateFilter, typeFilter, statusFilter, quickFilter])

  useEffect(() => {
    get('/api/clients').then(data => {
      setClients(Array.isArray(data) ? data : [])
    }).catch(err => console.error("[Scheduling]", err))
  }, [])

  // Pre-open form if ?client_id= in URL
  useEffect(() => {
    const clientId = searchParams.get('client_id')
    if (clientId) {
      setForm({ ...EMPTY, client_id: clientId })
      setSelected(null)
      setShowForm(true)
    }
  }, [])

  // Load properties when client changes in form
  useEffect(() => {
    if (!form.client_id) { setClientProperties([]); return }
    get(`/api/properties?client_id=${form.client_id}`)
      .then(d => setClientProperties(Array.isArray(d) ? d : []))
      .catch(() => setClientProperties([]))
  }, [form.client_id])

  const clientName = (id) => clients.find(c => c.id === id)?.name || `Client #${id}`

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const setLoading = (jobId, action, val) =>
    setActionLoading(prev => ({ ...prev, [`${jobId}-${action}`]: val }))

  const isLoading = (jobId, action) => !!actionLoading[`${jobId}-${action}`]

  // ── Actions ──────────────────────────────────────────────────────────────

  const pushToGcal = async (jobId) => {
    setLoading(jobId, 'gcal', true)
    try {
      const r = await fetch(`/api/reminders/jobs/${jobId}/gcal`, { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Failed')
      showToast(`Added to Google Calendar${data.client_invited ? ' — client invited!' : ''}`)
      load()
    } catch (e) {
      showToast(String(e.message), false)
    }
    setLoading(jobId, 'gcal', false)
  }

  const sendReminder = async (jobId) => {
    setLoading(jobId, 'sms', true)
    try {
      const r = await fetch(`/api/reminders/jobs/${jobId}/sms-reminder`, { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Failed')
      showToast('SMS reminder sent!')
      load()
    } catch (e) {
      showToast(String(e.message), false)
    }
    setLoading(jobId, 'sms', false)
  }

  const syncFromGcal = async () => {
    setSyncing(true)
    try {
      const r = await fetch('/api/jobs/sync-gcal', { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Sync failed')
      showToast(data.message || `Synced ${data.synced} job(s) from Google Calendar`)
      load()
    } catch (e) {
      showToast(String(e.message), false)
    }
    setSyncing(false)
  }

  const pushAll = async () => {
    setPushing(true)
    try {
      const r = await fetch('/api/reminders/push-upcoming-to-gcal', { method: 'POST' })
      const data = await r.json()
      showToast(`${data.pushed} job${data.pushed !== 1 ? 's' : ''} pushed to Google Calendar`)
      load()
    } catch (e) {
      showToast('Push failed', false)
    }
    setPushing(false)
  }

  const updateStatus = async (id, status) => {
    await fetch(`/api/jobs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    load()
  }

  const deleteJob = async (id) => {
    if (!confirm('Delete this job? This cannot be undone.')) return
    await del(`/api/jobs/${id}`)
    setShowForm(false)
    load()
    showToast('Job deleted')
  }

  const save = async () => {
    setSaving(true)
    try {
      const method = selected ? 'PATCH' : 'POST'
      const url = selected ? `/api/jobs/${selected.id}` : '/api/jobs'
      const body = {
        ...form,
        client_id: parseInt(form.client_id),
        property_id: form.property_id ? parseInt(form.property_id) : null,
      }
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error()
      const saved = await r.json()
      await load()
      setCalRefresh(n => n + 1)
      setShowForm(false)
      // Auto-push new jobs to Google Calendar in the background
      if (!selected) {
        fetch(`/api/reminders/jobs/${saved.id}/gcal`, { method: 'POST' })
          .then(() => showToast('Job saved & added to Google Calendar'))
          .catch(() => showToast('Job saved (Google Cal push failed)'))
      } else {
        showToast('Job updated')
      }
    } catch {
      showToast('Failed to save job', false)
    }
    setSaving(false)
  }

  const openEdit = (j) => {
    setSelected(j)
    setForm({ ...j, client_id: j.client_id })
    setRecurringPanel(false)
    setShowForm(true)
  }
  const openNew = () => {
    setSelected(null)
    setForm(EMPTY)
    setRecurringPanel(false)
    setShowForm(true)
  }

  const addHours = (time, hours) => {
    const [h, m] = time.split(':').map(Number)
    const total = h * 60 + m + Math.round(hours * 60)
    return `${String(Math.floor(total / 60) % 24).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`
  }

  const openRecurringPanel = (job) => {
    // Pre-fill recurring form from the job's data
    const jobDate = new Date(job.scheduled_date + 'T12:00:00')
    setRecurringForm({
      frequency: 'biweekly',
      day_of_week: jobDate.getDay() === 0 ? 6 : jobDate.getDay() - 1, // JS Sun=0 → our Mon=0
      day_of_month: jobDate.getDate(),
      generate_weeks_ahead: 8,
    })
    setRecurringPanel(true)
  }

  const saveRecurring = async () => {
    if (!selected) return
    setSavingRecurring(true)
    try {
      const body = {
        client_id: selected.client_id,
        property_id: selected.property_id || null,
        job_type: selected.job_type || 'residential',
        title: selected.title,
        address: selected.address || '',
        start_time: selected.start_time,
        end_time: selected.end_time,
        notes: selected.notes || null,
        frequency: recurringForm.frequency,
        day_of_week: parseInt(recurringForm.day_of_week),
        day_of_month: recurringForm.frequency === 'monthly' ? parseInt(recurringForm.day_of_month) : null,
        generate_weeks_ahead: parseInt(recurringForm.generate_weeks_ahead),
      }
      const r = await fetch('/api/recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error()
      const sched = await r.json()
      // Link this job to the new schedule
      await fetch(`/api/jobs/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recurring_schedule_id: sched.id }),
      })
      await load()
      setCalRefresh(n => n + 1)
      setRecurringPanel(false)
      setShowForm(false)
      showToast(`Recurring schedule created — ${sched.jobs_created ?? ''} visits generated`)
    } catch {
      showToast('Failed to create recurring schedule', false)
    }
    setSavingRecurring(false)
  }

  const selectProperty = (prop) => {
    const fullAddress = [prop.address, prop.city, prop.state].filter(Boolean).join(', ')
    const client = clients.find(c => c.id === parseInt(form.client_id))
    const jobType = prop.property_type === 'commercial' ? 'commercial'
                  : prop.property_type === 'str'        ? 'str_turnover'
                  : 'residential'
    const defaultTitle = () => {
      if (!client) return ''
      const first = client.name.split(' ')[0]
      if (jobType === 'str_turnover') return `${prop.name || first} Turnover`
      if (jobType === 'commercial')  return `${first}'s Office Clean`
      return `${first}'s Home Clean`
    }
    setForm(f => ({
      ...f,
      property_id: prop.id,
      address: fullAddress,
      job_type: jobType,
      title: f.title || defaultTitle(),
      end_time: f.start_time ? addHours(f.start_time, prop.default_duration_hours || 3) : f.end_time,
    }))
  }

  // Filter by search query client-side
  const filteredJobs = searchQuery.trim()
    ? jobs.filter(j => {
        const q = searchQuery.toLowerCase()
        return clientName(j.client_id).toLowerCase().includes(q) ||
               (j.address || '').toLowerCase().includes(q) ||
               (j.title || '').toLowerCase().includes(q)
      })
    : jobs

  // Group jobs by date
  const grouped = filteredJobs.reduce((acc, j) => {
    acc[j.scheduled_date] = acc[j.scheduled_date] || []
    acc[j.scheduled_date].push(j)
    return acc
  }, {})

  const unpushed = filteredJobs.filter(j => !j.calendar_invite_sent && j.status === 'scheduled').length
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex h-full">
      <div className="flex-1 p-4 sm:p-6 flex flex-col min-w-0">

        {/* Toast */}
        {toast && (
          <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl text-sm shadow-lg border transition-all ${
            toast.ok ? 'bg-green-900/90 border-green-600 text-green-300' : 'bg-red-900/90 border-red-600 text-red-300'
          }`}>
            {toast.ok ? <CheckCircle className="w-4 h-4 shrink-0" /> : <X className="w-4 h-4 shrink-0" />}
            {toast.msg}
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-5 flex-wrap">
          {view === 'list' && <>
            {/* Quick filter pills */}
            <div className="flex bg-gray-100 rounded-lg p-0.5 border border-gray-200">
              {[
                { id: 'today', label: 'Today' },
                { id: 'week', label: 'This Week' },
                { id: 'upcoming', label: 'Upcoming' },
                { id: 'all', label: 'All' },
              ].map(f => (
                <button key={f.id} onClick={() => { setQuickFilter(f.id); setDateFilter('') }}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${quickFilter === f.id && !dateFilter ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
                  {f.label}
                </button>
              ))}
            </div>

            {/* Search */}
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search client or address..."
              className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400 w-48" />

            {/* Type filter */}
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
              <option value="">All types</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="str_turnover">STR</option>
            </select>

            {/* Status filter */}
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
              <option value="">All statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>

            {/* Specific date override */}
            <input type="date" value={dateFilter} onChange={e => { setDateFilter(e.target.value); setQuickFilter('') }}
              className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </>}
          {view === 'gcal' && (
            <a
              href="https://calendar.google.com/calendar/r"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors border border-gray-200"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open in Google Calendar
            </a>
          )}

          <div className="flex-1" />

          {/* Legend */}
          <div className="hidden lg:flex items-center gap-3 mr-2">
            {Object.entries(TYPE_CONFIG).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className={`w-2 h-2 rounded-full ${v.dot}`} />{v.label}
              </span>
            ))}
          </div>

          {unpushed > 0 && (
            <button onClick={pushAll} disabled={pushing}
              className="flex items-center gap-2 bg-indigo-600/80 hover:bg-indigo-600 border border-indigo-500/50 px-3 py-2 rounded-lg text-xs font-medium transition-colors">
              <Calendar className={`w-3.5 h-3.5 ${pushing ? 'animate-spin' : ''}`} />
              {pushing ? 'Pushing...' : `Push ${unpushed} to Google Cal`}
            </button>
          )}
          <button onClick={syncFromGcal} disabled={syncing}
            title="Pull changes made in Google Calendar back into BrightBase"
            className="flex items-center gap-1.5 bg-gray-100 hover:bg-gray-200 border border-gray-200 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync from GCal'}
          </button>

          {/* View toggle */}
          <div className="flex bg-gray-100 rounded-lg p-0.5 border border-gray-200">
            <button onClick={() => setView('calendar')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'calendar' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
              <Calendar className="w-3.5 h-3.5" /> Calendar
            </button>
            <button onClick={() => setView('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'list' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
              <LayoutList className="w-3.5 h-3.5" /> List
            </button>
            <button onClick={() => setView('gcal')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'gcal' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
              <ExternalLink className="w-3.5 h-3.5" /> Google Cal
            </button>
          </div>

          <button onClick={openNew}
            className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Job
          </button>
        </div>

        {/* Calendar view */}
        {view === 'calendar' && (
          <div className="flex-1 min-h-0 -mx-6 -mb-6">
            <CalendarView
              refreshKey={calRefresh}
              onJobClick={j => openEdit(j)}
              onDayClick={date => {
                setSelected(null)
                setForm({ ...EMPTY, scheduled_date: date })
                setShowForm(true)
              }}
            />
          </div>
        )}

        {/* Google Calendar embed */}
        {view === 'gcal' && (
          <div className="flex-1 min-h-0 -mx-6 -mb-6 flex flex-col relative">
            <iframe
              src="https://calendar.google.com/calendar/embed?src=office%40mainecleaningco.com&ctz=America%2FNew_York&showTitle=0&showNav=1&showDate=1&showPrint=0&showTabs=1&showCalendars=0&showTz=0&mode=MONTH&bgcolor=%23111827&color=%234285F4"
              className="flex-1 w-full border-0 rounded-none"
              title="Google Calendar — The Maine Cleaning Co."
              allow="fullscreen"
            />
          </div>
        )}

        {/* List view grouped by date */}
        {view === 'list' && <div className="overflow-y-auto flex-1 scrollbar-thin space-y-6">
          {Object.keys(grouped).sort().map(date => (
            <div key={date}>
              <div className="flex items-center gap-2 mb-2">
                <Calendar className="w-4 h-4 text-sky-400" />
                <span className={`text-sm font-semibold ${date === today ? 'text-sky-400' : 'text-gray-600'}`}>
                  {date === today ? 'Today — ' : ''}
                  {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </span>
                <span className="text-xs text-gray-600">({grouped[date].length} job{grouped[date].length !== 1 ? 's' : ''})</span>
              </div>

              <div className="space-y-2">
                {grouped[date].map(j => {
                  const tc = TYPE_CONFIG[j.job_type] || TYPE_CONFIG.residential
                  return (
                    <div key={j.id}
                      className="bg-white border border-gray-200 hover:border-gray-300 rounded-xl transition-colors">
                      {/* Main row — clickable to edit */}
                      <div className="flex items-start gap-3 p-4 cursor-pointer" onClick={() => openEdit(j)}>
                        <div className={`w-1 self-stretch rounded-full shrink-0 mt-0.5 ${tc.dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-gray-900">{j.start_time}</span>
                            {j.end_time && <span className="text-xs text-gray-400">– {j.end_time}</span>}
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${tc.color}`}>{tc.label}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${STATUS_COLORS[j.status]}`}>
                              {j.status.replace('_', ' ')}
                            </span>
                            {j.dispatched && <span className="text-xs bg-purple-50 text-purple-700 border border-purple-200 px-2 py-0.5 rounded-full">Dispatched</span>}
                          </div>
                          <div className="font-medium text-gray-900 mt-1 truncate">{j.title}</div>
                          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                            <span className="text-xs text-gray-400">{clientName(j.client_id)}</span>
                            {j.address && (
                              <span className="text-xs text-gray-500 flex items-center gap-1 truncate">
                                <MapPin className="w-3 h-3 shrink-0" />{j.address}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Action row */}
                      <div className="flex items-center gap-1.5 px-4 pb-3 border-t border-gray-100 pt-2.5">
                        {j.status === 'scheduled' && (
                          <button onClick={() => updateStatus(j.id, 'in_progress')}
                            className="text-xs px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 rounded-lg transition-colors font-medium">
                            Start
                          </button>
                        )}
                        {(j.status === 'scheduled' || j.status === 'in_progress') && (
                          <button onClick={() => updateStatus(j.id, 'completed')}
                            className="text-xs px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 rounded-lg transition-colors font-medium">
                            Done
                          </button>
                        )}
                        <div className="flex-1" />
                        <button
                          onClick={() => pushToGcal(j.id)}
                          disabled={isLoading(j.id, 'gcal')}
                          title={j.calendar_invite_sent ? 'Resync to Google Calendar' : 'Add to Google Calendar'}
                          className={`p-1.5 rounded-lg transition-colors ${
                            j.calendar_invite_sent
                              ? 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'
                              : 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-50'
                          }`}>
                          {isLoading(j.id, 'gcal') ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => sendReminder(j.id)}
                          disabled={isLoading(j.id, 'sms')}
                          title={j.sms_reminder_sent ? 'Reminder already sent' : 'Send SMS reminder'}
                          className={`p-1.5 rounded-lg transition-colors ${
                            j.sms_reminder_sent
                              ? 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100'
                              : 'text-gray-400 hover:text-emerald-600 hover:bg-emerald-50'
                          }`}>
                          {isLoading(j.id, 'sms') ? <RefreshCw className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
                        </button>
                        <a
                          href={`/api/reminders/jobs/${j.id}/invite.ics`}
                          download={`cleaning-${j.id}.ics`}
                          title="Download .ics calendar invite"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-sky-600 hover:bg-sky-50 transition-colors">
                          <Download className="w-4 h-4" />
                        </a>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {filteredJobs.length === 0 && (
            <div className="text-center py-16 text-gray-500">
              <Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <div>No jobs found</div>
              {(dateFilter || typeFilter) && (
                <button onClick={() => { setDateFilter(''); setTypeFilter('') }}
                  className="mt-2 text-xs text-sky-400 hover:text-sky-300">Clear filters</button>
              )}
            </div>
          )}
        </div>}
      </div>

      {/* Job form panel */}
      {showForm && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-gray-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h2 className="font-semibold text-gray-900">{selected ? 'Edit Job' : 'New Job'}</h2>
            <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">

            {/* Client */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Client *</label>
              <select value={form.client_id}
                onChange={e => setForm(f => ({ ...f, client_id: e.target.value, property_id: '', address: '', title: '' }))}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Property picker */}
            {form.client_id && (
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Property</label>
                {clientProperties.length === 0 ? (
                  <p className="text-xs text-gray-600 px-1">No properties on file</p>
                ) : (
                  <div className="space-y-1.5">
                    {clientProperties.map(p => (
                      <button key={p.id} onClick={() => selectProperty(p)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors border ${
                          parseInt(form.property_id) === p.id
                            ? 'bg-sky-50 border-sky-500/50 text-sky-300'
                            : 'bg-gray-100 border-gray-200 text-gray-600 hover:border-gray-300'
                        }`}>
                        <Home className="w-3.5 h-3.5 shrink-0 opacity-50" />
                        <div className="min-w-0">
                          <div className="text-xs font-medium truncate">{p.name}</div>
                          {p.address && <div className="text-[10px] text-gray-500 truncate">{p.address}{p.city ? `, ${p.city}` : ''}</div>}
                        </div>
                        <span className="ml-auto text-[10px] text-gray-600 shrink-0">{p.default_duration_hours}h</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Service type */}
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Service Type</label>
              <div className="flex gap-2">
                {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
                  <button key={key} onClick={() => setForm(f => ({ ...f, job_type: key }))}
                    className={`flex-1 py-1.5 rounded-lg text-xs transition-colors ${
                      form.job_type === key ? 'bg-sky-600 text-gray-900' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                    }`}>
                    {cfg.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Job Title *</label>
              <input value={form.title || ''} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Home Clean"
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
            </div>

            {/* Address */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Address</label>
              <input value={form.address || ''} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-400" />
            </div>

            {/* Date */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Date *</label>
              <input type="date" value={form.scheduled_date || ''} onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
            </div>

            {/* Times */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">Start *</label>
                <input type="time" value={form.start_time || ''}
                  onChange={e => {
                    const start = e.target.value
                    const prop = clientProperties.find(p => p.id === parseInt(form.property_id))
                    const end = prop ? addHours(start, prop.default_duration_hours || 3) : form.end_time
                    setForm(f => ({ ...f, start_time: start, end_time: end || f.end_time }))
                  }}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">End *</label>
                <input type="time" value={form.end_time || ''} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>

            {/* Status (edit only) */}
            {selected && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Status</label>
                <select value={form.status || 'scheduled'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
                  <option value="scheduled">Scheduled</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Notes</label>
              <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>

            <CustomFieldsForm
              entityType="job"
              values={form.custom_fields || {}}
              onChange={(key, val) => setForm(f => ({ ...f, custom_fields: { ...(f.custom_fields || {}), [key]: val } }))}
            />

            {/* Quick actions for existing jobs */}
            {selected && (
              <div className="border border-gray-200 rounded-xl p-4 space-y-2">
                <p className="text-xs text-gray-500 font-medium mb-3">QUICK ACTIONS</p>

                {/* Make Recurring */}
                {!selected.recurring_schedule_id ? (
                  <div>
                    <button
                      onClick={() => { setRecurringPanel(p => !p); }}
                      className="w-full flex items-center gap-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-2 rounded-lg transition-colors">
                      <Repeat2 className="w-4 h-4 text-purple-400" />
                      Make Recurring
                      <ChevronDown className={`w-3.5 h-3.5 ml-auto text-gray-500 transition-transform ${recurringPanel ? 'rotate-180' : ''}`} />
                    </button>

                    {recurringPanel && (
                      <div className="mt-2 bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-3">
                        <p className="text-xs text-gray-400">Turn this job into a recurring schedule. Existing future visits will be generated automatically.</p>

                        {/* Frequency */}
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Frequency</label>
                          <div className="flex gap-1.5">
                            {['weekly','biweekly','monthly'].map(f => (
                              <button key={f} onClick={() => setRecurringForm(rf => ({ ...rf, frequency: f }))}
                                className={`flex-1 py-1.5 rounded-lg text-xs capitalize transition-colors ${recurringForm.frequency === f ? 'bg-sky-600 text-gray-900' : 'bg-gray-200 text-gray-400 hover:bg-gray-300'}`}>
                                {f}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Day */}
                        {recurringForm.frequency !== 'monthly' ? (
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Day of week</label>
                            <div className="grid grid-cols-7 gap-1">
                              {['M','T','W','T','F','S','S'].map((d, i) => (
                                <button key={i} onClick={() => setRecurringForm(rf => ({ ...rf, day_of_week: i }))}
                                  className={`py-1.5 rounded text-xs font-medium transition-colors ${parseInt(recurringForm.day_of_week) === i ? 'bg-sky-600 text-gray-900' : 'bg-gray-200 text-gray-400 hover:bg-gray-300'}`}>
                                  {d}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Day of month</label>
                            <input type="number" min="1" max="28" value={recurringForm.day_of_month || 1}
                              onChange={e => setRecurringForm(rf => ({ ...rf, day_of_month: e.target.value }))}
                              className="w-full bg-gray-200 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none" />
                          </div>
                        )}

                        {/* Weeks ahead */}
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Generate ahead</label>
                          <select value={recurringForm.generate_weeks_ahead}
                            onChange={e => setRecurringForm(rf => ({ ...rf, generate_weeks_ahead: e.target.value }))}
                            className="w-full bg-gray-200 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none">
                            {[4,6,8,12,16].map(w => <option key={w} value={w}>{w} weeks</option>)}
                          </select>
                        </div>

                        <button onClick={saveRecurring} disabled={savingRecurring}
                          className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-gray-200 px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                          {savingRecurring ? 'Creating...' : 'Create Schedule & Generate Visits'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <a href="/recurring"
                    className="w-full flex items-center gap-2 text-sm text-purple-400 bg-purple-500/10 border border-purple-500/20 px-3 py-2 rounded-lg transition-colors hover:bg-purple-500/20">
                    <Repeat2 className="w-4 h-4" />
                    View Recurring Schedule
                  </a>
                )}

                <button onClick={() => { pushToGcal(selected.id) }}
                  className="w-full flex items-center gap-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-2 rounded-lg transition-colors">
                  <Calendar className="w-4 h-4 text-indigo-400" />
                  {selected.calendar_invite_sent ? 'Resync to Google Calendar' : 'Add to Google Calendar'}
                </button>
                <button onClick={() => sendReminder(selected.id)}
                  className="w-full flex items-center gap-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-2 rounded-lg transition-colors">
                  <MessageSquare className="w-4 h-4 text-green-400" />
                  {selected.sms_reminder_sent ? 'Resend SMS Reminder' : 'Send SMS Reminder'}
                </button>
                <a href={`/api/reminders/jobs/${selected.id}/invite.ics`} download
                  className="w-full flex items-center gap-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-2 rounded-lg transition-colors">
                  <Download className="w-4 h-4 text-sky-400" />
                  Download .ics Invite
                </a>
              </div>
            )}
          </div>
          <div className="p-6 border-t border-gray-200 space-y-2">
            <button onClick={save} disabled={saving || !form.client_id || !form.title || !form.scheduled_date}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving...' : selected ? 'Save Changes' : 'Create Job'}
            </button>
            {selected && (
              <button onClick={() => deleteJob(selected.id)}
                className="w-full px-4 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors">
                Delete Job
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
