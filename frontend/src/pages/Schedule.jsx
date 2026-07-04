import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { get, post, put, patch } from '../api'
import Button from '../components/ui/Button'
import ErrorState from '../components/ui/ErrorState'
import JobEditModal from '../components/JobEditModal'
import JobCreateModal from '../components/JobCreateModal'
import CalendarView from '../components/CalendarView'
import { useToast } from '../components/ui/Toast'
import AgendaDay from '../components/schedule/AgendaDay'
import CompleteVisitModal from '../components/schedule/CompleteVisitModal'
import VisitDetailsDrawer from '../components/schedule/VisitDetailsDrawer'
import ScheduleToolbar from '../components/schedule/ScheduleToolbar'
import { AutoAssignModal, FixTimesModal } from '../components/schedule/PowerToolModals'
import { ScheduleHealthStrip, ScheduleBulkBar, ScheduleListView } from '../components/schedule/ScheduleSections'
import { AvailabilityPanel, RecurringPanel } from '../components/schedule/ScheduleTabs'
import { VISIT_STATUS_CONFIG, shortDate, cleanerInitials } from '../components/schedule/constants'
import { useScheduleData } from '../hooks/useScheduleData'
import { useScheduleTools } from '../hooks/useScheduleTools'

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
  const [currentDate, setCurrentDate] = useState(new Date())
  const {
    visits, setVisits,
    jobs, setJobs,
    properties, clients,
    loading, loadError,
    refresh,
    empName,
  } = useScheduleData(currentDate)
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
  const [selectedVisitIds, setSelectedVisitIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  // The "Hard delete" bulk-cancel toggle was removed alongside its backend
  // endpoint (POST /api/admin/visits/hard-delete) in the Job/Visit unification.
  // Bulk cancel is soft-only now (PATCH /api/jobs/{id} status=cancelled).
  // "Tools" dropdown (declutters the toolbar) — open/close is UI, so it
  // stays here; the actual actions live in useScheduleTools.
  const [toolsOpen, setToolsOpen] = useState(false)

  const {
    gcalSyncing, syncFromGoogle,
    gcalPushing, pushToGoogle,
    autoAssign, setAutoAssign, previewAutoAssign, runAutoAssign,
    fixTimes, setFixTimes, previewFixTimes, runFixTimes,
  } = useScheduleTools({ toast, refresh })

  const dateStr = currentDate.toISOString().split('T')[0]

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
      <ScheduleToolbar
        viewMode={viewMode}
        onViewChange={setViewMode}
        showDateNav={!isGoogleOnly}
        currentDate={currentDate}
        onPrevWeek={prevWeek}
        onNextWeek={nextWeek}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(o => !o)}
        selectedPropertyType={selectedPropertyType}
        onPropertyTypeChange={setSelectedPropertyType}
        selectedStatus={selectedStatus}
        onStatusChange={setSelectedStatus}
        toolsOpen={toolsOpen}
        onToggleTools={() => setToolsOpen(o => !o)}
        onCloseTools={() => setToolsOpen(false)}
        gcalSyncing={gcalSyncing}
        gcalPushing={gcalPushing}
        onSyncFromGoogle={syncFromGoogle}
        onPushToGoogle={pushToGoogle}
        onPreviewAutoAssign={previewAutoAssign}
        onPreviewFixTimes={previewFixTimes}
        onNewJob={() => { setNewJobDate(dateStr); setShowNewJob(true) }}
      />

      <ScheduleHealthStrip stats={scheduleStats} />

      {/* Selection / bulk-action bar */}
      {!isGoogleOnly && (
        <ScheduleBulkBar
          visibleCount={currentlyVisibleVisits.length}
          allSelected={currentlyVisibleVisits.length > 0 && currentlyVisibleVisits.every(v => selectedVisitIds.has(v.id))}
          onSelectAllVisible={selectAllVisible}
          selectedCount={selectedVisitIds.size}
          onClear={clearVisitSelection}
          onBulkDelete={bulkDeleteVisits}
          bulkDeleting={bulkDeleting}
        />
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
      <ScheduleListView
        visitsByDate={visitsByDate}
        jobs={jobs}
        properties={properties}
        clients={clients}
        selectedVisitIds={selectedVisitIds}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onToggleSelect={toggleVisitSelect}
        empName={empName}
      />
      )}

      {/* Visit Details Drawer */}
      <VisitDetailsDrawer
        selectedVisit={showDetails ? selectedVisit : null}
        showMore={showVisitMore}
        onToggleMore={() => setShowVisitMore(v => !v)}
        jobEvents={jobEvents}
        empName={empName}
        onClose={() => setShowDetails(false)}
        onNavigateJob={(jobId) => navigate(`/jobs/${jobId}`)}
        onComplete={(v) => setCompletingVisit(v)}
        onEditJob={handleEditJob}
        onDelete={handleDelete}
        onToggleReminder={handleToggleReminder}
      />

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
      <AutoAssignModal
        state={autoAssign}
        onCancel={() => setAutoAssign(null)}
        onRun={runAutoAssign}
        empName={empName}
      />

      {/* Fix missing times — diagnose (shows source) then backfill */}
      <FixTimesModal
        state={fixTimes}
        onCancel={() => setFixTimes(null)}
        onRun={runFixTimes}
      />

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
