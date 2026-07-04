import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Calendar, User, Clock, Plus, AlertCircle,
  RefreshCw, Filter, X, CheckCircle,
  Calendar as CalendarIcon, Trash2, Edit2, Zap,
  Wand2, Wrench, ChevronDown,
} from 'lucide-react'
import { get, post, put, patch } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'
import ErrorState from '../components/ui/ErrorState'
import JobEditModal from '../components/JobEditModal'
import JobCreateModal from '../components/JobCreateModal'
import CalendarView from '../components/CalendarView'
import RecordLink from '../components/RecordLink'
import StatCard from '../components/ui/StatCard'
import { useToast } from '../components/ui/Toast'
import { SyncBadge, TurnoverInfo } from '../components/schedule/SyncBadge'
import AgendaDay from '../components/schedule/AgendaDay'
import VisitCard from '../components/schedule/VisitCard'
import CompleteVisitModal from '../components/schedule/CompleteVisitModal'
import { AvailabilityPanel, RecurringPanel } from '../components/schedule/ScheduleTabs'
import { VISIT_STATUS_CONFIG, shortDate, cleanerInitials } from '../components/schedule/constants'

export default function Schedule() {
  const { toast, ToastContainer } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  if (searchParams.get('tab') === 'recurring') return <RecurringPanel />
  if (searchParams.get('tab') === 'availability') return <AvailabilityPanel />
  // Three view modes today:
  //   agenda — single-day full-width card stack (default on phone, the
  //            screen a cleaner actually uses in the field)
  //   list   — week, grouped by day, dense rows (desktop-leaning)
  //   month  — CalendarView month grid (desktop-leaning)
  // Stored in the URL via ?view= so reload + bookmarks survive. If the
  // URL is unset we default to agenda on phone viewports and list on
  // desktop — see the useEffect below.
  // Two views only: the month Calendar (default) and a single-Day agenda. The
  // old "Week" list view was a third, overlapping mode — dropped to cut the
  // "too many views" clutter. A stale ?view=list falls back to the calendar.
  const VALID_VIEWS = ['agenda', 'month']
  const rawView = searchParams.get('view')
  const viewMode = VALID_VIEWS.includes(rawView) ? rawView : 'month'
  const isGoogleOnly = viewMode === 'google'
  const setViewMode = (next) => {
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params, { replace: true })
  }
  const [visits, setVisits] = useState([])
  const [jobs, setJobs] = useState({})
  const [properties, setProperties] = useState({})
  const [clients, setClients] = useState({})
  const [loading, setLoading] = useState(true)
  // Set when the week aggregate fails entirely → show a retryable error instead
  // of an empty calendar that looks broken.
  const [loadError, setLoadError] = useState(false)
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selectedPropertyType, setSelectedPropertyType] = useState('all')
  const [selectedStatus, setSelectedStatus] = useState('all')
  const [showFilters, setShowFilters] = useState(false)  // filters hidden by default; most days show everything
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [selectedVisit, setSelectedVisit] = useState(null)
  const [showDetails, setShowDetails] = useState(false)
  // Visit drawer: secondary sections (calendar sync status, SMS reminder) fold
  // behind a "More details" toggle so the drawer opens to the essentials.
  const [showVisitMore, setShowVisitMore] = useState(false)
  // Integration audit rows for the open job (Google Calendar push outcomes), so
  // the detail drawer shows the *real* sync result, not just "has an event id".
  const [jobEvents, setJobEvents] = useState([])
  const [completingVisit, setCompletingVisit] = useState(null)
  const [editingJob, setEditingJob] = useState(null)
  const [showJobModal, setShowJobModal] = useState(false)
  const [showNewJob, setShowNewJob] = useState(false)
  const [newJobDate, setNewJobDate] = useState('')

  // Deep-link entry point (e.g. Cmd+K → "Schedule a job"): /schedule?new=1
  // (optionally &date=YYYY-MM-DD) opens Quick-schedule, then strips the params.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setNewJobDate(searchParams.get('date') || '')
      setShowNewJob(true)
      const next = new URLSearchParams(searchParams)
      next.delete('new'); next.delete('date')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])
  // Bumped after any create/edit so the month CalendarView (which holds its own
  // /api/jobs state) refetches and shows the change without a month switch.
  const [calRefresh, setCalRefresh] = useState(0)
  const navigate = useNavigate()
  // `coverage` is still populated from /api/schedule/week but no longer
  // rendered — see the removed Coverage banner. Leaving the state in place
  // avoids touching the aggregate parser.
  const [coverage, setCoverage] = useState(null)
  const [selectedVisitIds, setSelectedVisitIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  // The "Hard delete" bulk-cancel toggle was removed alongside its backend
  // endpoint (POST /api/admin/visits/hard-delete) in the Job/Visit unification.
  // Bulk cancel is soft-only now (PATCH /api/jobs/{id} status=cancelled).
  const [refreshKey, setRefreshKey] = useState(0)
  // Auto-assign turnovers: null | { loading } | { preview:{assigned,unassignable} } | { running }
  const [autoAssign, setAutoAssign] = useState(null)
  // Fix-missing-times tool: null | { loading } | { preview } | { running }
  const [fixTimes, setFixTimes] = useState(null)
  const refresh = () => setRefreshKey(k => k + 1)

  // Connecteam roster, so cleaner IDs can be shown as names. Fails to [] silently.
  const [employees, setEmployees] = useState([])
  useEffect(() => {
    get('/api/dispatch/employees').then(r => setEmployees(Array.isArray(r) ? r : [])).catch(() => {})
  }, [])
  const empName = (id) =>
    employees.find(e => String(e.id) === String(id) || String(e.userId) === String(id))?.name
    || `Cleaner ${id}`

  const dateStr = currentDate.toISOString().split('T')[0]

  // Load visits for current week
  useEffect(() => {
    const loadSchedule = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const startDate = new Date(currentDate)
        startDate.setDate(startDate.getDate() - startDate.getDay())
        const endDate = new Date(startDate)
        endDate.setDate(endDate.getDate() + 6)

        const start = startDate.toISOString().split('T')[0]
        const end = endDate.toISOString().split('T')[0]

        // One aggregate call returns the whole week (visits + jobs + properties
        // + clients + coverage) instead of five parallel round trips. Shapes are
        // identical to the standalone endpoints the server delegates to.
        let week
        try {
          week = await get(
            `/api/schedule/week?scheduled_date_from=${start}&scheduled_date_to=${end}`
          )
        } catch (e) {
          // Total failure (timeout / server down): surface a retryable error
          // rather than rendering an empty week.
          console.error('[Schedule] Week API error:', e)
          setLoadError(true)
          setLoading(false)
          return
        }
        const coverageRes = week?.coverage ?? null

        // Index jobs, properties, clients for quick lookup
        const jobsMap = {}
        const propsMap = {}
        const clientsMap = {}

        // Parse responses safely
        const jobsList = Array.isArray(week?.jobs) ? week.jobs : []
        const propsList = Array.isArray(week?.properties) ? week.properties : []
        const clientsList = Array.isArray(week?.clients) ? week.clients : []

        jobsList.forEach(j => jobsMap[j.id] = j)
        propsList.forEach(p => propsMap[p.id] = p)
        clientsList.forEach(c => clientsMap[c.id] = c)

        // /api/schedule/week's `visits` array is derived from jobs by the
        // backend since the Job/Visit unification (see modules/schedule/router.py).
        // The pre-migration fallback that mapped jobs into a visit shape here is
        // gone — the backend always returns the shape we want.
        const displayData = Array.isArray(week?.visits) ? week.visits : []
        setVisits(displayData)
        setJobs(jobsMap)
        setProperties(propsMap)
        setClients(clientsMap)
        setCoverage(coverageRes)
      } catch (err) {
        console.error('[Schedule]', err)
      }
      setLoading(false)
    }

    loadSchedule()
  }, [currentDate, refreshKey])

  // Auto-assign: preview (dry-run) the picks, then confirm to apply.
  const previewAutoAssign = async () => {
    setAutoAssign({ loading: true })
    try {
      const res = await post('/api/jobs/auto-assign-turnovers?dry_run=true', {})
      if (!res?.assigned?.length && !res?.unassignable?.length) {
        setAutoAssign(null)
        toast.info('No unassigned turnovers to fill')
        return
      }
      setAutoAssign({ preview: res })
    } catch (e) {
      setAutoAssign(null)
      toast.error(e.message || 'Could not preview auto-assign')
    }
  }

  const runAutoAssign = async () => {
    setAutoAssign(a => ({ ...a, running: true }))
    try {
      const res = await post('/api/jobs/auto-assign-turnovers', {})
      toast.success(`Assigned ${res?.assigned?.length || 0} turnover${(res?.assigned?.length || 0) === 1 ? '' : 's'}`)
      setAutoAssign(null)
      refresh()
    } catch (e) {
      toast.error(e.message || 'Auto-assign failed')
      setAutoAssign(a => ({ ...a, running: false }))
    }
  }

  // Pull the latest from Google Calendar on demand, so edits you make in Google
  // show up here immediately instead of waiting for the ~10-min scheduler tick.
  const [gcalSyncing, setGcalSyncing] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)  // "Tools" dropdown (declutters the toolbar)
  const syncFromGoogle = async () => {
    if (gcalSyncing) return
    setGcalSyncing(true)
    try {
      const r = await post('/api/jobs/sync-gcal', {})
      const c = r?.jobs_created || 0, u = r?.jobs_updated || 0, x = r?.jobs_cancelled || 0
      const parts = []
      if (c) parts.push(`${c} new`)
      if (u) parts.push(`${u} updated`)
      if (x) parts.push(`${x} cancelled`)
      toast.success(parts.length ? `Synced from Google — ${parts.join(', ')}` : 'Synced from Google — up to date')
      refresh()
    } catch (e) {
      toast.error(e.message || 'Google sync failed')
    }
    setGcalSyncing(false)
  }

  // Push BrightBase jobs that don't yet have a Google event up to Google. Fixes
  // the "blank embed" case where jobs were created before Google was connected
  // (or otherwise never pushed) — they have no calendar event to show.
  const [gcalPushing, setGcalPushing] = useState(false)
  const pushToGoogle = async () => {
    if (gcalPushing) return
    setGcalPushing(true)
    try {
      const r = await post('/api/jobs/push-to-gcal', {})
      toast.success(r?.message || `Pushed ${r?.pushed || 0} job(s) to Google`)
      refresh()
    } catch (e) {
      const msg = e?.message || 'Push failed'
      toast.error(/not configured/i.test(msg)
        ? 'Google Calendar isn’t connected on the server (credentials missing)'
        : msg)
    }
    setGcalPushing(false)
  }

  // Diagnose + fix jobs that render with no time ("– –"). Preview (dry-run)
  // surfaces the diagnostic by_source so you can see the cause in-app, then
  // confirm to backfill sensible default times.
  const previewFixTimes = async () => {
    setFixTimes({ loading: true })
    try {
      const [diag, preview] = await Promise.all([
        get('/api/jobs/diagnostics/missing-times').catch(() => null),
        post('/api/jobs/backfill-missing-times?dry_run=true', {}),
      ])
      if (!preview?.count) {
        setFixTimes(null)
        toast.info('All jobs already have times — no fix needed')
        return
      }
      setFixTimes({ preview, bySource: diag?.summary?.by_source || {} })
    } catch (e) {
      setFixTimes(null)
      toast.error(e.message || 'Could not check job times')
    }
  }

  const runFixTimes = async () => {
    setFixTimes(f => ({ ...f, running: true }))
    try {
      const res = await post('/api/jobs/backfill-missing-times', {})
      toast.success(`Set times on ${res?.count || 0} job${(res?.count || 0) === 1 ? '' : 's'}`)
      setFixTimes(null)
      refresh()
    } catch (e) {
      toast.error(e.message || 'Fix failed')
      setFixTimes(f => ({ ...f, running: false }))
    }
  }

  // Filter visits
  const filteredVisits = useMemo(() => {
    if (!visits || visits.length === 0) return []

    return visits
      .filter(v => {
        // Always show visits regardless of enrichment data
        if (selectedStatus === 'all') {
          // 'all' means all active — hide cancelled (see them via the Cancelled option)
          if (v.status === 'cancelled') return false
        } else if (v.status !== selectedStatus) {
          return false
        }

        // Filter by property type if we have the data
        if (selectedPropertyType !== 'all') {
          const job = jobs[v.job_id]
          const prop = properties[job?.property_id]
          if (prop?.property_type !== selectedPropertyType) {
            return false
          }
        }

        // "Needs assignment" filter: no cleaners on an active visit.
        if (unassignedOnly) {
          const unassigned = (v.cleaner_ids?.length || 0) === 0 &&
            v.status !== 'completed' && v.status !== 'cancelled'
          if (!unassigned) return false
        }

        return true
      })
      .sort((a, b) => {
        // Null/empty dates sort last (Unscheduled bucket).
        const aHasDate = !!(a.scheduled_date && String(a.scheduled_date).trim())
        const bHasDate = !!(b.scheduled_date && String(b.scheduled_date).trim())
        if (!aHasDate && !bHasDate) return 0
        if (!aHasDate) return 1
        if (!bHasDate) return -1
        const aDate = new Date(`${a.scheduled_date}T${a.start_time || '09:00'}`)
        const bDate = new Date(`${b.scheduled_date}T${b.start_time || '09:00'}`)
        return aDate - bDate
      })
  }, [visits, selectedPropertyType, selectedStatus, unassignedOnly, jobs, properties])

  // Count of active visits needing a cleaner — drives the "Needs assignment"
  // badge so the operator can see the queue at a glance regardless of filters.
  const unassignedCount = useMemo(() => (
    (visits || []).filter(v => (v.cleaner_ids?.length || 0) === 0 &&
      v.status !== 'completed' && v.status !== 'cancelled').length
  ), [visits])

  // Group by date - null/empty scheduled_date bucket as "unscheduled" so the
  // UI no longer renders "Invalid Date" headers for jobs without a real date.
  const visitsByDate = useMemo(() => {
    const grouped = {}
    filteredVisits.forEach(v => {
      const key = (v.scheduled_date && String(v.scheduled_date).trim()) ? v.scheduled_date : 'unscheduled'
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(v)
    })
    return grouped
  }, [filteredVisits])

  // Schedule health for the summary strip + needs-attention banner. Computed
  // over the loaded week of visits (active only — cancelled don't need syncing).
  const scheduleStats = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0]
    const active = (visits || []).filter(v => v.status !== 'cancelled')
    // The Google event id lives on the Job, not the Visit, so resolve through the
    // linked job — otherwise every visit reads as "not on Google" (false 0/total).
    const onGcal = (v) => !!(v.gcal_event_id || jobs[v.job_id]?.gcal_event_id)
    const gcal = active.filter(onGcal).length
    const connecteam = active.filter(v => (jobs[v.job_id]?.connecteam_shift_ids || []).length > 0).length
    return {
      today: active.filter(v => v.scheduled_date === todayStr).length,
      week: active.length,
      gcal, connecteam, total: active.length,
      notGcal: active.length - gcal,
      notConnecteam: active.length - connecteam,
    }
  }, [visits, jobs])

  const handleEdit = (visit, job, property) => {
    setSelectedVisit({ visit, job, property })
    setShowDetails(true)
  }

  // When the detail drawer opens for a job, pull its Google Calendar audit rows
  // so we can show whether the last push actually landed (and why, if it didn't).
  useEffect(() => {
    const jobId = showDetails ? selectedVisit?.job?.id : null
    if (!jobId) { setJobEvents([]); return }
    let cancelled = false
    get(`/api/integration-events?entity_type=job&entity_id=${jobId}&provider=gcal&limit=20`)
      .then(rows => { if (!cancelled) setJobEvents(Array.isArray(rows) ? rows : []) })
      .catch(err => { if (!cancelled) { console.error('[Schedule] integration-events', err); setJobEvents([]) } })
    return () => { cancelled = true }
  }, [showDetails, selectedVisit?.job?.id])

  const handleDelete = async (visitId) => {
    if (!confirm('Delete this visit?')) return
    try {
      // Job/Visit unification (PR-B): occurrences are the Job row itself now.
      // The visits list still uses `id` as the visit id; when the row is a
      // mapped-job fallback, `job_id` is the real job id — prefer that.
      const v = visits.find(x => x.id === visitId)
      const targetId = v?.job_id ?? visitId
      await patch(`/api/jobs/${targetId}`, { status: 'cancelled' })
      await setVisits(visits.filter(x => x.id !== visitId))
      setShowDetails(false)
    } catch (err) {
      toast.error('Error deleting visit: ' + err.message)
    }
  }

  // Toggle per-job SMS reminder suppression (hybrid model: on by default).
  const handleToggleReminder = async (job, skip) => {
    if (!job?.id) return
    try {
      await put(`/api/jobs/${job.id}/reminder-settings`, { skip_reminder: skip })
      setSelectedVisit(sv => sv ? { ...sv, job: { ...sv.job, skip_sms_reminder: skip } } : sv)
      setJobs(prev => prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id], skip_sms_reminder: skip } } : prev)
      toast.success(skip ? '🔕 Reminder disabled for this booking' : '🔔 Reminder enabled for this booking')
    } catch (err) {
      toast.error('Failed to update reminder: ' + err.message)
    }
  }

  // Persist a job completion (checklist + photo URLs + status=completed) via
  // POST /api/jobs/{id}/complete — one call stamps every field, and Job.status
  // moves with completion (the audit gap the Job/Visit unification closes).
  const handleCompleteVisit = async (visitId, { checklist_results, photos }) => {
    try {
      const v = visits.find(x => x.id === visitId)
      const targetId = v?.job_id ?? visitId
      const updated = await post(`/api/jobs/${targetId}/complete`, {
        checklist_results,
        photos,
      })
      setVisits(visits.map(x => x.id === visitId
        ? { ...x, status: 'completed', checklist_results, photos } : x))
      setCompletingVisit(null)
      setShowDetails(false)
      toast.success('Visit marked complete')
      return updated
    } catch (err) {
      toast.error('Error completing visit: ' + err.message)
      throw err
    }
  }

  const toggleVisitSelect = (id, e) => {
    e?.stopPropagation()
    setSelectedVisitIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  // What the operator can actually SEE right now. In agenda mode we show
  // a single day, so "select all visible" must mean that day only — not
  // the whole filtered week (Codex caught this as a P1 on #92: bulk-cancel
  // from agenda could have hit hidden days otherwise).
  const currentlyVisibleVisits = useMemo(() => {
    if (viewMode === 'agenda') {
      return filteredVisits.filter(v => v.scheduled_date === dateStr)
    }
    return filteredVisits
  }, [viewMode, filteredVisits, dateStr])

  const selectAllVisible = () => {
    setSelectedVisitIds(prev => {
      const visibleIds = currentlyVisibleVisits.map(v => v.id)
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id))
      return allSelected ? new Set() : new Set(visibleIds)
    })
  }
  const clearVisitSelection = () => setSelectedVisitIds(new Set())
  const bulkDeleteVisits = async () => {
    const ids = Array.from(selectedVisitIds)
    if (ids.length === 0) return
    if (!confirm(`Cancel ${ids.length} visit${ids.length === 1 ? '' : 's'}? They will be marked cancelled (status=cancelled).`)) return
    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(
        ids.map(id => {
          const v = visits.find(x => x.id === id)
          const targetId = v?.job_id ?? id
          return patch(`/api/jobs/${targetId}`, { status: 'cancelled' })
        })
      )
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) toast.error(`Cancelled ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      setVisits(visits.filter(v => !selectedVisitIds.has(v.id)))
      clearVisitSelection()
    } catch (e) {
      toast.error('Bulk action failed: ' + (e?.message || 'unknown'))
    } finally {
      setBulkDeleting(false)
    }
  }

  const handleEditJob = (job) => {
    setEditingJob(job)
    setShowJobModal(true)
    setShowDetails(false)
  }

  const handleJobSave = async () => {
    // Reload schedule after job edit
    const startDate = new Date(currentDate)
    startDate.setDate(startDate.getDate() - startDate.getDay())
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + 6)
    const start = startDate.toISOString().split('T')[0]
    const end = endDate.toISOString().split('T')[0]
    // Reload via /api/jobs; downstream code accepts the same shape via the
    // job-as-visit fallback in the main loader.
    const jobsRes = await get(`/api/jobs?date_from=${start}&date_to=${end}`)
    const jobsList = Array.isArray(jobsRes) ? jobsRes : (jobsRes?.items || [])
    setVisits(jobsList.map(j => ({
      ...j,
      job_id: j.id,
      scheduled_date: j.scheduled_date,
      start_time: j.start_time,
      end_time: j.end_time,
      cleaner_ids: j.cleaner_ids || [],
      status: j.status,
    })))
    setCalRefresh(k => k + 1)  // make the month CalendarView refetch its jobs too
  }

  // The Backfill button + coverage banner were removed as part of the
  // Job/Visit unification (PR-B): coverage is trivially 100% once occurrences
  // are just Jobs, so the "N jobs missing visits" surface is dead weight.

  const prevWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() - (viewMode === 'agenda' ? 1 : 7))
    setCurrentDate(d)
  }

  const nextWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() + (viewMode === 'agenda' ? 1 : 7))
    setCurrentDate(d)
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-bg">
        <ErrorState
          title="Couldn't load the schedule"
          description="The server didn't respond. Check your connection and try again."
          onRetry={refresh}
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-ink-2">Loading schedule...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-bg">
      {/* Header */}
      <div className="bg-panel border-b border-hairline sticky top-0 z-10 safe-top">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3">
          {/* Single compact row: title · date nav · view toggle · New Job */}
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <h1 className="text-base sm:text-lg font-bold text-ink shrink-0">Schedule</h1>

            {/* View switcher — in-app calendar by default, one tap to Google.
                Short labels on phones so the toolbar fits narrow viewports. */}
            <div className="flex items-center gap-0.5 bg-bg-2 rounded-lg p-0.5 shrink-0">
              {[['month', 'Calendar', 'Cal'], ['agenda', 'Day', 'Day']].map(([v, label, short]) => (
                <button key={v} onClick={() => setViewMode(v)}
                  className={`px-2 sm:px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${viewMode === v ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
                  <span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
            {/* Outer date nav — only for Day. Month mode uses CalendarView's
                own month nav, so these arrows would otherwise do nothing. */}
            {!isGoogleOnly && viewMode !== 'month' && (
              <div className="hidden sm:flex items-center gap-1 ml-1">
                <button onClick={prevWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Previous week">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-semibold text-ink-2 whitespace-nowrap min-w-[64px] text-center">
                  {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <button onClick={nextWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Next week">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}

            <div className="flex-1" />

            {/* Filters hidden behind a toggle so the default view stays clean.
                A dot shows when a filter is actually narrowing the list. */}
            {!isGoogleOnly && (
              <Button onClick={() => setShowFilters(o => !o)} variant="secondary" size="sm" className="whitespace-nowrap relative"
                title="Filter by property type or status">
                <Filter className="w-4 h-4" />
                <span className="hidden sm:inline ml-1.5">Filters</span>
                {(selectedPropertyType !== 'all' || selectedStatus !== 'all') && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500" />
                )}
              </Button>
            )}

            {/* Power tools tucked into one menu to keep the toolbar clean */}
            <div className="relative">
              <Button onClick={() => setToolsOpen(o => !o)} variant="secondary" size="sm" className="whitespace-nowrap"
                title="Calendar sync & maintenance tools">
                <Wrench className="w-4 h-4" />
                <span className="hidden sm:inline ml-1.5">Tools</span>
                <ChevronDown className="w-3 h-3 ml-0.5" />
              </Button>
              {toolsOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setToolsOpen(false)} />
                  <div className="absolute right-0 mt-1 w-56 bg-panel border border-hairline rounded-xl shadow-lg z-50 py-1">
                    <button onClick={() => { setToolsOpen(false); syncFromGoogle() }} disabled={gcalSyncing}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg disabled:opacity-50 transition-colors">
                      <RefreshCw className={`w-4 h-4 ${gcalSyncing ? 'animate-spin' : ''}`} /> {gcalSyncing ? 'Syncing…' : 'Sync from Google'}
                    </button>
                    <button onClick={() => { setToolsOpen(false); pushToGoogle() }} disabled={gcalPushing}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg disabled:opacity-50 transition-colors">
                      <CalendarIcon className="w-4 h-4" /> {gcalPushing ? 'Pushing…' : 'Push to Google'}
                    </button>
                    <div className="my-1 border-t border-hairline" />
                    <button onClick={() => { setToolsOpen(false); previewAutoAssign() }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                      <Wand2 className="w-4 h-4" /> Auto-assign turnovers
                    </button>
                    <button onClick={() => { setToolsOpen(false); previewFixTimes() }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                      <Clock className="w-4 h-4" /> Fix missing times
                    </button>
                    <div className="my-1 border-t border-hairline" />
                    <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer"
                      onClick={() => setToolsOpen(false)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                      <CalendarIcon className="w-4 h-4" /> Open in Google Calendar
                    </a>
                  </div>
                </>
              )}
            </div>

            <Button onClick={() => { setNewJobDate(dateStr); setShowNewJob(true) }} variant="primary" size="sm" className="whitespace-nowrap">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline ml-1.5">New Job</span>
            </Button>
          </div>

          {/* Mobile-only date nav — desktop has it inline above */}
          {!isGoogleOnly && (
          <div className="sm:hidden flex items-center gap-2 mt-2">
            <button onClick={prevWeek} className="p-1.5 hover:bg-bg-2 rounded text-ink-3">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-ink-2 flex-1 text-center">
              {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            <button onClick={nextWeek} className="p-1.5 hover:bg-bg-2 rounded text-ink-3">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          )}

          {/* Filter chips — revealed via the Filters toggle to keep the toolbar clean */}
          {!isGoogleOnly && showFilters && (
          <div className="flex items-center gap-1.5 mt-2 overflow-x-auto scrollbar-thin">
            <select
              value={selectedPropertyType}
              onChange={(e) => setSelectedPropertyType(e.target.value)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap ${
                selectedPropertyType === 'all'
                  ? 'bg-panel text-ink-3 border-hairline'
                  : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}
            >
              <option value="all">All types</option>
              <option value="residential">Residential</option>
              <option value="str">STR</option>
              <option value="commercial">Commercial</option>
            </select>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap ${
                selectedStatus === 'all'
                  ? 'bg-panel text-ink-3 border-hairline'
                  : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}
            >
              <option value="all">All status</option>
              <option value="scheduled">Scheduled</option>
              <option value="dispatched">Dispatched</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          )}
        </div>
      </div>

      {/* Schedule health — just the two operational counts. The Google /
          Connecteam sync ratios used to sit here as always-on diagnostic cards;
          they're now surfaced only when something is actually out of sync, via
          the "Needs attention" strip below. */}
      <div className="bg-bg border-b border-hairline px-3 sm:px-4 py-2.5">
        <div className="max-w-7xl mx-auto grid grid-cols-2 gap-2 sm:gap-3">
          <StatCard className="bg-panel border border-hairline rounded-lg" label="Today" value={scheduleStats.today} icon={CalendarIcon} />
          <StatCard className="bg-panel border border-hairline rounded-lg" label="This week" value={scheduleStats.week} icon={Clock} />
        </div>
        {(scheduleStats.notGcal > 0 || scheduleStats.notConnecteam > 0) && (
          <div className="max-w-7xl mx-auto mt-2 flex flex-wrap items-center gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="font-medium">Needs attention:</span>
            {scheduleStats.notGcal > 0 && <span>{scheduleStats.notGcal} not on Google yet</span>}
            {scheduleStats.notGcal > 0 && scheduleStats.notConnecteam > 0 && <span className="text-amber-300">·</span>}
            {scheduleStats.notConnecteam > 0 && <span>{scheduleStats.notConnecteam} not in Connecteam</span>}
          </div>
        )}
      </div>

      {/* Selection / bulk-action bar */}
      {!isGoogleOnly && (
      <div className="bg-panel border-b border-hairline px-4 py-2">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={currentlyVisibleVisits.length > 0 && currentlyVisibleVisits.every(v => selectedVisitIds.has(v.id))}
              onChange={selectAllVisible}
              className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
              data-testid="visits-select-all"
            />
            <span>Select all visible ({currentlyVisibleVisits.length})</span>
          </label>
          {selectedVisitIds.size > 0 && (
            <div className="flex items-center gap-2" data-testid="visits-bulk-actions">
              <span className="text-xs text-ink-2 font-medium">{selectedVisitIds.size} selected</span>
              <button onClick={clearVisitSelection}
                className="text-xs text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
                Clear
              </button>
              <button onClick={bulkDeleteVisits} disabled={bulkDeleting}
                data-testid="visits-bulk-delete"
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
                {bulkDeleting ? 'Working...' : `Cancel ${selectedVisitIds.size}`}
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Render branch: agenda (single-day cards) / list (week, grouped) / month (CalendarView) */}
      {viewMode === 'agenda' ? (
        <AgendaDay
          currentDate={currentDate}
          visits={filteredVisits.filter(v => v.scheduled_date === dateStr)}
          jobs={jobs}
          properties={properties}
          clients={clients}
          onSelect={handleEdit}
          isToday={dateStr === new Date().toISOString().split('T')[0]}
          empName={empName}
        />
      ) : viewMode === 'month' ? (
        <div className="flex-1 overflow-hidden">
          <CalendarView
            refreshKey={calRefresh}
            onJobClick={(j) => { setEditingJob(jobs[j.id] || j); setShowJobModal(true) }}
            onCreateForDay={(d) => { setNewJobDate(d); setShowNewJob(true) }}
            filters={{
              ...(selectedPropertyType !== 'all' ? { job_type: selectedPropertyType === 'str' ? 'str_turnover' : selectedPropertyType } : {}),
              ...(selectedStatus !== 'all' ? { status: selectedStatus } : {}),
            }}
          />
        </div>
      ) : (
      <>
      {/* Schedule Grid (list view) */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto p-3 sm:p-4">
          {Object.keys(visitsByDate).length === 0 ? (
            <GlassCard>
              <div className="text-center py-12">
                <CalendarIcon className="w-12 h-12 text-ink-3 mx-auto mb-3" />
                <p className="text-ink-2">No visits scheduled for this week</p>
              </div>
            </GlassCard>
          ) : (
            <div className="space-y-4 sm:space-y-6">
              {Object.entries(visitsByDate)
                .sort(([dateA], [dateB]) => {
                  // "unscheduled" bucket sorts to the bottom.
                  if (dateA === 'unscheduled') return 1
                  if (dateB === 'unscheduled') return -1
                  return dateA.localeCompare(dateB)
                })
                .map(([date, dateVisits]) => (
                  <div key={date}>
                    <h2 className="text-base sm:text-lg font-bold text-ink mb-2 sm:mb-3">
                      {date === 'unscheduled'
                        ? `Unscheduled — pick a date in Edit Job (${dateVisits.length})`
                        : new Date(`${date}T00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                      }
                    </h2>
                    <div className="space-y-2 sm:space-y-3">
                      {dateVisits.map((visit) => (
                        <VisitCard
                          key={visit.id}
                          visit={visit}
                          job={jobs[visit.job_id]}
                          property={properties[jobs[visit.job_id]?.property_id]}
                          client={clients[jobs[visit.job_id]?.client_id]}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          selected={selectedVisitIds.has(visit.id)}
                          onToggleSelect={toggleVisitSelect}
                          empName={empName}
                        />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      </>
      )}

      {/* Visit Details Drawer */}
      {showDetails && selectedVisit && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center sm:justify-end">
          <GlassCard className="w-full sm:w-96 h-[95vh] sm:h-auto rounded-t-2xl sm:rounded-lg m-0 sm:m-4 overflow-y-auto safe-bottom">
            <div className="p-4 sm:p-6">
              <div className="flex items-center justify-between mb-4 sm:mb-6">
                <h2 className="text-lg sm:text-xl font-bold text-ink">Visit Details</h2>
                <div className="flex items-center gap-1">
                  {selectedVisit.job?.id && (
                    <button
                      onClick={() => navigate(`/jobs/${selectedVisit.job.id}`)}
                      className="text-[12px] font-medium text-blue-500 hover:underline px-2 py-1"
                    >
                      Open full page
                    </button>
                  )}
                  <button
                    onClick={() => setShowDetails(false)}
                    className="p-2 sm:p-1 hover:bg-bg-2 rounded active:bg-bg-2 -mr-2 sm:mr-0"
                  >
                    <X className="w-5 sm:w-5 h-5 sm:h-5" />
                  </button>
                </div>
              </div>

              {/* Details */}
              <div className="space-y-3 sm:space-y-4">
                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Date & Time</p>
                  <p className="text-sm sm:text-base text-ink">
                    {selectedVisit.visit.scheduled_date && String(selectedVisit.visit.scheduled_date).trim()
                      ? `${new Date(`${selectedVisit.visit.scheduled_date}T${selectedVisit.visit.start_time || '09:00'}`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} @ ${(selectedVisit.visit.start_time || '09:00').slice(0, 5)}`
                      : 'Unscheduled — pick a date in Edit Job'
                    }
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Property</p>
                  <p className="text-sm sm:text-base text-ink">{selectedVisit.property?.name}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Address</p>
                  <p className="text-sm sm:text-base text-ink break-words">{selectedVisit.property?.address}</p>
                </div>

                {/* On-site access details (house code, entry/parking notes, site
                    contact, STR check-in/out) — what a crew needs to get in. */}
                {(() => {
                  // Access details come from the property lookup in state
                  // (populated by /api/schedule/week's aggregated properties).
                  const p = selectedVisit.property || {}
                  if (!(p.house_code || p.access_notes || p.parking_notes || p.site_contact_name || p.site_contact_phone || p.check_in_time || p.check_out_time)) return null
                  return (
                    <div>
                      <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Access</p>
                      <div className="text-sm text-ink space-y-0.5">
                        {p.house_code && <p>Code <span className="font-semibold">{p.house_code}</span></p>}
                        {p.access_notes && <p className="break-words">{p.access_notes}</p>}
                        {p.parking_notes && <p className="text-ink-2">Parking: {p.parking_notes}</p>}
                        {(p.site_contact_name || p.site_contact_phone) && (
                          <p>Site contact: {p.site_contact_name || ''}{p.site_contact_phone ? ` · ${p.site_contact_phone}` : ''}</p>
                        )}
                        {(p.check_out_time || p.check_in_time) && (
                          <p className="text-ink-3">
                            {p.check_out_time ? `Checkout ${p.check_out_time}` : ''}
                            {p.check_out_time && p.check_in_time ? ' · ' : ''}
                            {p.check_in_time ? `Check-in ${p.check_in_time}` : ''}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })()}

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Client</p>
                  <p className="text-sm sm:text-base text-ink">{selectedVisit.job?.client_name}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Status</p>
                  <StatusBadge status={VISIT_STATUS_CONFIG[selectedVisit.visit.status]?.badge || 'info'}>
                    {VISIT_STATUS_CONFIG[selectedVisit.visit.status]?.label || selectedVisit.visit.status}
                  </StatusBadge>
                </div>

                {/* Airbnb/STR turnover details */}
                {selectedVisit.job?.job_type === 'str_turnover' &&
                  (selectedVisit.job?.booking || selectedVisit.job?.next_arrival || selectedVisit.job?.is_immediate_turnover) && (
                  <div>
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Turnover</p>
                    {selectedVisit.job?.is_immediate_turnover && (
                      <p className="inline-flex items-center gap-1 text-sm font-semibold text-red-700 mb-1">
                        <Zap className="w-3.5 h-3.5" /> Same-day turnaround — next guest arrives today
                      </p>
                    )}
                    <div className="text-sm text-ink space-y-0.5">
                      {selectedVisit.job?.booking?.source && (
                        <p>Source: <span className="capitalize">{selectedVisit.job.booking.source}</span></p>
                      )}
                      {selectedVisit.job?.booking?.guest_count > 0 && (
                        <p>{selectedVisit.job.booking.guest_count} guest(s) checked out</p>
                      )}
                      {selectedVisit.job?.booking?.checkout_date && (
                        <p>Checkout: {shortDate(selectedVisit.job.booking.checkout_date)}</p>
                      )}
                      {selectedVisit.job?.next_arrival?.checkin_date && (
                        <p>Next check-in: {shortDate(selectedVisit.job.next_arrival.checkin_date)}</p>
                      )}
                    </div>
                  </div>
                )}

                {selectedVisit.visit.cleaner_ids?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Assigned Cleaners</p>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedVisit.visit.cleaner_ids.map((cid, i) => (
                        <span key={i} className="inline-flex items-center gap-1.5 text-sm text-ink bg-bg-2 pl-1 pr-2.5 py-0.5 rounded-full">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-[9px] font-bold">
                            {cleanerInitials(empName(cid) || `C${cid}`)}
                          </span>
                          {empName(cid) || `Cleaner ${cid}`}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Secondary details (calendar sync, SMS reminder) folded away. */}
                <button type="button" onClick={() => setShowVisitMore(v => !v)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-ink-2 hover:text-ink border-t border-hairline pt-3 w-full">
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showVisitMore ? 'rotate-180' : ''}`} />
                  More details
                </button>

                {showVisitMore && (jobEvents.length > 0 || selectedVisit.visit.gcal_event_id) && (
                  <div>
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Google Calendar</p>
                    {(() => {
                      const latest = jobEvents[0]  // newest-first from the API
                      if (!latest) {
                        // Has an event id but predates the audit log — show the
                        // plain synced state we already knew about.
                        return <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700"><CheckCircle className="w-3.5 h-3.5" /> Synced</span>
                      }
                      const when = latest.created_at ? new Date(latest.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
                      if (latest.status === 'failed') {
                        return (
                          <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700" title={latest.error_message || ''}>
                            <AlertCircle className="w-3.5 h-3.5" /> {latest.action === 'delete' ? 'Calendar removal failed' : 'Calendar sync failed'}{when && ` · ${when}`}
                          </span>
                        )
                      }
                      if (latest.action === 'delete') {
                        return (
                          <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-bg-2 text-ink-2">
                            <Clock className="w-3.5 h-3.5" /> Removed from calendar{when && ` · ${when}`}
                          </span>
                        )
                      }
                      return (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                          <CheckCircle className="w-3.5 h-3.5" /> Synced{when && ` · ${when}`}
                        </span>
                      )
                    })()}
                    {jobEvents[0]?.status === 'failed' && jobEvents[0]?.error_message && (
                      <p className="text-[11px] text-red-600 mt-1 break-words">{String(jobEvents[0].error_message).slice(0, 200)}</p>
                    )}
                  </div>
                )}

                {/* SMS reminder toggle — reminders are on by default; staff can
                    suppress the 24h text for this booking only. */}
                {showVisitMore && selectedVisit.visit.status !== 'completed' && selectedVisit.visit.status !== 'cancelled' && (
                  <div className="border-t border-hairline pt-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-ink-2 uppercase mb-0.5">SMS reminder</p>
                      <p className="text-[12px] text-ink-3">
                        {selectedVisit.job?.skip_sms_reminder
                          ? '🔕 Off — no 24h text for this booking'
                          : '🔔 On — client gets a 24h reminder'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleReminder(selectedVisit.job, !selectedVisit.job?.skip_sms_reminder)}
                      className={`text-[12px] font-semibold px-3 py-1.5 rounded-lg border whitespace-nowrap transition-colors ${
                        selectedVisit.job?.skip_sms_reminder
                          ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                          : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      {selectedVisit.job?.skip_sms_reminder ? 'Enable' : 'Disable'}
                    </button>
                  </div>
                )}

                {/* Completion summary, once a visit has been completed */}
                {selectedVisit.visit.status === 'completed' && (
                  <div className="border-t border-hairline pt-3">
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Completion</p>
                    {(selectedVisit.visit.completed_at || selectedVisit.visit.completed_by) && (
                      <p className="text-[12px] text-ink-3 mb-1">
                        {selectedVisit.visit.completed_at && `Completed ${new Date(selectedVisit.visit.completed_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
                        {selectedVisit.visit.completed_by && ` · by ${empName(selectedVisit.visit.completed_by)}`}
                      </p>
                    )}
                    {selectedVisit.visit.checklist_results && (
                      <ul className="text-sm text-ink space-y-0.5">
                        {Object.entries(selectedVisit.visit.checklist_results).map(([task, done]) => (
                          <li key={task} className="flex items-center gap-1.5">
                            <span className={done ? 'text-green-600' : 'text-ink-3'}>{done ? '✓' : '○'}</span>
                            {task}
                          </li>
                        ))}
                      </ul>
                    )}
                    {selectedVisit.visit.photos?.length > 0 && (
                      <p className="text-sm text-ink mt-1">{selectedVisit.visit.photos.length} photo(s) attached</p>
                    )}
                  </div>
                )}

                <div className="border-t border-hairline pt-4 flex flex-col-reverse sm:flex-row gap-2">
                  {selectedVisit.visit.status !== 'completed' && selectedVisit.visit.status !== 'cancelled' && (
                    <Button
                      variant="primary"
                      size="sm"
                      className="w-full sm:flex-1"
                      onClick={() => setCompletingVisit(selectedVisit.visit)}
                    >
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Complete
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full sm:flex-1"
                    onClick={() => handleEditJob(selectedVisit.job)}
                  >
                    <Edit2 className="w-4 h-4 mr-2" />
                    Edit Job
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    className="w-full sm:flex-1"
                    onClick={() => handleDelete(selectedVisit.visit.id)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Job Edit Modal */}
      {showJobModal && (
        <JobEditModal
          job={editingJob}
          properties={Object.values(properties)}
          clients={Object.values(clients)}
          onClose={() => setShowJobModal(false)}
          onSave={handleJobSave}
          notify={(m) => toast.success(m)}
        />
      )}

      {/* Client-first "New Job": pick/create a client + property inline, one-time
          or recurring, residential by default — and it lands on Google Calendar. */}
      {showNewJob && (
        <JobCreateModal
          initialDate={newJobDate || dateStr}
          onClose={() => setShowNewJob(false)}
          onCreated={() => { setShowNewJob(false); handleJobSave() }}
        />
      )}

      {/* Auto-assign turnovers — preview then confirm */}
      {autoAssign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => !autoAssign.running && setAutoAssign(null)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="relative w-full max-w-lg max-h-[85vh] bg-panel rounded-2xl shadow-2xl border border-hairline flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
              <div className="flex items-center gap-2.5 min-w-0">
                <Wand2 className="w-5 h-5 text-blue-600 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-ink">Auto-assign turnovers</h2>
                  <p className="text-[12px] text-ink-3 mt-0.5">Available cleaners, balanced by daily load. Review before applying.</p>
                </div>
              </div>
              <button onClick={() => !autoAssign.running && setAutoAssign(null)} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
              {autoAssign.loading ? (
                <div className="py-12 text-center text-[13px] text-ink-3">Finding available cleaners…</div>
              ) : (
                <>
                  {autoAssign.preview?.assigned?.length > 0 ? (
                    <div className="space-y-1.5">
                      {autoAssign.preview.assigned.map(a => (
                        <div key={a.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium text-ink truncate">{a.title}</div>
                            <div className="text-[11px] text-ink-3">{a.date}</div>
                          </div>
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded shrink-0">
                            <User className="w-3 h-3" /> {empName(a.cleaner_id)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-6 text-center text-[13px] text-ink-3">No turnovers could be auto-assigned.</div>
                  )}
                  {autoAssign.preview?.unassignable?.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                      <div className="text-[11px] font-semibold text-amber-700 mb-1">
                        {autoAssign.preview.unassignable.length} couldn’t be filled (no available cleaner)
                      </div>
                      {autoAssign.preview.unassignable.map(u => (
                        <div key={u.job_id} className="text-[11px] text-amber-700/90">{u.title} · {u.date}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="p-4 border-t border-hairline flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAutoAssign(null)} disabled={autoAssign.running}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={runAutoAssign}
                disabled={autoAssign.loading || autoAssign.running || !autoAssign.preview?.assigned?.length}>
                {autoAssign.running ? 'Assigning…' : `Assign ${autoAssign.preview?.assigned?.length || 0}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Fix missing times — diagnose (shows source) then backfill */}
      {fixTimes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => !fixTimes.running && setFixTimes(null)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="relative w-full max-w-lg max-h-[85vh] bg-panel rounded-2xl shadow-2xl border border-hairline flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
              <div className="flex items-center gap-2.5 min-w-0">
                <Clock className="w-5 h-5 text-blue-600 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-ink">Fix missing job times</h2>
                  <p className="text-[12px] text-ink-3 mt-0.5">Jobs showing "– –" get a sensible default (turnovers → property checkout, others → 9:00). Review before applying.</p>
                </div>
              </div>
              <button onClick={() => !fixTimes.running && setFixTimes(null)} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
              {fixTimes.loading ? (
                <div className="py-12 text-center text-[13px] text-ink-3">Checking job times…</div>
              ) : (
                <>
                  {/* Source breakdown — the in-app diagnostic result */}
                  {fixTimes.bySource && Object.keys(fixTimes.bySource).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(fixTimes.bySource).map(([src, n]) => (
                        <span key={src} className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-bg-2 text-ink-2">
                          {src.replace(/_/g, ' ')}: {n}
                        </span>
                      ))}
                    </div>
                  )}
                  {(fixTimes.preview?.jobs || []).map(j => (
                    <div key={j.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{j.title}</div>
                        <div className="text-[11px] text-ink-3">{j.scheduled_date} · {j.source.replace(/_/g, ' ')}</div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-1 rounded shrink-0 tabular-nums">
                        {j.new_start}–{(j.new_end || '').slice(0, 5)}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="p-4 border-t border-hairline flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setFixTimes(null)} disabled={fixTimes.running}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={runFixTimes}
                disabled={fixTimes.loading || fixTimes.running || !fixTimes.preview?.count}>
                {fixTimes.running ? 'Fixing…' : `Fix ${fixTimes.preview?.count || 0}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Visit Modal */}
      {completingVisit && (
        <CompleteVisitModal
          visit={completingVisit}
          onClose={() => setCompletingVisit(null)}
          onComplete={(payload) => handleCompleteVisit(completingVisit.id, payload)}
        />
      )}
      <ToastContainer />
    </div>
  )
}
